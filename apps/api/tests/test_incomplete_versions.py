"""§238 — an upload that never finished is not a processing failure.

What the owner saw: he started a new-version upload on an existing file,
interrupted it, and the file grew a `v6` that reads **Failed** with
"Processing failed … Restart processing". Restart could never work —
there is no object to process — and the next upload became v7, because
§239/§236b retire a deleted version's number on purpose.

So the server now says WHICH stage failed, and the two stages behave
differently:

  * `failure_stage == "upload"` — the row is the empty shell
    `/upload/initiate` writes before any bytes move. Retry is refused with
    a stable `upload_incomplete`; a delete (or a cancel) HARD-deletes the
    row and its media row so the NUMBER IS FREE AGAIN.
  * `failure_stage == "processing"` — exactly §239's behaviour, unchanged:
    Restart works, the delete is soft, the number stays retired.

── Why these tests need real Postgres and the fake store ────────────────
Three things here do not exist against SQLite or a mocked session:

  * `uq_asset_versions_asset_version` spanning soft-deleted rows, which is
    the whole difference between "the number is free" and "the number is
    retired" (§236b);
  * `SELECT … FOR UPDATE` on the asset row, which is what makes a cancel
    and a concurrent new version agree on the numbering (`with_for_update`
    is silently a no-op on SQLite);
  * the five foreign keys to `asset_versions`, which decide whether a hard
    delete is possible at all.

Storage is `tests/fake_multipart_store.FakeMultipartStore` (§236), patched
in at `get_s3_client` so the REAL `services/s3_service.py` runs on top of
it — including `list_multipart_uploads`' two-marker paginator, which §238
uses to find the upload id of an abandoned upload (nothing stores it).

    docker run -d --name ff238-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55438:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55438/freeframe \\
      pytest apps/api/tests/test_incomplete_versions.py

What these tests therefore CANNOT show, and the §238 report says so
plainly: a real AIStor `ListMultipartUploads`, a real HEAD against a
100 GB object, and anything a browser does.

The cast is §239's (tests/version_world_239.py) — the same six roles and
the same four files, so the permission matrix for the new delete path is
compared against the old one row for row rather than re-invented.
"""

import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import patch

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

MIB = 1024 * 1024
#: One part, and it is the last part, so the 5 MiB floor does not apply.
DECLARED = 5 * MIB


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
    return FakeMultipartStore()


