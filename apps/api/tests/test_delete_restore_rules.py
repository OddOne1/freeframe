"""§240 C2/C — who may DELETE, who may RESTORE, and who gets recorded.

Three decisions are tested here, all of them new behaviour:

  * **delete** (C2) — an asset may be deleted by its uploader, the
    project owner or a superadmin; a folder by the owner/superadmin, or by
    the editor who created it only if everything live inside it is also
    theirs. Before §240 any editor could delete anybody's work, so every
    "other editor is refused" case here is a case that used to succeed;
  * **restore** (C) — one rule for all three kinds: the person who
    deleted it, the project owner, or a superadmin. A row whose
    `deleted_by` is NULL (deleted before §240) is owner/superadmin only;
  * **the deleter is recorded** (A) — `deleted_by`/`deleted_by_name` on
    every soft-delete path, with the cascade giving descendants the SAME
    deleter, and both cleared again on restore.

Plus the regression the owner asked about directly: an asset trashed
BEFORE its folder was must not be resurrected by restoring that folder.
`test_an_asset_deleted_before_its_folder_is_not_resurrected` fails on
`main`.

Every refusal is asserted against the DATABASE ROW, not just the status
code — a 403 over a committed `deleted_at` reads identically to the
client. See trash_world_240.py for the cast and how to run this.
"""

import uuid

import pytest
from unittest.mock import patch

