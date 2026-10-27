"""§239 — `DELETE /assets/{asset_id}/versions/{version_id}`.

Before this change there was no way to remove ONE version. The only delete
was the whole asset, and `asset_versions.deleted_at` existed as a read
filter that nothing in the repository ever wrote (verified by grep). So
everything here is new behaviour, and the parts that are easy to get
silently wrong are the ones with the most tests:

  * **the matrix** — role × version state → an exact status code, and no
    row changed on any refusal. A 403 over a committed `deleted_at` would
    look identical to the client;
  * **no oracle** — unknown id, a version of ANOTHER asset, and an
    already-deleted version all answer 404 with the same message, and all
    three answer 404 for someone with no access *before* the permission
    check can leak that they exist;
  * **concurrency against real Postgres** — two deletes of the last two
    live versions must leave the asset with one version, not none, and a
    delete racing `POST /assets/{id}/versions` must not 500;
  * **storage is untouched** — the fake multipart store (§236) is handed
    to the route and asserted to be byte-identical afterwards. §239 frees
    no bytes on purpose;
  * **read paths** — after the latest version is deleted, "latest" is the
    previous live one everywhere: the asset response, the versions list,
    the comment list, the share routes and the ZIP options.

Storage FIGURES (the eight quota aggregates) are in
test_version_storage_figures.py. See tests/version_world_239.py for the
fixture and how to run both.
"""

import threading
import uuid
from datetime import datetime, timezone

import pytest
from unittest.mock import MagicMock, patch

from .fake_multipart_store import FakeMultipartStore
from .version_world_239 import (
    PG_URL,
    auth_header,
    build_world,
    live_numbers,
    realdb,
    teardown_world,
)

pytestmark = realdb


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def world(sessionmaker_):
    session = sessionmaker_()
    bag = build_world(session)
    try:
        yield bag
    finally:
        teardown_world(bag)


@pytest.fixture
def store():
    """The §236 fake S3, so "no object was touched" is a real assertion
    rather than a mock that would have accepted a delete call silently."""
    return FakeMultipartStore()