@pytest.fixture
def client(world, store):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=store
    ), patch(
        "apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)
    ), patch(
        # The transcode dispatch itself is not what any of this is about,
        # and a TestClient RUNS background tasks — so without this a
        # completion here would try to reach a broker.
        "apps.api.tasks.celery_app.send_task_safe"
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


# ── the calls, as the two clients make them ───────────────────────────────


def initiate_version(client, world, actor, asset, *, size=DECLARED,
                     filename="next.mov"):
    """`POST /assets/{id}/versions` — the web app's "upload a new version".

    Through the real endpoint rather than by inserting rows, because the
    shape of what it leaves behind IS the subject: a version at
    `uploading`, a media row whose only key is `s3_key_raw`, no
    `upload_completed_at`, and an open multipart upload at the store.
    """
    r = client.post(
        f"/assets/{asset.id}/versions",
        json={
            "project_id": str(world["project"].id),
            "asset_name": asset.name,
            "original_filename": filename,
            "mime_type": "video/quicktime",
            "file_size_bytes": size,
        },
        headers=auth_header(world[actor]),
    )
    assert r.status_code == 200, r.text
    return r.json()


def initiate_first_upload(client, world, actor, *, size=DECLARED):
    """`POST /upload/initiate` — a brand-new asset's first upload."""
    r = client.post(
        "/upload/initiate",
        json={
            "project_id": str(world["project"].id),
            "asset_name": f"fresh-{uuid.uuid4().hex[:6]}.mov",
            "original_filename": "fresh.mov",
            "mime_type": "video/quicktime",
            "file_size_bytes": size,
        },
        headers=auth_header(world[actor]),
    )
    assert r.status_code == 200, r.text
    return r.json()


def abort(client, world, actor, init):
    return client.post(
        "/upload/abort",
        json={
            "s3_key": init["s3_key"],
            "upload_id": init["upload_id"],
            "version_id": init["version_id"],
        },
        headers=auth_header(world[actor]),
    )


def complete(client, world, actor, init, store, *, size=DECLARED):
    """Finish the upload: the store holds the one part, so /complete
    assembles it from the STORE's list (§236) and transitions the row."""
    store.seed_upload(init["s3_key"], init["upload_id"], {1: size})
    return client.post(
        "/upload/complete",
        json={
            "s3_key": init["s3_key"],
            "upload_id": init["upload_id"],
            "asset_id": init["asset_id"],
            "version_id": init["version_id"],
            "parts": [],
        },
        headers=auth_header(world[actor]),
    )


def delete_version(client, world, actor, asset, version_id):
    return client.delete(
        f"/assets/{asset.id}/versions/{version_id}",
        headers=auth_header(world[actor]),
    )


def retry(client, world, actor, asset, version_id):
    return client.post(
        f"/assets/{asset.id}/versions/{version_id}/retry-processing",
        json={},
        headers=auth_header(world[actor]),
    )


# ── reading the database back ─────────────────────────────────────────────


def row(session, version_id):
    from apps.api.models.asset import AssetVersion

    session.expire_all()
    return (
        session.query(AssetVersion)
        .filter(AssetVersion.id == uuid.UUID(str(version_id)))
        .first()
    )


def media_rows(session, version_id):
    from apps.api.models.asset import MediaFile

    session.expire_all()
    return (
        session.query(MediaFile)
        .filter(MediaFile.version_id == uuid.UUID(str(version_id)))
        .all()
    )


def fail(session, version_id, *, completed=None):
    """Put a version at `failed`, the way the sweeper or the transcoder
    would. `completed` is what distinguishes the two stages."""
    from apps.api.models.asset import ProcessingStatus

    v = row(session, version_id)
    v.processing_status = ProcessingStatus.failed
    v.upload_completed_at = completed
    session.commit()
    return v


def numbers(session, asset):
    return live_numbers(session, asset.id)


# ── A. the column ─────────────────────────────────────────────────────────


class TestCompleteRecordsThatTheUploadFinished:
    """`upload_completed_at` is written in the transaction that moves the
    version to `processing`, and nowhere else. It is the only thing that
    tells the two kinds of `failed` apart."""

    def test_an_upload_in_progress_has_no_completion_recorded(
        self, client, world, store
    ):
        init = initiate_version(client, world, "uploader", world["clip"])
        assert row(world["session"], init["version_id"]).upload_completed_at is None

    def test_completing_stamps_it(self, client, world, store):
        from apps.api.models.asset import ProcessingStatus

        before = datetime.now(timezone.utc) - timedelta(seconds=5)
        init = initiate_version(client, world, "uploader", world["clip"])

        assert complete(client, world, "uploader", init, store).status_code == 200

        v = row(world["session"], init["version_id"])
        assert v.processing_status == ProcessingStatus.processing
        assert v.upload_completed_at is not None
        assert v.upload_completed_at >= before
        # §219's queued marker is still cleared — this is a dispatch, not a
        # start, and the two columns mean different things.
        assert v.processing_started_at is None

    def test_an_idempotent_second_complete_keeps_the_first_timestamp(
        self, client, world, store
    ):
        """The desktop client retries /complete indefinitely by design
        (§236). The retry must not restamp the column: that would make the
        upload look like it finished at retry time."""
        init = initiate_version(client, world, "uploader", world["clip"])
        assert complete(client, world, "uploader", init, store).status_code == 200
        first = row(world["session"], init["version_id"]).upload_completed_at

        again = complete(client, world, "uploader", init, store)

        assert again.status_code == 200
        assert row(world["session"], init["version_id"]).upload_completed_at == first

    def test_a_completion_that_only_happened_at_the_store_is_stamped_too(
        self, client, world, store
    ):
        """§236's recovery path: `CompleteMultipartUpload` succeeded and the
        commit was lost, so the row still says `uploading` while the object
        sits at the key. The client's retry finishes the database side — and
        that is a completion, so it is recorded like one."""
        init = initiate_version(client, world, "uploader", world["clip"])
        # The upload id is consumed at the store (that is what
        # CompleteMultipartUpload does) and the assembled object is there,
        # while the row still says `uploading`.
        store.abort_multipart_upload(Key=init["s3_key"], UploadId=init["upload_id"])
        store.objects[init["s3_key"]] = DECLARED

        r = client.post(
            "/upload/complete",
            json={
                "s3_key": init["s3_key"],
                "upload_id": init["upload_id"],
                "asset_id": init["asset_id"],
                "version_id": init["version_id"],
                "parts": [],
            },
            headers=auth_header(world["uploader"]),
        )

        assert r.status_code == 200, r.text
        assert row(world["session"], init["version_id"]).upload_completed_at is not None


class TestFailureStageTruthTable:
    """What `GET /assets/{id}/versions` says, per state. The web renders
    two completely different panels off this one field, so every state has
    to answer explicitly — including the three that are not failures."""

    def _stages(self, client, world, asset):
        r = client.get(
            f"/assets/{asset.id}/versions", headers=auth_header(world["owner"])
        )
        assert r.status_code == 200, r.text
        return {v["version_number"]: v["failure_stage"] for v in r.json()}

    def test_ready_uploading_and_processing_have_no_stage(self, client, world):
        # busy: v1 ready, v2 uploading, v3 processing.
        assert self._stages(client, world, world["busy"]) == {1: None, 2: None, 3: None}

    def test_failed_with_no_completion_is_the_upload_stage(self, client, world):
        fail(world["session"], world["versions"][("busy", 1)].id, completed=None)
        assert self._stages(client, world, world["busy"])[1] == "upload"

    def test_failed_with_a_completion_is_the_processing_stage(self, client, world):
        fail(
            world["session"],
            world["versions"][("busy", 1)].id,
            completed=datetime.now(timezone.utc),
        )
        assert self._stages(client, world, world["busy"])[1] == "processing"

    def test_the_field_is_not_processing_started_at_in_disguise(self, client, world):
        """The mutation this exists to kill. `processing_started_at` is NULL
        for a real processing failure too — tasks/transcode_tasks.py fails a
        version at two points before it stamps that column, and
        /upload/complete clears it to NULL on every dispatch (§219). A
        `failure_stage` derived from it would call this row's failure an
        upload failure."""
        v = fail(
            world["session"],
            world["versions"][("busy", 1)].id,
            completed=datetime.now(timezone.utc),
        )
        assert v.processing_started_at is None
        assert self._stages(client, world, world["busy"])[1] == "processing"


# ── B1. retry ─────────────────────────────────────────────────────────────


class TestRetryProcessing:

    def test_an_incomplete_upload_is_refused_with_a_stable_code(
        self, client, world, store
    ):
        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)

        r = retry(client, world, "uploader", world["clip"], init["version_id"])

        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "upload_incomplete"
        assert isinstance(r.json()["detail"]["message"], str)
        assert r.json()["detail"]["message"]

    def test_the_refusal_changes_nothing(self, client, world, store):
        from apps.api.models.asset import ProcessingStatus

        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)

        retry(client, world, "uploader", world["clip"], init["version_id"])

        v = row(world["session"], init["version_id"])
        assert v.processing_status == ProcessingStatus.failed
        assert v.upload_completed_at is None

    def test_a_real_processing_failure_still_restarts(self, client, world):
        from apps.api.models.asset import ProcessingStatus

        v3 = world["versions"][("clip", 3)]
        fail(world["session"], v3.id, completed=datetime.now(timezone.utc))

        r = retry(client, world, "other_editor", world["clip"], v3.id)

        assert r.status_code == 200, r.text
        assert r.json()["processing_status"] == "processing"
        assert row(world["session"], v3.id).processing_status == ProcessingStatus.processing

    def test_a_restart_keeps_the_completion_it_already_had(self, client, world):
        v3 = world["versions"][("clip", 3)]
        stamped = datetime.now(timezone.utc) - timedelta(hours=3)
        fail(world["session"], v3.id, completed=stamped)

        assert retry(client, world, "owner", world["clip"], v3.id).status_code == 200

        # Not restamped: the upload finished when it finished, and a row
        # whose completion time drifted forward on every retry would stop
        # being evidence of anything.
        assert row(world["session"], v3.id).upload_completed_at == stamped

    def test_a_processing_row_with_no_recorded_completion_gets_one(
        self, client, world
    ):
        """A row this route is allowed to retry has, by definition, a
        finished upload behind it. If nothing recorded that (a row from
        before the column existed), the retry records it — otherwise a
        LATER failure of the same version would read as "never uploaded"
        and be offered a Delete instead of a Restart."""
        from apps.api.models.asset import ProcessingStatus

        v3 = world["versions"][("clip", 3)]
        v = row(world["session"], v3.id)
        v.processing_status = ProcessingStatus.processing
        v.processing_started_at = datetime.now(timezone.utc) - timedelta(hours=2)
        v.upload_completed_at = None
        # Older than STUCK_PROCESSING_THRESHOLD_SECONDS, or the route
        # refuses with "still within the normal processing window" — the
        # guard against dispatching a second transcode over a running one.
        v.created_at = datetime.now(timezone.utc) - timedelta(hours=3)
        world["session"].commit()

        assert retry(client, world, "owner", world["clip"], v3.id).status_code == 200

        assert row(world["session"], v3.id).upload_completed_at is not None


