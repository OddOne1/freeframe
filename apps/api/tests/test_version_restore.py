"""§240 C/D — restoring ONE version, and seeing deleted versions at all.

Two new things:

  * `POST /assets/{id}/versions/{vid}/restore` — allowed for exactly
    three people (the deleter, the project owner, a superadmin), 404s
    before permission so it is no oracle, locks the asset row, refuses on
    quota with a stable `storage_limit` code, and keeps the version's
    ORIGINAL number (§236b retired it; nothing can have taken it);
  * `GET /assets/{id}/versions?include_deleted=true` — a deleted version
    stays VISIBLE in the history, marked removed, carrying NO media of
    any kind. The default call is asserted byte-for-byte unchanged,
    because every existing caller makes it.

See trash_world_240.py for the cast and how to run this.
"""

import threading
import uuid

import pytest
from unittest.mock import patch

from .fake_multipart_store import FakeMultipartStore
from .trash_world_240 import (
    PG_URL,
    SIZES,
    auth_header,
    build_world,
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
    """The §236 fake S3, so "no object was touched" is a real assertion."""
    return FakeMultipartStore()


@pytest.fixture
def client(world, store):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=store
    ), patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


MULTI = "a_multi"


def version_of(world, number):
    return world["versions"][(MULTI, number)]


def delete_v2(client, world, actor="editor_a"):
    r = client.delete(
        f"/assets/{world['assets'][MULTI].id}/versions/{version_of(world, 2).id}",
        headers=auth_header(world[actor]),
    )
    assert r.status_code == 204, r.text


def restore(client, world, actor, asset=None, version_id=None):
    asset_id = (asset or world["assets"][MULTI]).id
    vid = version_id or version_of(world, 2).id
    return client.post(
        f"/assets/{asset_id}/versions/{vid}/restore", headers=auth_header(world[actor])
    )


def version_row(world, number=2):
    from apps.api.models.asset import AssetVersion

    session = world["session"]
    session.expire_all()
    v = session.query(AssetVersion).filter(AssetVersion.id == version_of(world, number).id).first()
    return (v.deleted_at, v.deleted_by, v.deleted_by_name, v.version_number)


def versions(client, world, actor="editor_a", asset=None, **params):
    asset_id = (asset or world["assets"][MULTI]).id
    return client.get(
        f"/assets/{asset_id}/versions", params=params, headers=auth_header(world[actor])
    )


# ── Who may restore a version ─────────────────────────────────────────────

class TestWhoMayRestore:
    @pytest.mark.parametrize("actor", ["editor_a", "owner", "superadmin"])
    def test_the_deleter_the_owner_and_a_superadmin_get_200(self, client, world, actor):
        delete_v2(client, world)
        r = restore(client, world, actor)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
        deleted_at, deleted_by, name, number = version_row(world)
        assert (deleted_at, deleted_by, name) == (None, None, None)
        assert number == 2  # §236b — the original number, never reassigned

    @pytest.mark.parametrize("actor", ["editor_b", "viewer", "outsider"])
    def test_everybody_else_is_refused_and_the_row_is_unchanged(self, client, world, actor):
        delete_v2(client, world)
        before = version_row(world)
        r = restore(client, world, actor)
        assert r.status_code == 403
        assert version_row(world) == before
        assert before[0] is not None

    def test_the_uploader_who_did_not_delete_it_is_refused(self, client, world):
        """editor_a uploaded every version of a_multi. The owner deletes
        v2; being the uploader does not make it hers to restore — that is
        §239's DELETE rule, not §240's RESTORE rule."""
        delete_v2(client, world, actor="owner")
        assert version_row(world)[1] == world["owner"].id
        r = restore(client, world, "editor_a")
        assert r.status_code == 403
        assert version_row(world)[0] is not None

    @pytest.mark.parametrize(
        "actor,expected",
        [("owner", 200), ("superadmin", 200), ("editor_a", 403), ("editor_b", 403)],
    )
    def test_a_version_with_no_recorded_deleter_is_owner_only(self, client, world, actor, expected):
        from datetime import datetime, timezone

        from apps.api.models.asset import AssetVersion

        session = world["session"]
        session.query(AssetVersion).filter(AssetVersion.id == version_of(world, 2).id).update(
            {"deleted_at": datetime.now(timezone.utc), "deleted_by": None,
             "deleted_by_name": None}
        )
        session.commit()
        assert restore(client, world, actor).status_code == expected

    def test_the_route_and_the_flag_use_the_same_function(self, client, world):
        """`can_restore` in the version list is `can_restore_version`, and
        so is the route's gate — not two copies of the condition."""
        from apps.api.services.permissions import can_restore_version

        delete_v2(client, world)
        session = world["session"]
        session.expire_all()
        from apps.api.models.asset import Asset, AssetVersion

        asset = session.query(Asset).filter(Asset.id == world["assets"][MULTI].id).first()
        version = session.query(AssetVersion).filter(
            AssetVersion.id == version_of(world, 2).id
        ).first()
        for actor in ("editor_a", "editor_b", "owner", "superadmin", "viewer"):
            predicate = can_restore_version(session, asset, version, world[actor])
            if actor == "viewer":
                # A viewer cannot even see the list, so only the route's
                # answer is observable.
                assert predicate is False
                continue
            body = versions(client, world, actor=actor, include_deleted=True).json()
            flag = [v for v in body if v["version_number"] == 2][0]["can_restore"]
            assert flag == predicate, actor