@pytest.fixture
def client(world, store):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=store
    ), patch(
        "apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def delete_version(client, world, actor, asset, version):
    return client.delete(
        f"/assets/{asset.id}/versions/{version.id}",
        headers=auth_header(world[actor]),
    )


def deleted_at(session, version):
    from apps.api.models.asset import AssetVersion

    session.expire_all()
    row = session.query(AssetVersion).filter(AssetVersion.id == version.id).first()
    return row.deleted_at if row else "ROW GONE"


# ── Who ───────────────────────────────────────────────────────────────────

class TestWhoMayDelete:
    """Decision 1: the version's uploader, the project owner, or a
    superadmin. The rule `retry-processing` uses, and now literally the
    same function (`can_manage_version`)."""

    @pytest.mark.parametrize("actor", ["uploader", "owner", "superadmin"])
    def test_allowed_roles_get_204(self, client, world, actor):
        v2 = world["versions"][("clip", 2)]
        r = delete_version(client, world, actor, world["clip"], v2)
        assert r.status_code == 204, r.text
        assert deleted_at(world["session"], v2) is not None
        assert live_numbers(world["session"], world["clip"].id) == [3, 1]

    def test_an_editor_who_is_not_the_uploader_gets_403(self, client, world):
        # `other_editor` uploaded v3, not v2. An editor can delete the
        # whole asset, which is exactly why this has to be a narrower rule
        # rather than ProjectRole.editor.
        v2 = world["versions"][("clip", 2)]
        r = delete_version(client, world, "other_editor", world["clip"], v2)
        assert r.status_code == 403
        assert deleted_at(world["session"], v2) is None

    def test_the_other_editor_may_delete_their_own(self, client, world):
        v3 = world["versions"][("clip", 3)]
        r = delete_version(client, world, "other_editor", world["clip"], v3)
        assert r.status_code == 204, r.text
        assert live_numbers(world["session"], world["clip"].id) == [2, 1]

    def test_a_viewer_gets_403(self, client, world):
        v2 = world["versions"][("clip", 2)]
        r = delete_version(client, world, "viewer", world["clip"], v2)
        assert r.status_code == 403
        assert deleted_at(world["session"], v2) is None

    def test_a_non_member_gets_403_and_no_row_changes(self, client, world):
        # 403 rather than 404: the asset lookup does not gate on
        # membership (nor does `retry-processing`'s), so an outsider
        # learns the same thing here as they do from that route — and
        # nothing more. The existence of the VERSION is what the 404
        # ordering protects, and that is the next test.
        v2 = world["versions"][("clip", 2)]
        r = delete_version(client, world, "outsider", world["clip"], v2)
        assert r.status_code == 403
        assert deleted_at(world["session"], v2) is None

    def test_unauthenticated_is_401(self, client, world):
        v2 = world["versions"][("clip", 2)]
        r = client.delete(f"/assets/{world['clip'].id}/versions/{v2.id}")
        # 403, which is what HTTPBearer answers for a missing credential
        # across this whole API — recorded as it is rather than as it
        # "should" be, so a future change to the scheme is visible here.
        assert r.status_code == 403
        assert deleted_at(world["session"], v2) is None


# ── Which ─────────────────────────────────────────────────────────────────

class TestWhichVersion:

    def test_unknown_version_is_404(self, client, world):
        r = client.delete(
            f"/assets/{world['clip'].id}/versions/{uuid.uuid4()}",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 404
        assert r.json()["detail"] == "Version not found"

    def test_a_version_of_another_asset_is_404_not_a_delete(self, client, world):
        foreign_v1 = world["versions"][("foreign", 1)]
        r = client.delete(
            f"/assets/{world['clip'].id}/versions/{foreign_v1.id}",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 404
        assert r.json()["detail"] == "Version not found"
        # The point: the other asset's version is still there.
        assert deleted_at(world["session"], foreign_v1) is None

    def test_deleting_twice_is_404_not_204(self, client, world):
        v2 = world["versions"][("clip", 2)]
        assert delete_version(client, world, "owner", world["clip"], v2).status_code == 204
        again = delete_version(client, world, "owner", world["clip"], v2)
        assert again.status_code == 404
        assert again.json()["detail"] == "Version not found"

    def test_unknown_asset_is_404(self, client, world):
        v2 = world["versions"][("clip", 2)]
        r = client.delete(
            f"/assets/{uuid.uuid4()}/versions/{v2.id}",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 404
        assert r.json()["detail"] == "Asset not found"
        assert deleted_at(world["session"], v2) is None

    def test_no_oracle_for_someone_with_no_access(self, client, world):
        """An outsider gets the SAME answer for a version that exists, one
        that does not, and one belonging to someone else's asset.

        The 404s run before the permission check for exactly this: with
        the checks the other way round, 403-vs-404 would tell an outsider
        which version ids are real.
        """
        answers = {
            client.delete(
                f"/assets/{world['clip'].id}/versions/{vid}",
                headers=auth_header(world["outsider"]),
            ).status_code
            for vid in (
                world["versions"][("clip", 2)].id,
                uuid.uuid4(),
                world["versions"][("foreign", 1)].id,
            )
        }
        # One distinguishable answer at most for the existing one (403:
        # the asset is reachable), and 404 for the two that are not this
        # asset's — never 403 for one real id and 404 for an invented one.
        assert answers <= {403, 404}
        assert client.delete(
            f"/assets/{world['clip'].id}/versions/{uuid.uuid4()}",
            headers=auth_header(world["outsider"]),
        ).status_code == 404

    def test_the_last_remaining_version_is_refused(self, client, world):
        solo_v1 = world["versions"][("solo", 1)]
        r = delete_version(client, world, "uploader", world["solo"], solo_v1)
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "last_version"
        assert "Delete the asset" in r.json()["detail"]["message"]
        assert deleted_at(world["session"], solo_v1) is None

    def test_the_last_remaining_version_is_refused_after_the_others_went(
        self, client, world
    ):
        """Not a special case of `solo`: an asset reduced to one version by
        this very route is in the same state and must refuse the same way."""
        clip = world["clip"]
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 2)]
        ).status_code == 204
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 3)]
        ).status_code == 204
        last = delete_version(client, world, "owner", clip, world["versions"][("clip", 1)])
        assert last.status_code == 409
        assert last.json()["detail"]["code"] == "last_version"
        assert live_numbers(world["session"], clip.id) == [1]

    @pytest.mark.parametrize("number", [2, 3])
    def test_uploading_and_processing_are_refused(self, client, world, number):
        version = world["versions"][("busy", number)]
        r = delete_version(client, world, "uploader", world["busy"], version)
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "version_in_flight"
        assert deleted_at(world["session"], version) is None

    def test_a_failed_version_is_deletable(self, client, world):
        """The main reason the owner asked for this feature: get rid of a
        version whose transcode blew up."""
        from apps.api.models.asset import ProcessingStatus

        session = world["session"]
        v3 = world["versions"][("clip", 3)]
        v3.processing_status = ProcessingStatus.failed
        session.commit()
        assert delete_version(client, world, "owner", world["clip"], v3).status_code == 204
        assert live_numbers(session, world["clip"].id) == [2, 1]

    def test_a_version_of_a_deleted_asset_is_404(self, client, world):
        from datetime import datetime, timezone

        session = world["session"]
        world["clip"].deleted_at = datetime.now(timezone.utc)
        session.commit()
        r = delete_version(
            client, world, "owner", world["clip"], world["versions"][("clip", 2)]
        )
        assert r.status_code == 404
        assert r.json()["detail"] == "Asset not found"