# ── B2. deleting the shell ────────────────────────────────────────────────


class TestDeletingAnIncompleteVersion:
    """The owner's rule, in his words: "if a failed version is deleted and
    it was not a full upload, the next upload must NOT increase the version
    number"."""

    def test_the_row_is_gone_not_soft_deleted(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)

        r = delete_version(client, world, "uploader", world["clip"], init["version_id"])

        assert r.status_code == 204, r.text
        assert row(world["session"], init["version_id"]) is None
        assert media_rows(world["session"], init["version_id"]) == []

    def test_the_number_is_free_again(self, client, world, store):
        clip = world["clip"]
        assert numbers(world["session"], clip) == [3, 2, 1]

        init = initiate_version(client, world, "uploader", clip)
        assert row(world["session"], init["version_id"]).version_number == 4
        fail(world["session"], init["version_id"], completed=None)
        assert delete_version(
            client, world, "uploader", clip, init["version_id"]
        ).status_code == 204

        again = initiate_version(client, world, "uploader", clip)

        # 4 again, not 5. A soft delete would have retired it (§236b).
        assert row(world["session"], again["version_id"]).version_number == 4

    def test_a_gap_below_the_highest_number_stays_a_gap(self, client, world, store):
        """Only the highest number comes back, and that is fine: numbering
        is `max + 1` over every row there has ever been, so removing a shell
        under a higher version leaves its number unused. Nothing renumbers
        anything."""
        clip = world["clip"]
        shell = initiate_version(client, world, "uploader", clip)        # v4
        higher = initiate_version(client, world, "uploader", clip)       # v5
        assert row(world["session"], higher["version_id"]).version_number == 5
        fail(world["session"], shell["version_id"], completed=None)

        assert delete_version(
            client, world, "uploader", clip, shell["version_id"]
        ).status_code == 204

        nxt = initiate_version(client, world, "uploader", clip)
        assert row(world["session"], nxt["version_id"]).version_number == 6

    def test_the_leftover_multipart_upload_is_aborted(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])
        store.seed_upload(init["s3_key"], init["upload_id"], {1: MIB})
        assert store.open_uploads()
        fail(world["session"], init["version_id"], completed=None)

        delete_version(client, world, "uploader", world["clip"], init["version_id"])

        # Found by listing the store under the key — the upload id is not
        # stored anywhere, exactly as §215's sweeper has to do it.
        assert store.open_uploads() == []
        assert store.count("abort_multipart_upload") >= 1

    def test_an_object_at_the_key_refuses_the_hard_delete(self, client, world, store):
        """The guard. An object there means the upload DID complete at the
        store and only the commit was lost (§215 calls this "needs a
        person") — so this is not an empty shell, and nothing is deleted."""
        from apps.api.models.asset import ProcessingStatus

        init = initiate_version(client, world, "uploader", world["clip"])
        store.objects[init["s3_key"]] = DECLARED
        fail(world["session"], init["version_id"], completed=None)

        r = delete_version(client, world, "uploader", world["clip"], init["version_id"])

        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "version_has_object"
        v = row(world["session"], init["version_id"])
        assert v is not None
        assert v.deleted_at is None
        assert v.processing_status == ProcessingStatus.failed
        assert store.objects[init["s3_key"]] == DECLARED

    def test_a_store_that_cannot_be_asked_deletes_nothing(self, client, world, store):
        from botocore.exceptions import EndpointConnectionError

        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)

        with patch(
            "apps.api.services.s3_service.object_exists",
            side_effect=EndpointConnectionError(endpoint_url="http://s3.invalid"),
        ):
            r = delete_version(
                client, world, "uploader", world["clip"], init["version_id"]
            )

        assert r.status_code == 502
        assert r.json()["detail"]["code"] == "storage_unavailable"
        assert row(world["session"], init["version_id"]) is not None

    def test_a_comment_on_it_makes_it_a_soft_delete_instead(
        self, client, world, store
    ):
        """Nothing can comment on a version that was never playable — the
        comment routes refuse a version that is not live and there is
        nothing to play — so this is the belt-and-braces path, and what it
        must NOT do is raise a ForeignKeyViolation (`comments.version_id`
        is NO ACTION). It falls back to §239's soft delete."""
        from apps.api.models.comment import Comment

        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)
        session = world["session"]
        session.add(Comment(
            asset_id=world["clip"].id,
            version_id=uuid.UUID(init["version_id"]),
            author_id=world["uploader"].id,
            author_name=world["uploader"].name,
            body="planted by hand, see the docstring",
        ))
        session.commit()

        r = delete_version(client, world, "uploader", world["clip"], init["version_id"])

        assert r.status_code == 204, r.text
        v = row(session, init["version_id"])
        assert v is not None and v.deleted_at is not None
        # And the number stays retired, which is the honest answer for a row
        # somebody has written against.
        again = initiate_version(client, world, "uploader", world["clip"])
        assert row(session, again["version_id"]).version_number == v.version_number + 1

    def test_the_unseen_badge_does_not_point_past_the_end(
        self, client, world, store
    ):
        """`asset_views.last_seen_version_id` is ON DELETE SET NULL, so the
        delete succeeds either way — but `last_seen_version_number` is a
        plain integer the badge compares against. Left at the shell's
        number it would suppress the badge for the NEXT upload, which gets
        that same number back."""
        from apps.api.models.activity import AssetView

        clip = world["clip"]
        init = initiate_version(client, world, "uploader", clip)   # v4
        # Opening the asset records the highest LIVE version, which is the
        # shell while it exists.
        seen = client.post(
            f"/assets/{clip.id}/seen", headers=auth_header(world["viewer"])
        )
        assert seen.status_code == 204, seen.text
        session = world["session"]
        session.expire_all()
        view = (
            session.query(AssetView)
            .filter(AssetView.user_id == world["viewer"].id,
                    AssetView.asset_id == clip.id)
            .first()
        )
        assert view.last_seen_version_number == 4

        fail(session, init["version_id"], completed=None)
        assert delete_version(
            client, world, "owner", clip, init["version_id"]
        ).status_code == 204

        session.expire_all()
        view = (
            session.query(AssetView)
            .filter(AssetView.user_id == world["viewer"].id,
                    AssetView.asset_id == clip.id)
            .first()
        )
        assert view.last_seen_version_id is None
        assert view.last_seen_version_number == 3

    def test_a_processing_failure_is_still_soft_with_its_number_retired(
        self, client, world, store
    ):
        """§239, unchanged. Everything about this case has to keep working
        exactly as it did: the row stays, its comments stay, the bytes stay
        in the bucket, and "v3" keeps meaning v3."""
        clip = world["clip"]
        v3 = world["versions"][("clip", 3)]
        fail(world["session"], v3.id, completed=datetime.now(timezone.utc))

        assert delete_version(client, world, "owner", clip, v3.id).status_code == 204

        v = row(world["session"], v3.id)
        assert v is not None and v.deleted_at is not None
        assert media_rows(world["session"], v3.id)      # its media row survives
        assert numbers(world["session"], clip) == [2, 1]

        nxt = initiate_version(client, world, "uploader", clip)
        assert row(world["session"], nxt["version_id"]).version_number == 4

    def test_the_only_version_is_still_refused(self, client, world, store):
        """An incomplete FIRST upload is the one case that is not a version
        of anything: the asset has nothing else. §239 refuses to leave an
        asset with no version at all (`usable_asset_filter` would still
        list it, unplayable), and the answer the client acts on is the same
        as before — delete the asset instead."""
        init = initiate_first_upload(client, world, "uploader")
        fail(world["session"], init["version_id"], completed=None)

        from apps.api.models.asset import Asset

        asset = (
            world["session"].query(Asset)
            .filter(Asset.id == uuid.UUID(init["asset_id"]))
            .first()
        )
        r = delete_version(client, world, "uploader", asset, init["version_id"])

        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "last_version"
        assert row(world["session"], init["version_id"]) is not None