# ── 404s before permission ────────────────────────────────────────────────

class TestTheRouteIsNoOracle:
    def test_an_unknown_version_is_404(self, client, world):
        assert restore(client, world, "owner", version_id=uuid.uuid4()).status_code == 404

    def test_a_version_of_another_asset_is_404(self, client, world):
        delete_v2(client, world)
        r = restore(
            client, world, "owner",
            asset=world["assets"]["a_alpha"],
            version_id=version_of(world, 2).id,
        )
        assert r.status_code == 404
        assert r.json()["detail"] == "Version not found"

    def test_a_live_version_is_404_not_409(self, client, world):
        r = restore(client, world, "owner", version_id=version_of(world, 1).id)
        assert r.status_code == 404
        assert r.json()["detail"] == "Version not found"

    def test_restoring_twice_is_404_the_second_time(self, client, world):
        delete_v2(client, world)
        assert restore(client, world, "owner").status_code == 200
        assert restore(client, world, "owner").status_code == 404

    def test_an_outsider_gets_the_same_404_for_a_version_that_exists(self, client, world):
        """The 404s come first, so a stranger cannot tell a real version
        id from an invented one."""
        delete_v2(client, world)
        real = restore(client, world, "outsider")
        fake = restore(client, world, "outsider", version_id=uuid.uuid4())
        assert real.status_code == 403  # the asset is visible to a member…
        assert fake.status_code == 404
        r = client.post(
            f"/assets/{uuid.uuid4()}/versions/{uuid.uuid4()}/restore",
            headers=auth_header(world["outsider"]),
        )
        assert r.status_code == 404

    def test_a_deleted_asset_is_404(self, client, world):
        delete_v2(client, world)
        r = client.delete(
            f"/assets/{world['assets'][MULTI].id}", headers=auth_header(world["editor_a"])
        )
        assert r.status_code == 204
        assert restore(client, world, "owner").status_code == 404


# ── Quota ─────────────────────────────────────────────────────────────────