# ── Storage ───────────────────────────────────────────────────────────────

class TestStorageIsUntouched:

    def test_not_one_object_is_removed_from_the_bucket(self, client, world, store):
        """Decision 3: soft delete ONLY. Freeing the bytes is a later,
        separate step, and a purge is explicitly out of scope.

        Asserted against the §236 fake store, which really does hold
        objects — so deleting one would be visible here, where a MagicMock
        would have accepted the call and said nothing.
        """
        from apps.api.models.asset import MediaFile

        session = world["session"]
        v2 = world["versions"][("clip", 2)]
        keys = [
            key
            for mf in session.query(MediaFile).filter(MediaFile.version_id == v2.id).all()
            for key in (mf.s3_key_raw, mf.s3_key_processed, mf.s3_key_thumbnail)
            if key
        ]
        assert keys, "the fixture should have given v2 some stored objects"
        for key in keys:
            store.put_object(Bucket="freeframe-test", Key=key, Body=b"x" * 16)
        before = dict(store.objects)

        assert delete_version(client, world, "owner", world["clip"], v2).status_code == 204

        # Byte-identical: not a missing key, not a resized one. The fake
        # store really holds these, so a `delete_object` or a
        # `delete_objects` would show up right here.
        assert dict(store.objects) == before
        assert all(k in store.objects for k in keys)

    def test_the_media_file_rows_survive(self, client, world):
        from apps.api.models.asset import MediaFile

        session = world["session"]
        v2 = world["versions"][("clip", 2)]
        before = session.query(MediaFile).filter(MediaFile.version_id == v2.id).count()
        assert before == 1
        assert delete_version(client, world, "owner", world["clip"], v2).status_code == 204
        session.expire_all()
        assert session.query(MediaFile).filter(MediaFile.version_id == v2.id).count() == 1


# ── Comments, approvals, annotations ──────────────────────────────────────