class TestWhoMayDeleteAnIncompleteVersion:
    """The §239 matrix, row for row: the version's uploader, the project
    owner, or a superadmin. A hard delete must not be reachable by anyone a
    soft delete was not."""

    @pytest.fixture
    def shell(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])
        fail(world["session"], init["version_id"], completed=None)
        return init

    @pytest.mark.parametrize("actor", ["uploader", "owner", "superadmin"])
    def test_allowed(self, client, world, shell, actor):
        r = delete_version(client, world, actor, world["clip"], shell["version_id"])
        assert r.status_code == 204, r.text
        assert row(world["session"], shell["version_id"]) is None

    @pytest.mark.parametrize("actor", ["other_editor", "viewer", "outsider"])
    def test_refused_and_the_row_survives(self, client, world, shell, actor):
        r = delete_version(client, world, actor, world["clip"], shell["version_id"])
        assert r.status_code == 403, r.text
        assert row(world["session"], shell["version_id"]) is not None

    def test_unauthenticated_is_401(self, client, world, shell):
        r = client.delete(
            f"/assets/{world['clip'].id}/versions/{shell['version_id']}"
        )
        assert r.status_code in (401, 403)
        assert row(world["session"], shell["version_id"]) is not None


# ── B3. cancelling ────────────────────────────────────────────────────────