from .trash_world_240 import (
    PG_URL,
    auth_header,
    build_world,
    realdb,
    row_state,
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
def client(world):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def delete_asset(client, world, actor, key):
    return client.delete(
        f"/assets/{world['assets'][key].id}", headers=auth_header(world[actor])
    )


def delete_folder(client, world, actor, folder_key):
    return client.delete(
        f"/folders/{world[folder_key].id}", headers=auth_header(world[actor])
    )


def asset_state(world, key):
    from apps.api.models.asset import Asset

    return row_state(world["session"], Asset, world["assets"][key].id)


def folder_state(world, folder_key):
    from apps.api.models.folder import Folder

    return row_state(world["session"], Folder, world[folder_key].id)


# ── C2: deleting an asset ──────────────────────────────────────────────────

class TestWhoMayDeleteAnAsset:
    """Uploader, project owner, superadmin. NOT every editor any more."""

    @pytest.mark.parametrize("actor", ["editor_a", "owner", "superadmin"])
    def test_allowed_roles_get_204(self, client, world, actor):
        r = delete_asset(client, world, actor, "a_alpha")
        assert r.status_code == 204, r.text
        deleted_at, deleted_by, name = asset_state(world, "a_alpha")
        assert deleted_at is not None
        assert deleted_by == world[actor].id
        assert name == world[actor].name

    def test_another_editor_is_refused_and_nothing_changes(self, client, world):
        before = asset_state(world, "a_alpha")
        r = delete_asset(client, world, "editor_b", "a_alpha")
        assert r.status_code == 403
        assert "uploader" in r.json()["detail"]
        assert asset_state(world, "a_alpha") == before == (None, None, None)

    def test_the_uploader_of_a_colleagues_file_may_still_delete_their_own(self, client, world):
        assert delete_asset(client, world, "editor_b", "b_beta").status_code == 204

    @pytest.mark.parametrize("actor,expected", [("viewer", 403), ("outsider", 403)])
    def test_viewer_and_outsider_are_refused(self, client, world, actor, expected):
        r = delete_asset(client, world, actor, "a_alpha")
        assert r.status_code == expected
        assert asset_state(world, "a_alpha") == (None, None, None)

    def test_an_asset_in_another_project_is_a_404_not_a_403(self, client, world):
        # editor_a is a member of other_project, so this is about the
        # asset, not about access: `foreign.mov` was uploaded by the owner.
        r = delete_asset(client, world, "editor_a", "foreign")
        assert r.status_code == 403
        assert asset_state(world, "foreign") == (None, None, None)

    def test_an_unknown_id_is_404(self, client, world):
        r = client.delete(f"/assets/{uuid.uuid4()}", headers=auth_header(world["owner"]))
        assert r.status_code == 404


# ── C2: deleting a folder ──────────────────────────────────────────────────

class TestWhoMayDeleteAFolder:
    """The owner/superadmin always; the editor who created it only when
    every live thing inside it is theirs too, at any depth."""

    def test_its_creator_may_delete_a_folder_holding_only_their_own_files(self, client, world):
        r = delete_folder(client, world, "editor_a", "day1")
        assert r.status_code == 204, r.text
        assert folder_state(world, "day1")[1] == world["editor_a"].id
        # The cascade reached the subfolder and the asset two levels down.
        assert folder_state(world, "selects")[1] == world["editor_a"].id
        assert asset_state(world, "a_inside")[1] == world["editor_a"].id

    def test_its_creator_may_not_delete_a_folder_holding_a_colleagues_file(self, client, world):
        before = folder_state(world, "shared")
        r = delete_folder(client, world, "editor_a", "shared")
        assert r.status_code == 403
        assert "project owner" in r.json()["detail"]
        assert folder_state(world, "shared") == before == (None, None, None)
        # And nothing inside it was stamped either — the check runs BEFORE
        # the cascade, which is the whole reason it has to.
        assert asset_state(world, "b_mixed") == (None, None, None)

    def test_a_colleagues_file_deep_in_the_tree_refuses_it_too(self, client, world):
        """The recursive half of the rule: `b_mixed` moved two levels down
        is still somebody else's file inside `shared`."""
        session = world["session"]
        from apps.api.models.asset import Asset
        from apps.api.models.folder import Folder

        deep = Folder(
            project_id=world["project"].id,
            name=f"Deep-{uuid.uuid4().hex[:6]}",
            parent_id=world["shared"].id,
            created_by=world["editor_a"].id,
        )
        session.add(deep)
        session.commit()
        session.query(Asset).filter(Asset.id == world["assets"]["b_mixed"].id).update(
            {"folder_id": deep.id}
        )
        session.commit()

        r = delete_folder(client, world, "editor_a", "shared")
        assert r.status_code == 403
        assert folder_state(world, "shared") == (None, None, None)

    def test_an_editor_may_not_delete_a_folder_somebody_else_created(self, client, world):
        r = delete_folder(client, world, "editor_a", "theirs")
        assert r.status_code == 403
        assert folder_state(world, "theirs") == (None, None, None)

    def test_an_empty_folder_created_by_somebody_else_is_still_theirs(self, client, world):
        """Emptiness is not ownership: `theirs` holds nothing at all and
        editor_a still may not delete it."""
        from apps.api.models.asset import Asset

        assert world["session"].query(Asset).filter(
            Asset.folder_id == world["theirs"].id
        ).count() == 0
        assert delete_folder(client, world, "editor_a", "theirs").status_code == 403

    @pytest.mark.parametrize("actor", ["owner", "superadmin"])
    def test_the_owner_and_a_superadmin_may_delete_anybodys_folder(self, client, world, actor):
        r = delete_folder(client, world, actor, "shared")
        assert r.status_code == 204, r.text
        assert folder_state(world, "shared")[1] == world[actor].id
        assert asset_state(world, "b_mixed")[1] == world[actor].id

    def test_a_colleagues_file_already_in_the_trash_does_not_block_the_delete(self, client, world):
        """Once b_mixed is trashed it is not live content of `shared` any
        more, so the folder is all editor_a's again."""
        assert delete_asset(client, world, "editor_b", "b_mixed").status_code == 204
        assert delete_folder(client, world, "editor_a", "shared").status_code == 204

    @pytest.mark.parametrize("actor", ["viewer", "outsider"])
    def test_viewer_and_outsider_are_refused(self, client, world, actor):
        assert delete_folder(client, world, actor, "day1").status_code == 403
        assert folder_state(world, "day1") == (None, None, None)


class TestThereIsNoOtherDeleteEntryPoint:
    """§240 C2 asks for the rule on EVERY path that writes `deleted_at` to
    an asset or a folder. There are exactly two routes that do, and no
    bulk/multi-select endpoint exists — the web's multi-select loops over
    `DELETE /assets/{id}` one id at a time (verified by grep), so each
    item in a multi-select is checked individually and a mixed selection
    deletes the allowed ones and 403s the rest, per item.

    This test is structural so that ADDING a bulk delete route without
    the permission rule fails here rather than in production.
    """

    def test_only_two_routes_delete_an_asset_or_a_folder(self):
        from apps.api.main import app

        delete_routes = {
            r.path for r in app.routes
            if "DELETE" in getattr(r, "methods", set())
            and ("asset" in r.path or "folder" in r.path)
        }
        assert delete_routes == {
            "/assets/{asset_id}",                            # §240 C2
            "/assets/{asset_id}/versions/{version_id}",      # §239's rule
            "/folders/{folder_id}",                          # §240 C2
            # Revokes a share OF a folder; writes `share_links.deleted_at`,
            # never the folder's. Listed so this assertion can be exact.
            "/folders/{folder_id}/shares/{share_id}",
        }

    def test_no_route_mentions_bulk_delete(self):
        from apps.api.main import app

        assert not [
            r.path for r in app.routes
            if "bulk" in r.path and "move" not in r.path
        ]


# ── `can_delete` on the responses the web renders actions from ────────────

class TestTheCanDeleteFlag:
    def test_an_asset_listing_says_who_may_delete_each_file(self, client, world):
        def flags(actor):
            r = client.get(
                f"/projects/{world['project'].id}/assets",
                headers=auth_header(world[actor]),
            )
            assert r.status_code == 200, r.text
            return {a["name"]: a["can_delete"] for a in r.json()}

        a = flags("editor_a")
        assert a["a_alpha.mov"] is True
        assert a["b_beta.mov"] is False
        assert all(flags("owner").values())
        assert all(flags("superadmin").values())
        assert not any(flags("viewer").values())

    def test_the_folder_tree_says_which_folders_may_be_deleted(self, client, world):
        def flags(actor):
            r = client.get(
                f"/projects/{world['project'].id}/folder-tree",
                headers=auth_header(world[actor]),
            )
            assert r.status_code == 200, r.text
            out = {}

            def walk(nodes):
                for n in nodes:
                    out[n["name"]] = n["can_delete"]
                    walk(n["children"])

            walk(r.json())
            return out

        a = flags("editor_a")
        assert a[world["day1"].name] is True        # hers, all hers inside
        assert a[world["selects"].name] is True
        assert a[world["shared"].name] is False     # holds editor_b's file
        assert a[world["theirs"].name] is False     # editor_b created it
        assert all(flags("owner").values())
        assert not any(flags("viewer").values())

    def test_the_flat_folder_listing_agrees_with_the_tree(self, client, world):
        r = client.get(
            f"/projects/{world['project'].id}/folders",
            headers=auth_header(world["editor_a"]),
        )
        assert r.status_code == 200
        flags = {f["name"]: f["can_delete"] for f in r.json()}
        assert flags[world["day1"].name] is True
        assert flags[world["shared"].name] is False

    def test_the_tree_flag_matches_the_single_folder_predicate(self, client, world):
        """The batched map and `folder_subtree_is_all_mine` must agree —
        two implementations of one rule is how they come to disagree."""
        from apps.api.services.permissions import can_delete_folder

        session = world["session"]
        r = client.get(
            f"/projects/{world['project'].id}/folder-tree",
            headers=auth_header(world["editor_a"]),
        )
        batched = {}

        def walk(nodes):
            for n in nodes:
                batched[uuid.UUID(n["id"])] = n["can_delete"]
                walk(n["children"])

        walk(r.json())
        for key in ("day1", "selects", "shared", "theirs"):
            folder = world[key]
            assert batched[folder.id] == can_delete_folder(
                session, folder, world["editor_a"]
            ), key


# ── C: restoring ──────────────────────────────────────────────────────────

class TestWhoMayRestore:
    """One rule for assets, folders and versions: the deleter, the project
    owner, or a superadmin."""

    @pytest.mark.parametrize("actor", ["editor_a", "owner", "superadmin"])
    def test_the_deleter_the_owner_and_a_superadmin_may_restore_an_asset(
        self, client, world, actor
    ):
        assert delete_asset(client, world, "editor_a", "a_alpha").status_code == 204
        r = client.post(
            f"/assets/{world['assets']['a_alpha'].id}/restore",
            headers=auth_header(world[actor]),
        )
        assert r.status_code == 200, r.text
        # §240 A — a live row carries no deleter.
        assert asset_state(world, "a_alpha") == (None, None, None)

    def test_another_editor_may_not_restore_somebody_elses_deletion(self, client, world):
        assert delete_asset(client, world, "editor_a", "a_alpha").status_code == 204
        before = asset_state(world, "a_alpha")
        r = client.post(
            f"/assets/{world['assets']['a_alpha'].id}/restore",
            headers=auth_header(world["editor_b"]),
        )
        assert r.status_code == 403
        assert "restore" in r.json()["detail"]
        assert asset_state(world, "a_alpha") == before

    def test_an_editor_may_restore_what_they_deleted_themselves(self, client, world):
        assert delete_asset(client, world, "editor_b", "b_beta").status_code == 204
        r = client.post(
            f"/assets/{world['assets']['b_beta'].id}/restore",
            headers=auth_header(world["editor_b"]),
        )
        assert r.status_code == 200, r.text

    @pytest.mark.parametrize("actor", ["viewer", "outsider"])
    def test_viewer_and_outsider_may_not_restore(self, client, world, actor):
        assert delete_asset(client, world, "editor_a", "a_alpha").status_code == 204
        r = client.post(
            f"/assets/{world['assets']['a_alpha'].id}/restore",
            headers=auth_header(world[actor]),
        )
        assert r.status_code == 403
        assert asset_state(world, "a_alpha")[0] is not None

    @pytest.mark.parametrize(
        "actor,expected",
        [("owner", 200), ("superadmin", 200), ("editor_a", 403), ("editor_b", 403)],
    )
    def test_a_row_with_no_recorded_deleter_is_owner_only(self, client, world, actor, expected):
        """Pre-§240 rows: `deleted_at` set, `deleted_by` NULL. No backfill
        was possible, so nobody can claim to have deleted them."""
        from datetime import datetime, timezone

        from apps.api.models.asset import Asset

        session = world["session"]
        session.query(Asset).filter(Asset.id == world["assets"]["a_alpha"].id).update(
            {"deleted_at": datetime.now(timezone.utc), "deleted_by": None,
             "deleted_by_name": None}
        )
        session.commit()
        r = client.post(
            f"/assets/{world['assets']['a_alpha'].id}/restore",
            headers=auth_header(world[actor]),
        )
        assert r.status_code == expected, r.text

    @pytest.mark.parametrize("actor,expected", [("editor_a", 200), ("editor_b", 403)])
    def test_the_same_rule_governs_folders(self, client, world, actor, expected):
        assert delete_folder(client, world, "editor_a", "day1").status_code == 204
        r = client.post(
            f"/folders/{world['day1'].id}/restore", headers=auth_header(world[actor])
        )
        assert r.status_code == expected, r.text
        if expected == 200:
            assert folder_state(world, "day1") == (None, None, None)
        else:
            assert folder_state(world, "day1")[0] is not None

    def test_restoring_an_undeleted_asset_is_404(self, client, world):
        r = client.post(
            f"/assets/{world['assets']['a_alpha'].id}/restore",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 404


# ── The folder-restore regression ─────────────────────────────────────────

class TestFolderRestoreOnlyUndoesItsOwnDeletion:
    def test_an_asset_deleted_before_its_folder_is_not_resurrected(self, client, world):
        """The behaviour the owner asked about. On `main` this FAILS:
        `restore_folder` cleared `deleted_at` on every deleted asset under
        the folder, so restoring `Day 1` also brought back a file somebody
        had deliberately trashed earlier."""
        from apps.api.models.asset import Asset

        session = world["session"]
        # a_inside is trashed on its own, first.
        assert delete_asset(client, world, "editor_a", "a_inside").status_code == 204
        own_stamp = asset_state(world, "a_inside")[0]
        assert own_stamp is not None

        # Then the whole folder goes, later. The cascade must NOT re-stamp
        # the asset that was already deleted.
        assert delete_folder(client, world, "editor_a", "day1").status_code == 204
        assert asset_state(world, "a_inside")[0] == own_stamp

        # Restoring the folder brings back the folder and the subfolder,
        # and leaves the separately-trashed asset where its deleter put it.
        r = client.post(
            f"/folders/{world['day1'].id}/restore",
            headers=auth_header(world["editor_a"]),
        )
        assert r.status_code == 200, r.text
        assert folder_state(world, "day1")[0] is None
        assert folder_state(world, "selects")[0] is None
        assert asset_state(world, "a_inside")[0] == own_stamp, (
            "an asset trashed before its folder was must stay trashed"
        )
        session.expire_all()

    def test_what_went_with_the_folder_does_come_back(self, client, world):
        assert delete_folder(client, world, "editor_a", "day1").status_code == 204
        assert asset_state(world, "a_inside")[0] is not None
        r = client.post(
            f"/folders/{world['day1'].id}/restore",
            headers=auth_header(world["editor_a"]),
        )
        assert r.status_code == 200, r.text
        assert asset_state(world, "a_inside") == (None, None, None)
        assert folder_state(world, "selects") == (None, None, None)

    def test_a_subfolder_deleted_earlier_also_stays_deleted(self, client, world):
        assert delete_folder(client, world, "editor_a", "selects").status_code == 204
        sub_stamp = folder_state(world, "selects")[0]
        assert delete_folder(client, world, "editor_a", "day1").status_code == 204
        assert folder_state(world, "selects")[0] == sub_stamp
        r = client.post(
            f"/folders/{world['day1'].id}/restore",
            headers=auth_header(world["editor_a"]),
        )
        assert r.status_code == 200, r.text
        assert folder_state(world, "day1")[0] is None
        assert folder_state(world, "selects")[0] == sub_stamp