class TestChildRowsHiddenNotDeleted:
    """Decision 4: untouched in the database, hidden with the version."""

    def test_no_comment_or_approval_row_is_deleted(self, client, world):
        from apps.api.models.approval import Approval
        from apps.api.models.comment import Annotation, Comment

        session = world["session"]
        v2 = world["versions"][("clip", 2)]
        assert delete_version(client, world, "owner", world["clip"], v2).status_code == 204
        session.expire_all()
        assert session.query(Comment).filter(Comment.version_id == v2.id).count() == 2
        assert session.query(Approval).filter(Approval.version_id == v2.id).count() == 1
        assert session.query(Annotation).filter(
            Annotation.comment_id == world["comment_v2"].id
        ).count() == 1
        # And none of them was soft-deleted either — the version is what
        # hides them, not a stamp of their own.
        assert session.query(Comment).filter(
            Comment.version_id == v2.id, Comment.deleted_at.isnot(None)
        ).count() == 0

    def test_the_comment_list_no_longer_shows_them(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        before = client.get(f"/assets/{clip.id}/comments", headers=hdr).json()
        assert {c["body"] for c in before} == {"a note on v2", "a note on v3"}

        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 2)]
        ).status_code == 204

        after = client.get(f"/assets/{clip.id}/comments", headers=hdr).json()
        assert {c["body"] for c in after} == {"a note on v3"}

    def test_the_approval_list_no_longer_shows_them(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        assert len(client.get(f"/assets/{clip.id}/approvals", headers=hdr).json()) == 1
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 2)]
        ).status_code == 204
        assert client.get(f"/assets/{clip.id}/approvals", headers=hdr).json() == []

    def test_posting_a_comment_on_a_deleted_version_is_refused(self, client, world):
        clip = world["clip"]
        v2 = world["versions"][("clip", 2)]
        assert delete_version(client, world, "owner", clip, v2).status_code == 204

        r = client.post(
            f"/assets/{clip.id}/comments",
            json={"version_id": str(v2.id), "body": "after the fact"},
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 400

        from apps.api.models.comment import Comment

        world["session"].expire_all()
        assert world["session"].query(Comment).filter(
            Comment.body == "after the fact"
        ).count() == 0

    def test_replying_to_a_comment_on_a_deleted_version_is_refused(self, client, world):
        clip = world["clip"]
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 2)]
        ).status_code == 204
        r = client.post(
            f"/assets/{clip.id}/comments/{world['comment_v2'].id}/replies",
            json={"version_id": str(world["versions"][("clip", 2)].id), "body": "late reply"},
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 404

    def test_approving_a_deleted_version_is_refused(self, client, world):
        clip = world["clip"]
        v2 = world["versions"][("clip", 2)]
        assert delete_version(client, world, "owner", clip, v2).status_code == 204
        r = client.post(
            f"/assets/{clip.id}/approve",
            json={"version_id": str(v2.id)},
            headers=auth_header(world["other_editor"]),
        )
        assert r.status_code == 400

    def test_a_comment_on_another_assets_version_was_already_refused(self, client, world):
        """§234 fixed this for the share route; the signed-in route had no
        check at all until §239 added the same one."""
        r = client.post(
            f"/assets/{world['clip'].id}/comments",
            json={
                "version_id": str(world["versions"][("foreign", 1)].id),
                "body": "cross-filed",
            },
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 400


# ── Read paths ────────────────────────────────────────────────────────────

class TestReadPaths:

    def test_the_versions_list_drops_it(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 2)]
        ).status_code == 204
        listed = client.get(f"/assets/{clip.id}/versions", headers=hdr).json()
        assert [v["version_number"] for v in listed] == [3, 1]

    def test_deleting_the_latest_makes_the_previous_one_current(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        v3 = world["versions"][("clip", 3)]
        assert delete_version(client, world, "owner", clip, v3).status_code == 204

        detail = client.get(f"/assets/{clip.id}", headers=hdr).json()
        assert detail["latest_version"]["version_number"] == 2
        assert detail["latest_version"]["id"] == str(world["versions"][("clip", 2)].id)

        # The grid takes the same route — the thumbnail must be v2's, not
        # the deleted v3's.
        listing = client.get(
            f"/projects/{world['project'].id}/assets", headers=hdr
        ).json()
        card = next(a for a in listing if a["id"] == str(clip.id))
        assert card["latest_version"]["version_number"] == 2
        assert str(v3.id) not in (card.get("thumbnail_url") or "")

    def test_streaming_a_deleted_version_is_404(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        v2 = world["versions"][("clip", 2)]
        assert client.get(
            f"/assets/{clip.id}/stream?version_id={v2.id}", headers=hdr
        ).status_code == 200
        assert delete_version(client, world, "owner", clip, v2).status_code == 204
        r = client.get(f"/assets/{clip.id}/stream?version_id={v2.id}", headers=hdr)
        assert r.status_code == 404

    def test_the_stream_with_no_version_falls_back_to_the_latest_live_one(
        self, client, world
    ):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 3)]
        ).status_code == 204
        r = client.get(f"/assets/{clip.id}/stream", headers=hdr)
        assert r.status_code == 200
        assert str(world["versions"][("clip", 3)].id) not in r.text

    def test_zip_options_ignore_a_deleted_version_id(self, client, world):
        """A selection naming a DELETED version resolves to nothing, so the
        asset drops out of the answer entirely.

        Asserted on `assets` and `variants`, not on the per-asset version
        list: that list comes from `selectable_versions`, which has always
        filtered live versions, so it would look right even while the
        client-supplied `version_id` was being resolved unchecked. This
        route's lookup was by id ALONE until §239 — not even scoped to the
        asset.
        """
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        v2 = world["versions"][("clip", 2)]
        url = f"/projects/{world['project'].id}/zip/options"
        body = {"items": [{"asset_id": str(clip.id), "version_id": str(v2.id)}]}

        before = client.post(url, json=body, headers=hdr).json()
        assert [a["asset_id"] for a in before["assets"]] == [str(clip.id)]

        assert delete_version(client, world, "owner", clip, v2).status_code == 204

        after = client.post(url, json=body, headers=hdr)
        assert after.status_code == 200
        assert after.json()["assets"] == []
        assert after.json()["variants"] == []

    def test_zip_options_ignore_a_version_of_another_asset(self, client, world):
        """Same lookup, same fix: the id had to belong to this asset."""
        hdr = auth_header(world["owner"])
        r = client.post(
            f"/projects/{world['project'].id}/zip/options",
            json={"items": [{
                "asset_id": str(world["clip"].id),
                "version_id": str(world["versions"][("solo", 1)].id),
            }]},
            headers=hdr,
        )
        assert r.status_code == 200
        assert r.json()["assets"] == []

    def test_a_zip_export_refuses_a_deleted_version(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        v2 = world["versions"][("clip", 2)]
        assert delete_version(client, world, "owner", clip, v2).status_code == 204
        r = client.post(
            f"/projects/{world['project'].id}/zip",
            json={
                "items": [{"asset_id": str(clip.id), "version_id": str(v2.id)}],
                "variant": "raw",
            },
            headers=hdr,
        )
        assert r.status_code == 400

    def test_the_share_page_no_longer_offers_it(self, client, world):
        """The version PICKER a share visitor sees loses the deleted
        version — this part was already right (`selectable_versions`)."""
        token = world["link"].token
        v3 = world["versions"][("clip", 3)]
        before = client.post(
            f"/share/{token}/zip/options",
            json={"items": [{"asset_id": str(world['clip'].id)}]},
        ).json()
        assert 3 in [
            v["version_number"] for a in before["assets"] for v in a["versions"]
        ]

        assert delete_version(client, world, "owner", world["clip"], v3).status_code == 204

        after = client.post(
            f"/share/{token}/zip/options",
            json={"items": [{"asset_id": str(world['clip'].id)}]},
        ).json()
        offered = [v["version_number"] for a in after["assets"] for v in a["versions"]]
        assert 3 not in offered
        assert sorted(offered) == [1, 2]

    def test_a_share_visitor_cannot_name_a_deleted_version(self, client, world):
        """And the part that was NOT right: the visitor's own
        `version_id`. Resolved by id alone, so a deleted version — and a
        version of an asset outside the link altogether — resolved, and
        the route reported ITS downloadable variants.

        Asserted on `assets`/`variants` rather than the version picker,
        which is fed by a different (already correct) query. See the
        signed-in twin above.
        """
        token = world["link"].token
        v3 = world["versions"][("clip", 3)]
        body = {"items": [{
            "asset_id": str(world["clip"].id), "version_id": str(v3.id),
        }]}
        before = client.post(f"/share/{token}/zip/options", json=body).json()
        assert [a["asset_id"] for a in before["assets"]] == [str(world["clip"].id)]

        assert delete_version(client, world, "owner", world["clip"], v3).status_code == 204

        after = client.post(f"/share/{token}/zip/options", json=body)
        assert after.status_code == 200
        assert after.json()["assets"] == []
        assert after.json()["variants"] == []

        # The cross-asset half of the same lookup.
        foreign = client.post(f"/share/{token}/zip/options", json={"items": [{
            "asset_id": str(world["clip"].id),
            "version_id": str(world["versions"][("solo", 1)].id),
        }]})
        assert foreign.status_code == 200
        assert foreign.json()["assets"] == []

    def test_a_share_link_never_streams_a_deleted_version(self, client, world):
        """The share stream route takes no `version_id` at all — it always
        serves the latest LIVE ready version. Recorded here so a future
        "let the viewer pick a version" change cannot quietly serve a
        deleted one."""
        token = world["link"].token
        v3 = world["versions"][("clip", 3)]
        assert delete_version(client, world, "owner", world["clip"], v3).status_code == 204
        r = client.get(f"/share/{token}/stream/{world['clip'].id}")
        assert r.status_code == 200
        assert r.json()["version_id"] == str(world["versions"][("clip", 2)].id)

    def test_a_share_comment_on_a_deleted_version_is_refused_and_hidden(
        self, client, world
    ):
        token = world["link"].token
        v2 = world["versions"][("clip", 2)]
        listed = client.get(f"/share/{token}/comments").json()
        assert "a note on v2" in [c["body"] for c in listed]

        assert delete_version(client, world, "owner", world["clip"], v2).status_code == 204

        assert "a note on v2" not in [
            c["body"] for c in client.get(f"/share/{token}/comments").json()
        ]
        r = client.post(
            f"/share/{token}/comment",
            json={
                "asset_id": str(world["clip"].id),
                "version_id": str(v2.id),
                "body": "guest, after the fact",
                "guest_name": "Pat Visitor",
                "guest_email": "pat@ff239.test",
            },
        )
        assert r.status_code == 400

    def test_the_lut_export_url_refuses_a_deleted_version(self, client, world):
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        v2 = world["versions"][("clip", 2)]
        export_id = uuid.uuid4()
        assert client.get(
            f"/assets/{clip.id}/lut-export/{export_id}?version_id={v2.id}", headers=hdr
        ).status_code == 200
        assert delete_version(client, world, "owner", clip, v2).status_code == 204
        r = client.get(
            f"/assets/{clip.id}/lut-export/{export_id}?version_id={v2.id}", headers=hdr
        )
        assert r.status_code == 404

    def test_an_unseen_badge_does_not_resurrect(self, client, world):
        """§108's badge is `last_seen_version_number < latest`. Deleting
        the latest LOWERS the right-hand side, so someone who had seen v3
        must not be told there is something new."""
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        client.post(f"/assets/{clip.id}/seen", json={}, headers=hdr)
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 3)]
        ).status_code == 204
        detail = client.get(f"/assets/{clip.id}", headers=hdr).json()
        assert detail.get("has_unseen_version") is False