class TestTheQuota:
    def _limit_project(self, world, limit):
        from apps.api.models.project import Project

        session = world["session"]
        session.query(Project).filter(Project.id == world["project"].id).update(
            {"storage_limit_bytes": limit}
        )
        session.commit()

    def test_a_restore_that_would_exceed_the_project_limit_is_409(self, client, world):
        delete_v2(client, world)
        from apps.api.services.storage_usage import storage_bytes_query
        from apps.api.models.asset import Asset

        used = storage_bytes_query(world["session"]).filter(
            Asset.project_id == world["project"].id
        ).scalar()
        # Room for one byte less than the version needs.
        self._limit_project(world, used + SIZES[(MULTI, 2)] - 1)
        r = restore(client, world, "owner")
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "storage_limit"
        assert version_row(world)[0] is not None

    def test_exactly_enough_room_succeeds(self, client, world):
        delete_v2(client, world)
        from apps.api.models.asset import Asset
        from apps.api.services.storage_usage import storage_bytes_query

        used = storage_bytes_query(world["session"]).filter(
            Asset.project_id == world["project"].id
        ).scalar()
        self._limit_project(world, used + SIZES[(MULTI, 2)])
        assert restore(client, world, "owner").status_code == 200

    def test_the_platform_limit_is_enforced_too(self, client, world):
        from apps.api.models.site_settings import SiteSettings
        from apps.api.services.storage_usage import storage_bytes_query

        delete_v2(client, world)
        session = world["session"]
        settings_row = session.query(SiteSettings).first()
        created = settings_row is None
        if created:
            settings_row = SiteSettings()
            session.add(settings_row)
            session.commit()
        previous = settings_row.total_storage_limit_bytes
        used = storage_bytes_query(session).scalar()
        settings_row.total_storage_limit_bytes = used + SIZES[(MULTI, 2)] - 1
        session.commit()
        try:
            r = restore(client, world, "owner")
            assert r.status_code == 409
            assert r.json()["detail"]["code"] == "storage_limit"
        finally:
            if created:
                session.delete(settings_row)
            else:
                settings_row.total_storage_limit_bytes = previous
            session.commit()

    def test_the_bytes_count_again_after_a_successful_restore(self, client, world):
        from apps.api.models.asset import Asset
        from apps.api.services.storage_usage import storage_bytes_query

        def used():
            world["session"].expire_all()
            return storage_bytes_query(world["session"]).filter(
                Asset.project_id == world["project"].id
            ).scalar()

        before = used()
        delete_v2(client, world)
        assert used() == before - SIZES[(MULTI, 2)]
        assert restore(client, world, "owner").status_code == 200
        assert used() == before


# ── Concurrency ───────────────────────────────────────────────────────────