class TestCancellingANewVersionUpload:
    """What the user actually does: click Cancel in the uploads panel, or
    discard an interrupted upload. `/upload/abort` is the one endpoint both
    of those reach."""

    def test_it_leaves_no_version_row_at_all(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])
        store.seed_upload(init["s3_key"], init["upload_id"], {1: MIB})

        r = abort(client, world, "uploader", init)

        assert r.status_code == 204, r.text
        assert row(world["session"], init["version_id"]) is None
        assert media_rows(world["session"], init["version_id"]) == []
        assert numbers(world["session"], world["clip"]) == [3, 2, 1]

    def test_the_next_upload_reuses_the_number(self, client, world, store):
        clip = world["clip"]
        init = initiate_version(client, world, "uploader", clip)
        assert row(world["session"], init["version_id"]).version_number == 4

        assert abort(client, world, "uploader", init).status_code == 204

        again = initiate_version(client, world, "uploader", clip)
        assert row(world["session"], again["version_id"]).version_number == 4

    def test_the_parts_are_freed_at_the_store(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])
        store.seed_upload(init["s3_key"], init["upload_id"], {1: MIB, 2: MIB})

        abort(client, world, "uploader", init)

        assert store.open_uploads() == []

    def test_a_first_upload_keeps_todays_behaviour(self, client, world, store):
        """The deliberate asymmetry (§236 unchanged). A first upload's asset
        was created BY that upload, so the client deletes the asset — and
        that is the only thing that removes the asset row. Removing the lone
        version here would leave a version-less asset listed with nothing to
        play."""
        from apps.api.models.asset import ProcessingStatus

        init = initiate_first_upload(client, world, "uploader")

        assert abort(client, world, "uploader", init).status_code == 204

        v = row(world["session"], init["version_id"])
        assert v is not None
        assert v.processing_status == ProcessingStatus.failed
        assert v.deleted_at is None

    def test_an_object_at_the_key_falls_back_to_failed(self, client, world, store):
        """A cancel that arrives after the upload in fact completed at the
        store. Hard-deleting the row would orphan a real object, so the row
        is marked `failed` as before and the cancel still answers 204 — the
        user cancelled, and §215's sweeper and the version list both know
        what to do with a `failed` row."""
        from apps.api.models.asset import ProcessingStatus

        init = initiate_version(client, world, "uploader", world["clip"])
        store.objects[init["s3_key"]] = DECLARED

        r = abort(client, world, "uploader", init)

        assert r.status_code == 204, r.text
        v = row(world["session"], init["version_id"])
        assert v is not None
        assert v.processing_status == ProcessingStatus.failed

    def test_a_second_cancel_is_still_an_idempotent_204(self, client, world, store):
        """§236's rule, which outlives the row: the first cancel removed it,
        so the second is a cancel of something that is no longer there. The
        answer a client gets must not depend on which of its retries won."""
        init = initiate_version(client, world, "uploader", world["clip"])
        assert abort(client, world, "uploader", init).status_code == 204

        second = abort(client, world, "uploader", init)

        # 404, not 500: the version is gone, which is the same answer §236
        # gives for any version id that does not exist. The web treats both
        # as "there is nothing left to cancel" (it swallows the failure).
        assert second.status_code == 404

    def test_a_finished_version_is_still_a_409(self, client, world, store):
        """Not abortable, and nothing is touched — the §236 rule that keeps
        a cancel from destroying a good version."""
        init = initiate_version(client, world, "uploader", world["clip"])
        assert complete(client, world, "uploader", init, store).status_code == 200

        r = abort(client, world, "uploader", init)

        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "upload_not_abortable"
        assert row(world["session"], init["version_id"]) is not None

    def test_another_users_cancel_is_refused(self, client, world, store):
        init = initiate_version(client, world, "uploader", world["clip"])

        r = abort(client, world, "other_editor", init)

        assert r.status_code == 403
        assert row(world["session"], init["version_id"]) is not None