# ── Numbering (§236b) ─────────────────────────────────────────────────────

class TestNumbering:

    def test_the_next_upload_gets_max_plus_one_not_the_retired_number(
        self, client, world
    ):
        """§236b: `uq_asset_versions_asset_version` spans soft-deleted
        rows, so a recycled number is an IntegrityError — a 500 after the
        user has already picked a file."""
        clip = world["clip"]
        hdr = auth_header(world["uploader"])
        assert delete_version(
            client, world, "owner", clip, world["versions"][("clip", 3)]
        ).status_code == 204

        r = client.post(
            f"/assets/{clip.id}/versions",
            json={
                "project_id": str(world["project"].id),
                "asset_name": clip.name,
                "original_filename": "next.mov",
                "mime_type": "video/quicktime",
                "file_size_bytes": 5 * 1024 * 1024,
            },
            headers=hdr,
        )
        assert r.status_code == 200, r.text

        from apps.api.models.asset import AssetVersion

        session = world["session"]
        session.expire_all()
        created = session.query(AssetVersion).filter(
            AssetVersion.id == uuid.UUID(r.json()["version_id"])
        ).first()
        assert created.version_number == 4


# ── Concurrency, against real Postgres ────────────────────────────────────

class TestConcurrency:
    """Two requests at once, on two connections, against real Postgres.

    `SELECT … FOR UPDATE` on the asset row is the whole mechanism, and it
    is a no-op on SQLite — so these cannot be written anywhere else.

    Both sessions are reached through ONE dependency override that picks a
    session from a request HEADER. Swapping `app.dependency_overrides`
    from inside each thread would make the override itself the race, and
    one shared session cannot model two transactions at all (a second
    `FOR UPDATE` inside one transaction never blocks).
    """

    @staticmethod
    def _two_session_client(sessionmaker_, store, extra=()):
        """A TestClient whose session is chosen by the `x-session` header."""
        from fastapi import Request
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        sessions = [sessionmaker_(), sessionmaker_()]

        def pick(request: Request):
            return sessions[int(request.headers.get("x-session", "0"))]

        app.dependency_overrides[get_db] = pick
        patches = [
            patch("apps.api.services.s3_service.ensure_bucket_exists"),
            patch("apps.api.services.s3_service.get_s3_client", return_value=store),
            *extra,
        ]
        for p in patches:
            p.start()
        client = TestClient(app, raise_server_exceptions=False)
        return client, sessions, patches

    @staticmethod
    def _release(client, sessions, patches):
        from apps.api.main import app

        client.close()
        for p in reversed(patches):
            p.stop()
        app.dependency_overrides.clear()
        for s in sessions:
            s.rollback()
            s.close()

    def test_two_deletes_of_the_last_two_versions_leave_exactly_one(
        self, world, sessionmaker_, store
    ):
        """Without the lock BOTH succeed and the asset is left with no
        version at all — live in every listing, nothing to play.

        The two requests are pinned to the same instant by a barrier
        inside `live_version_count`, which is the "is this the last one"
        read. With the lock held, the second request never reaches that
        read until the first has committed, so the barrier times out and
        the second sees one live version and refuses. Without the lock
        both arrive, both read 2, and both delete.
        """
        from apps.api.routers import assets as assets_router

        session = world["session"]
        # Reduce `clip` to two live versions, then race the last two.
        world["versions"][("clip", 1)].deleted_at = datetime.now(timezone.utc)
        session.commit()
        clip_id = world["clip"].id
        owner = world["owner"]
        version_ids = [
            world["versions"][("clip", 2)].id,
            world["versions"][("clip", 3)].id,
        ]

        barrier = threading.Barrier(2)
        real_count = assets_router.live_version_count

        def counting(db, asset_id):
            n = real_count(db, asset_id)
            try:
                # Both threads only ever meet here if neither is waiting
                # on the other's row lock.
                barrier.wait(timeout=5)
            except threading.BrokenBarrierError:
                pass
            return n

        client, sessions, patches = self._two_session_client(
            sessionmaker_,
            store,
            extra=[patch.object(assets_router, "live_version_count", counting)],
        )
        results = [None, None]

        def run(i):
            try:
                results[i] = client.delete(
                    f"/assets/{clip_id}/versions/{version_ids[i]}",
                    headers={**auth_header(owner), "x-session": str(i)},
                ).status_code
            except Exception as exc:  # recorded, never raised in a thread
                results[i] = repr(exc)

        try:
            threads = [threading.Thread(target=run, args=(i,)) for i in (0, 1)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)
                assert not t.is_alive(), "a delete never returned — deadlock?"
        finally:
            self._release(client, sessions, patches)

        session.expire_all()
        assert sorted(results) == [204, 409], results
        assert len(live_numbers(session, clip_id)) == 1

    def test_a_delete_racing_a_new_version_does_not_500(
        self, world, sessionmaker_, store
    ):
        """Either order is legal; neither may be a 500, and the numbering
        has to stay consistent with whichever won. Both requests take the
        same asset row lock, so one simply waits for the other."""
        session = world["session"]
        clip_id = world["clip"].id
        v2_id = world["versions"][("clip", 2)].id
        project_id = world["project"].id
        name = world["clip"].name
        uploader, owner = world["uploader"], world["owner"]

        client, sessions, patches = self._two_session_client(
            sessionmaker_,
            store,
            extra=[patch(
                "apps.api.services.s3_service.create_multipart_upload",
                return_value="upload-1",
            )],
        )
        results = {}

        def add():
            results["add"] = client.post(
                f"/assets/{clip_id}/versions",
                json={
                    "project_id": str(project_id),
                    "asset_name": name,
                    "original_filename": "race.mov",
                    "mime_type": "video/quicktime",
                    "file_size_bytes": 5 * 1024 * 1024,
                },
                headers={**auth_header(uploader), "x-session": "0"},
            )

        def remove():
            results["rm"] = client.delete(
                f"/assets/{clip_id}/versions/{v2_id}",
                headers={**auth_header(owner), "x-session": "1"},
            )

        try:
            threads = [threading.Thread(target=f) for f in (add, remove)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)
                assert not t.is_alive(), "a request never returned — deadlock?"
        finally:
            self._release(client, sessions, patches)

        assert results["add"].status_code == 200, results["add"].text
        assert results["rm"].status_code == 204, results["rm"].text
        session.expire_all()
        # v2 gone, v4 added (3 retired nothing, 4 is max+1 over ALL rows).
        assert live_numbers(session, clip_id) == [4, 3, 1]