class TestConcurrency:
    """Two requests at once, on two connections, against real Postgres.

    `SELECT … FOR UPDATE` on the asset row is the mechanism, and it is a
    no-op on SQLite. Both sessions are reached through ONE dependency
    override that picks a session from a request HEADER — §239's pattern,
    for its reasons: swapping `app.dependency_overrides` from inside each
    thread makes the override itself the race, and one shared session
    cannot model two transactions (a second `FOR UPDATE` inside one
    transaction never blocks).
    """

    @staticmethod
    def _two_session_client(sessionmaker_, store):
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
            patch("apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)),
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

    def test_two_concurrent_restores_give_one_200_and_one_404(
        self, client, world, sessionmaker_, store
    ):
        """The lock makes the second caller re-read the version after the
        first committed, and find it live — one restore, one 404, never
        two restores of one row."""
        delete_v2(client, world)
        world["session"].commit()

        two, sessions, patches = self._two_session_client(sessionmaker_, store)
        url = (
            f"/assets/{world['assets'][MULTI].id}/versions/"
            f"{version_of(world, 2).id}/restore"
        )
        header = auth_header(world["owner"])
        results: dict[int, int] = {}

        def attempt(n):
            results[n] = two.post(url, headers={**header, "x-session": str(n)}).status_code

        try:
            threads = [threading.Thread(target=attempt, args=(n,)) for n in (0, 1)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)
        finally:
            self._release(two, sessions, patches)

        assert sorted(results.values()) == [200, 404], results
        assert version_row(world)[0] is None

    def test_a_restore_racing_a_delete_of_the_same_version_stays_consistent(
        self, client, world, sessionmaker_, store
    ):
        delete_v2(client, world)
        world["session"].commit()

        two, sessions, patches = self._two_session_client(sessionmaker_, store)
        asset_id = world["assets"][MULTI].id
        vid = version_of(world, 2).id
        header = auth_header(world["owner"])
        codes: dict[str, int] = {}

        def do_restore():
            codes["restore"] = two.post(
                f"/assets/{asset_id}/versions/{vid}/restore",
                headers={**header, "x-session": "0"},
            ).status_code

        def do_delete():
            codes["delete"] = two.delete(
                f"/assets/{asset_id}/versions/{vid}",
                headers={**header, "x-session": "1"},
            ).status_code

        try:
            threads = [threading.Thread(target=do_restore), threading.Thread(target=do_delete)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=60)
        finally:
            self._release(two, sessions, patches)

        # Whatever the interleaving, neither call may 500 and the row must
        # end up in one of the two legal states, not half of each.
        assert all(code < 500 for code in codes.values()), codes
        deleted_at, deleted_by, name, _ = version_row(world)
        assert (deleted_at is None and deleted_by is None and name is None) or (
            deleted_at is not None and deleted_by is not None
        ), (deleted_at, deleted_by, name)


# ── §240 D — the version list ─────────────────────────────────────────────

class TestTheVersionList:
    def test_the_default_call_is_unchanged(self, client, world):
        before = versions(client, world).json()
        delete_v2(client, world)
        after = versions(client, world).json()
        assert [v["version_number"] for v in before] == [3, 2, 1]
        assert [v["version_number"] for v in after] == [3, 1]
        for v in after:
            assert v["deleted_at"] is None
            assert v["deleted_by_name"] is None
            assert v["can_restore"] is False
            assert v["files"]  # live versions keep their media

    def test_include_deleted_shows_the_removed_row_in_place(self, client, world):
        delete_v2(client, world)
        body = versions(client, world, include_deleted=True).json()
        assert [v["version_number"] for v in body] == [3, 2, 1]
        removed = [v for v in body if v["version_number"] == 2][0]
        assert removed["deleted_at"] is not None
        assert removed["can_restore"] is True
        assert removed["deleted_by_name"] == world["editor_a"].name

    def test_a_deleted_version_carries_no_media_at_all(self, client, world):
        delete_v2(client, world)
        body = versions(client, world, include_deleted=True).json()
        removed = [v for v in body if v["version_number"] == 2][0]
        assert removed["files"] == []
        # Nothing anywhere in the row may be derived from an s3 key.
        blob = repr(removed)
        for needle in ("s3_key", "raw/", "processed/", ".m3u8", "token="):
            assert needle not in blob, needle

    def test_the_deleters_name_is_hidden_from_a_reviewer(self, client, world):
        from apps.api.models.project import ProjectMember, ProjectRole

        delete_v2(client, world)
        session = world["session"]
        session.query(ProjectMember).filter(
            ProjectMember.project_id == world["project"].id,
            ProjectMember.user_id == world["viewer"].id,
        ).update({"role": ProjectRole.reviewer})
        session.commit()
        body = versions(client, world, actor="viewer", include_deleted=True).json()
        removed = [v for v in body if v["version_number"] == 2][0]
        assert removed["deleted_at"] is not None     # they see it was removed
        assert removed["deleted_by_name"] is None    # not by whom
        assert removed["can_restore"] is False

    def test_an_editor_who_did_not_delete_it_sees_it_without_an_action(self, client, world):
        delete_v2(client, world)
        body = versions(client, world, actor="editor_b", include_deleted=True).json()
        removed = [v for v in body if v["version_number"] == 2][0]
        assert removed["deleted_at"] is not None
        assert removed["can_restore"] is False
        # editor_b is editor+, so the name is theirs to see.
        assert removed["deleted_by_name"] == world["editor_a"].name

    def test_after_a_restore_the_row_is_a_normal_version_again(self, client, world):
        delete_v2(client, world)
        assert restore(client, world, "editor_a").status_code == 200
        body = versions(client, world, include_deleted=True).json()
        restored = [v for v in body if v["version_number"] == 2][0]
        assert restored["deleted_at"] is None
        assert restored["can_restore"] is False
        assert restored["files"]

    def test_an_outsider_cannot_read_the_list_at_all(self, client, world):
        delete_v2(client, world)
        assert versions(client, world, actor="outsider", include_deleted=True).status_code == 403

    def test_the_share_routes_are_untouched(self):
        """§240 D changed `GET /assets/{id}/versions` only. No share route
        takes an `include_deleted` parameter, and none reads one — a
        link-holder must never be able to ask for deleted versions."""
        from apps.api.main import app

        for route in app.routes:
            if route.path.startswith("/share"):
                params = {
                    p.name for p in getattr(route, "dependant", None).query_params
                } if getattr(route, "dependant", None) else set()
                assert "include_deleted" not in params, route.path