# ── B6. nothing about "latest" changes ────────────────────────────────────


class TestTheLatestVersionIsUnaffected:
    """An incomplete failed version was already not what the app shows, and
    §238 must not change that in either direction."""

    def test_the_review_page_still_opens_on_the_newest_ready_version(
        self, client, world, store
    ):
        """The default selection is the highest `ready` version
        (components/review/review-provider.tsx), so the shell is not it —
        before or after the shell exists."""
        clip = world["clip"]
        init = initiate_version(client, world, "uploader", clip)
        fail(world["session"], init["version_id"], completed=None)

        r = client.get(
            f"/assets/{clip.id}/versions", headers=auth_header(world["owner"])
        )
        listed = r.json()
        ready = [v for v in listed if v["processing_status"] == "ready"]
        assert max(v["version_number"] for v in ready) == 3
        # The shell IS listed, with the stage that tells the switcher to
        # show "Upload incomplete" rather than a red "Failed".
        shell = [v for v in listed if v["id"] == init["version_id"]][0]
        assert shell["failure_stage"] == "upload"

    def test_the_grid_and_the_asset_status_are_what_they_were(
        self, client, world, store
    ):
        """Pinned rather than improved. `latest_version` is the highest LIVE
        version whatever its status, and the thumbnail comes from that
        version's files — so while an incomplete version is the highest, the
        card has no thumbnail. That is pre-existing (§238 touches no
        "latest" computation), and removing the shell restores it, which is
        the half that matters here."""
        clip = world["clip"]
        hdr = auth_header(world["owner"])
        before = client.get(f"/assets/{clip.id}", headers=hdr).json()
        assert before["latest_version"]["version_number"] == 3
        assert before["thumbnail_url"]

        init = initiate_version(client, world, "uploader", clip)
        fail(world["session"], init["version_id"], completed=None)
        during = client.get(f"/assets/{clip.id}", headers=hdr).json()
        assert during["latest_version"]["version_number"] == 4
        assert during["latest_version"]["failure_stage"] == "upload"
        assert during["thumbnail_url"] is None

        assert delete_version(
            client, world, "owner", clip, init["version_id"]
        ).status_code == 204

        after = client.get(f"/assets/{clip.id}", headers=hdr).json()
        assert after["latest_version"]["version_number"] == 3
        assert after["thumbnail_url"] == before["thumbnail_url"]

    def test_the_asset_is_still_listed_in_its_project(self, client, world, store):
        clip = world["clip"]
        init = initiate_version(client, world, "uploader", clip)
        fail(world["session"], init["version_id"], completed=None)

        r = client.get(
            f"/projects/{world['project'].id}/assets",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 200, r.text
        assert str(clip.id) in [a["id"] for a in r.json()]


# ── the migration's backfill ──────────────────────────────────────────────


class TestTheBackfill:
    """The migration's data step, run against real rows in each class.

    The SQL itself is executed — not a Python re-implementation of it —
    through a real Alembic operations context on this session's connection,
    so what is tested is the statement that will run on production.
    """

    def _rows(self, world):
        """Five versions on one throwaway asset, one per class.

        `upload_completed_at` is NULL on all five to start with, which is
        the state production is in before the migration's UPDATE.
        """
        from apps.api.models.asset import (
            Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
        )

        session = world["session"]
        asset = Asset(
            project_id=world["project"].id,
            name=f"backfill-{uuid.uuid4().hex[:6]}.mov",
            asset_type=AssetType.video,
            created_by=world["owner"].id,
        )
        session.add(asset)
        session.commit()

        plan = [
            # (number, status, processing_started_at, size_verified_at)
            (1, ProcessingStatus.ready, None, None),         # by status
            (2, ProcessingStatus.processing, None, None),    # by status
            (3, ProcessingStatus.failed,
             datetime.now(timezone.utc) - timedelta(hours=1), None),  # by started
            (4, ProcessingStatus.failed, None,
             datetime.now(timezone.utc) - timedelta(hours=2)),        # by §180
            (5, ProcessingStatus.failed, None, None),        # no proof: stays NULL
            (6, ProcessingStatus.uploading, None, None),     # in flight: stays NULL
        ]
        made = {}
        for number, status, started, verified in plan:
            v = AssetVersion(
                asset_id=asset.id, version_number=number,
                processing_status=status, processing_started_at=started,
                upload_completed_at=None, created_by=world["owner"].id,
            )
            session.add(v)
            session.commit()
            session.add(MediaFile(
                version_id=v.id, file_type=FileType.video,
                original_filename=f"v{number}.mov", mime_type="video/quicktime",
                file_size_bytes=1024, size_verified_at=verified,
                s3_key_raw=f"raw/backfill/{asset.id}/{v.id}/original.mov",
            ))
            session.commit()
            made[number] = v
        return asset, made

    def _run_backfill(self, session):
        import importlib

        from alembic.migration import MigrationContext
        from alembic.operations import Operations

        module = importlib.import_module(
            "apps.api.alembic.versions.add_version_upload_completed_at"
        )
        ctx = MigrationContext.configure(session.connection())
        with Operations.context(ctx):
            module._backfill()

    def test_each_class_is_stamped_or_left_null(self, world):
        session = world["session"]
        _asset, made = self._rows(world)

        self._run_backfill(session)
        session.expire_all()

        stamped = {n: made[n].upload_completed_at for n in made}
        # Stamped: the status says so, a worker started it, or §180's
        # reconcile verified its size at completion.
        assert stamped[1] is not None
        assert stamped[2] is not None
        assert stamped[3] is not None
        assert stamped[4] is not None
        # Left NULL: a failure with no evidence of a completed upload, and
        # an upload still in flight. NULL is the safe direction — it makes
        # the app offer Delete rather than Restart, and the hard delete
        # still asks the store before touching anything.
        assert stamped[5] is None
        assert stamped[6] is None

    def test_the_value_is_the_rows_own_history_not_now(self, world):
        session = world["session"]
        _asset, made = self._rows(world)
        started = made[3].processing_started_at

        self._run_backfill(session)
        session.expire_all()

        # COALESCE(processing_started_at, updated_at) — never `now()`.
        assert made[3].upload_completed_at == started
        assert made[4].upload_completed_at == made[4].updated_at

    def test_running_it_twice_changes_nothing(self, world):
        session = world["session"]
        _asset, made = self._rows(world)

        self._run_backfill(session)
        session.expire_all()
        first = {n: made[n].upload_completed_at for n in made}

        self._run_backfill(session)
        session.expire_all()

        assert {n: made[n].upload_completed_at for n in made} == first


# ── concurrency, against real Postgres ───────────────────────────────────


class TestConcurrency:
    """The number this frees is the number another request is about to
    read, so the hard delete takes the asset row lock §236/§236b/§239 all
    take, in the same order. `with_for_update` is a no-op on SQLite, so
    this cannot be written anywhere else.
    """

    @staticmethod
    def _two_session_client(sessionmaker_, store):
        """A TestClient whose session is chosen by the `x-session` header —
        §239's helper, for the same reason: swapping
        `app.dependency_overrides` inside each thread would make the
        override itself the race, and one shared session cannot model two
        transactions at all."""
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
            patch("apps.api.middleware.rate_limit.check_rate_limit",
                  return_value=(True, 0)),
            patch("apps.api.tasks.celery_app.send_task_safe"),
        ]
        for p in patches:
            p.start()
        return TestClient(app, raise_server_exceptions=False), sessions, patches

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

    def test_a_hard_delete_racing_a_new_version_keeps_the_numbers_consistent(
        self, client, world, store, sessionmaker_
    ):
        """Either order is legal. What may not happen is a 500 (an
        IntegrityError on `uq_asset_versions_asset_version`) or two live
        versions wearing the same number."""
        clip = world["clip"]
        shell = initiate_version(client, world, "uploader", clip)   # v4
        fail(world["session"], shell["version_id"], completed=None)
        session = world["session"]
        project_id, name = world["project"].id, clip.name
        uploader, owner = world["uploader"], world["owner"]

        racer, sessions, patches = self._two_session_client(sessionmaker_, store)
        results = {}

        def add():
            results["add"] = racer.post(
                f"/assets/{clip.id}/versions",
                json={
                    "project_id": str(project_id),
                    "asset_name": name,
                    "original_filename": "race.mov",
                    "mime_type": "video/quicktime",
                    "file_size_bytes": DECLARED,
                },
                headers={**auth_header(uploader), "x-session": "0"},
            )

        def remove():
            results["rm"] = racer.delete(
                f"/assets/{clip.id}/versions/{shell['version_id']}",
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
            self._release(racer, sessions, patches)

        assert results["add"].status_code == 200, results["add"].text
        assert results["rm"].status_code == 204, results["rm"].text
        session.expire_all()
        live = numbers(session, clip)
        assert len(live) == len(set(live)), live
        # Whoever ran first, the shell is gone and the new version is the
        # highest number: 4 if the delete landed first and freed it, 5 if
        # the initiate read the shell's 4 and took the next one.
        assert live in ([4, 3, 2, 1], [5, 3, 2, 1]), live

    def test_two_cancels_of_the_same_upload_remove_one_row_and_do_not_500(
        self, client, world, store, sessionmaker_
    ):
        clip = world["clip"]
        shell = initiate_version(client, world, "uploader", clip)
        uploader = world["uploader"]

        racer, sessions, patches = self._two_session_client(sessionmaker_, store)
        codes = [None, None]

        def run(i):
            codes[i] = racer.post(
                "/upload/abort",
                json={
                    "s3_key": shell["s3_key"],
                    "upload_id": shell["upload_id"],
                    "version_id": shell["version_id"],
                },
                headers={**auth_header(uploader), "x-session": str(i)},
            ).status_code

        try:
            threads = [threading.Thread(target=run, args=(i,)) for i in (0, 1)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)
                assert not t.is_alive(), "a cancel never returned — deadlock?"
        finally:
            self._release(racer, sessions, patches)

        # One of them did the work; the other found nothing left to cancel.
        # Neither is a 500.
        assert sorted(codes) == [204, 404], codes
        world["session"].expire_all()
        assert row(world["session"], shell["version_id"]) is None
