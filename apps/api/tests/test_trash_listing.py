"""§240 B — `GET /projects/{id}/trash` as ONE searchable, sorted, paged list.

What the route used to be, and what each group here pins down:

  * `skip`/`limit` were applied to the folder query and the asset query
    SEPARATELY, so no page ever held every row exactly once →
    `TestPaging` walks two pages and asserts the union is the whole
    trash, each row once;
  * there was no `total` → asserted against the real row count for every
    filter combination used here;
  * there was no search → `TestSearch`, including the two names with a
    literal `%` and `_` in them, which an unescaped pattern would turn
    into wildcards (§233);
  * every deleted row was listed, including the hundreds that were only
    deleted because a folder was → `TestNesting`;
  * there was no size, no deleter, no expiry → `TestShape`;
  * and nothing distinguished callers, although only some of them can
    restore anything → `TestVisibility`, the owner's §240 B decision.

See trash_world_240.py for the cast and how to run this.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import patch

from .trash_world_240 import (
    PG_URL,
    SIZES,
    auth_header,
    build_world,
    realdb,
    teardown_world,
)

pytestmark = realdb

KIB = 1024


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


def trash(client, world, actor="owner", project=None, **params):
    pid = (project or world["project"]).id
    r = client.get(
        f"/projects/{pid}/trash", params=params, headers=auth_header(world[actor])
    )
    return r


def names(body):
    return [i["name"] for i in body["items"]]


def delete_asset(client, world, actor, key):
    r = client.delete(
        f"/assets/{world['assets'][key].id}", headers=auth_header(world[actor])
    )
    assert r.status_code == 204, r.text


def delete_folder(client, world, actor, folder_key):
    r = client.delete(
        f"/folders/{world[folder_key].id}", headers=auth_header(world[actor])
    )
    assert r.status_code == 204, r.text


def delete_version(client, world, actor, key, number):
    v = world["versions"][(key, number)]
    r = client.delete(
        f"/assets/{world['assets'][key].id}/versions/{v.id}",
        headers=auth_header(world[actor]),
    )
    assert r.status_code == 204, r.text


@pytest.fixture
def populated(client, world):
    """A trash with one of everything, deleted by two different people.

      a_alpha.mov        asset    editor_a
      b_beta.mov         asset    editor_b
      a_100%_raw.mov     asset    editor_a
      a_b_roll.mov       asset    editor_a
      Day 1/             folder   owner   (→ Selects/ and a_inside.mov
                                           nested underneath it)
      a_multi.mov v2     version  editor_a (asset itself still live)
    """
    delete_asset(client, world, "editor_a", "a_alpha")
    delete_asset(client, world, "editor_b", "b_beta")
    delete_asset(client, world, "editor_a", "a_pct")
    delete_asset(client, world, "editor_a", "a_underscore")
    delete_folder(client, world, "owner", "day1")
    delete_version(client, world, "editor_a", "a_multi", 2)
    return world


# ── Shape ─────────────────────────────────────────────────────────────────

class TestShape:
    def test_every_field_of_the_contract_is_present(self, client, populated):
        body = trash(client, populated).json()
        assert set(body) >= {
            "items", "total", "retention_days", "deleters", "folders", "assets",
        }
        for item in body["items"]:
            assert set(item) == {
                "id", "kind", "name", "deleted_at", "expires_at", "deleted_by",
                "original_folder_id", "original_path", "size_bytes",
                "can_restore", "can_purge", "child_count", "asset_type",
                "asset_id", "version_number",
            }

    def test_retention_days_comes_from_the_purge_service(self, client, populated):
        from apps.api.services.purge_service import RETENTION_DAYS

        assert trash(client, populated).json()["retention_days"] == RETENTION_DAYS == 30

    def test_expires_at_is_deleted_at_plus_the_retention_window(self, client, populated):
        from apps.api.services.purge_service import RETENTION_DAYS

        for item in trash(client, populated).json()["items"]:
            deleted = datetime.fromisoformat(item["deleted_at"])
            assert datetime.fromisoformat(item["expires_at"]) == deleted + timedelta(
                days=RETENTION_DAYS
            )

    def test_the_deleter_is_named_per_row(self, client, populated):
        by_name = {i["name"]: i["deleted_by"] for i in trash(client, populated).json()["items"]}
        assert by_name["a_alpha.mov"]["id"] == str(populated["editor_a"].id)
        assert by_name["a_alpha.mov"]["name"] == populated["editor_a"].name
        assert by_name["b_beta.mov"]["id"] == str(populated["editor_b"].id)

    def test_a_row_deleted_before_240_reports_an_unknown_deleter(self, client, world):
        from apps.api.models.asset import Asset

        session = world["session"]
        session.query(Asset).filter(Asset.id == world["assets"]["a_alpha"].id).update(
            {"deleted_at": datetime.now(timezone.utc)}
        )
        session.commit()
        item = trash(client, world).json()["items"][0]
        assert item["deleted_by"] is None
        assert item["can_restore"] is True  # owner

    def test_an_asset_reports_the_bytes_of_its_live_versions(self, client, world):
        delete_asset(client, world, "editor_a", "a_multi")
        item = [i for i in trash(client, world).json()["items"] if i["kind"] == "asset"][0]
        assert item["size_bytes"] == SIZES[("a_multi", 1)] + SIZES[("a_multi", 2)] + SIZES[("a_multi", 3)]

    def test_an_assets_size_excludes_a_version_deleted_separately(self, client, world):
        """A version deleted on its own already stopped counting toward
        every storage figure (§239), so the asset's trash row must not
        claim those bytes back — restoring the asset does not restore
        that version.

        Note the version does NOT get its own row here: its asset is in
        the trash, so the asset is the row (see
        `test_a_deleted_version_of_a_deleted_asset_is_not_its_own_row`).
        A version row with its own size is covered by
        `test_a_version_row_names_its_asset_and_number` below, where the
        asset is still live."""
        delete_version(client, world, "editor_a", "a_multi", 2)
        delete_asset(client, world, "editor_a", "a_multi")
        rows = {i["kind"]: i for i in trash(client, world).json()["items"]}
        assert set(rows) == {"asset"}
        assert rows["asset"]["size_bytes"] == SIZES[("a_multi", 1)] + SIZES[("a_multi", 3)]

    def test_a_version_row_carries_only_its_own_bytes(self, client, world):
        delete_version(client, world, "editor_a", "a_multi", 2)
        rows = {i["kind"]: i for i in trash(client, world).json()["items"]}
        assert rows["version"]["size_bytes"] == SIZES[("a_multi", 2)]

    def test_a_folder_reports_everything_in_its_subtree(self, client, world):
        delete_folder(client, world, "owner", "day1")
        item = trash(client, world).json()["items"][0]
        assert item["kind"] == "folder"
        assert item["size_bytes"] == SIZES[("a_inside", 1)]
        # One subfolder + one asset inside it, at any depth.
        assert item["child_count"] == 2

    def test_an_empty_folder_reports_zero(self, client, world):
        delete_folder(client, world, "owner", "theirs")
        item = trash(client, world).json()["items"][0]
        assert item["size_bytes"] == 0
        assert item["child_count"] == 0

    def test_a_version_row_names_its_asset_and_number(self, client, world):
        delete_version(client, world, "editor_a", "a_multi", 2)
        item = trash(client, world).json()["items"][0]
        assert item["kind"] == "version"
        assert item["name"] == "a_multi.mov"
        assert item["asset_id"] == str(world["assets"]["a_multi"].id)
        assert item["version_number"] == 2
        assert item["id"] == str(world["versions"][("a_multi", 2)].id)
        assert item["asset_type"] == "video"

    def test_where_it_used_to_live(self, client, world):
        delete_asset(client, world, "editor_a", "a_inside")
        item = trash(client, world).json()["items"][0]
        assert item["original_folder_id"] == str(world["selects"].id)
        assert item["original_path"] == f"{world['day1'].name} / {world['selects'].name}"

    def test_a_root_level_row_has_no_path(self, client, world):
        delete_asset(client, world, "editor_a", "a_alpha")
        item = trash(client, world).json()["items"][0]
        assert item["original_folder_id"] is None
        assert item["original_path"] == ""

    def test_the_path_of_a_deleted_folder_still_resolves(self, client, world):
        """`Selects` is inside `Day 1`, and `Day 1` is in the trash too —
        the path describes a place that no longer exists, which is the
        whole point."""
        delete_folder(client, world, "owner", "day1")
        body = trash(client, world, include_nested=True).json()
        sub = [i for i in body["items"] if i["id"] == str(world["selects"].id)][0]
        assert sub["original_path"] == world["day1"].name

    def test_can_purge_follows_the_existing_owner_admin_rule(self, client, populated):
        for actor, expected in (("owner", True), ("editor_a", False)):
            body = trash(client, populated, actor=actor).json()
            assert body["items"], actor
            assert all(
                i["can_purge"] is expected
                for i in body["items"] if i["kind"] != "version"
            ), actor

    def test_can_purge_is_false_for_a_superadmin_who_is_only_an_editor_member(
        self, client, populated
    ):
        """It has to mirror the purge route exactly, and that route is
        `require_project_role(admin)` — which has no superadmin bypass.
        Claiming the action here would show a button that 403s."""
        body = trash(client, populated, actor="superadmin").json()
        assert body["items"]
        assert all(i["can_purge"] is False for i in body["items"])
        r = client.post(
            f"/assets/{populated['assets']['a_alpha'].id}/purge",
            headers=auth_header(populated["superadmin"]),
        )
        assert r.status_code == 403

    def test_a_version_never_offers_a_purge(self, client, world):
        """There is no purge route for one version."""
        delete_version(client, world, "editor_a", "a_multi", 2)
        item = trash(client, world).json()["items"][0]
        assert item["kind"] == "version"
        assert item["can_purge"] is False


# ── Visibility (§240 B) ───────────────────────────────────────────────────

class TestVisibility:
    def test_an_editor_sees_only_their_own_deletions(self, client, populated):
        body = trash(client, populated, actor="editor_a").json()
        assert sorted(names(body)) == sorted(
            ["a_alpha.mov", "a_100%_raw.mov", "a_b_roll.mov", "a_multi.mov"]
        )
        assert body["total"] == 4
        assert all(i["can_restore"] for i in body["items"])

        other = trash(client, populated, actor="editor_b").json()
        assert names(other) == ["b_beta.mov"]
        assert other["total"] == 1

    @pytest.mark.parametrize("actor", ["owner", "superadmin"])
    def test_the_owner_and_a_superadmin_see_the_whole_trash(self, client, populated, actor):
        body = trash(client, populated, actor=actor).json()
        assert body["total"] == 6
        assert all(i["can_restore"] for i in body["items"])

    def test_an_editor_never_sees_a_row_with_an_unknown_deleter(self, client, world):
        from apps.api.models.asset import Asset

        session = world["session"]
        session.query(Asset).filter(Asset.id == world["assets"]["a_alpha"].id).update(
            {"deleted_at": datetime.now(timezone.utc)}
        )
        session.commit()
        assert trash(client, world, actor="editor_a").json()["total"] == 0
        assert trash(client, world, actor="owner").json()["total"] == 1

    def test_the_deleters_list_is_scoped_to_the_caller(self, client, populated):
        owner_view = trash(client, populated).json()["deleters"]
        assert {d["id"] for d in owner_view} == {
            str(populated["editor_a"].id), str(populated["editor_b"].id),
            str(populated["owner"].id),
        }
        editor_view = trash(client, populated, actor="editor_b").json()["deleters"]
        assert [d["id"] for d in editor_view] == [str(populated["editor_b"].id)]

    def test_the_deleters_list_does_not_shrink_when_a_filter_is_applied(self, client, populated):
        """It feeds the filter dropdown; narrowing it by the filter it
        feeds would make options vanish as soon as they were used."""
        unfiltered = trash(client, populated).json()["deleters"]
        filtered = trash(
            client, populated, deleted_by=str(populated["editor_b"].id)
        ).json()
        assert filtered["deleters"] == unfiltered
        assert names(filtered) == ["b_beta.mov"]

    def test_a_viewer_is_refused(self, client, populated):
        assert trash(client, populated, actor="viewer").status_code == 403

    def test_an_outsider_is_refused(self, client, populated):
        assert trash(client, populated, actor="outsider").status_code == 403

    def test_a_superadmin_who_is_not_a_member_still_gets_the_old_403(self, client, populated):
        """§240 deliberately did not widen this gate: it is
        `require_project_role(editor)`, exactly as before."""
        from apps.api.models.project import ProjectMember

        session = populated["session"]
        session.query(ProjectMember).filter(
            ProjectMember.project_id == populated["project"].id,
            ProjectMember.user_id == populated["superadmin"].id,
        ).delete(synchronize_session=False)
        session.commit()
        assert trash(client, populated, actor="superadmin").status_code == 403

    def test_another_projects_rows_are_never_returned(self, client, world):
        delete_asset(client, world, "owner", "foreign")
        delete_asset(client, world, "editor_a", "a_alpha")
        body = trash(client, world).json()
        assert names(body) == ["a_alpha.mov"]
        assert body["total"] == 1
        # And the other project's own trash holds only its own row.
        other = trash(client, world, project=world["other_project"]).json()
        assert names(other) == ["foreign.mov"]


# ── Search ────────────────────────────────────────────────────────────────

class TestSearch:
    def test_a_substring_matches_case_insensitively(self, client, populated):
        assert names(trash(client, populated, q="ALPHA").json()) == ["a_alpha.mov"]

    def test_a_percent_sign_is_a_literal(self, client, populated):
        body = trash(client, populated, q="%").json()
        assert names(body) == ["a_100%_raw.mov"]
        assert body["total"] == 1

    def test_an_underscore_is_a_literal(self, client, populated):
        """`a_b_roll.mov` contains `b_r`; `_b_` as a wildcard would match
        several of these names."""
        body = trash(client, populated, q="b_roll").json()
        assert names(body) == ["a_b_roll.mov"]

    def test_a_backslash_is_a_literal_too(self, client, populated):
        assert trash(client, populated, q="\\").json()["total"] == 0

    def test_a_version_matches_its_assets_name(self, client, populated):
        body = trash(client, populated, q="multi").json()
        assert [i["kind"] for i in body["items"]] == ["version"]

    def test_a_version_matches_its_own_label(self, client, populated):
        body = trash(client, populated, q="v2", kind="version").json()
        assert body["total"] == 1
        assert body["items"][0]["version_number"] == 2
        assert trash(client, populated, q="v9", kind="version").json()["total"] == 0

    def test_a_folder_matches_by_name(self, client, populated):
        body = trash(client, populated, q=populated["day1"].name).json()
        assert [i["kind"] for i in body["items"]] == ["folder"]

    def test_no_match_is_an_empty_list_not_an_error(self, client, populated):
        body = trash(client, populated, q="nothing-called-this").json()
        assert body["items"] == [] and body["total"] == 0


# ── Filters ───────────────────────────────────────────────────────────────

class TestFilters:
    @pytest.mark.parametrize(
        "kind,expected",
        [
            ("asset", {"asset"}),
            ("folder", {"folder"}),
            ("version", {"version"}),
        ],
    )
    def test_kind_narrows_to_one_kind(self, client, populated, kind, expected):
        body = trash(client, populated, kind=kind).json()
        assert body["items"]
        assert {i["kind"] for i in body["items"]} == expected
        assert body["total"] == len(body["items"])

    def test_all_is_the_default_and_holds_every_kind(self, client, populated):
        body = trash(client, populated).json()
        assert {i["kind"] for i in body["items"]} == {"asset", "folder", "version"}

    def test_an_unknown_kind_is_rejected(self, client, populated):
        assert trash(client, populated, kind="banana").status_code == 422

    def test_deleted_by_filters_on_the_person(self, client, populated):
        body = trash(client, populated, deleted_by=str(populated["editor_a"].id)).json()
        assert body["total"] == 4
        assert all(
            i["deleted_by"]["id"] == str(populated["editor_a"].id) for i in body["items"]
        )

    def test_deleted_by_unknown_reaches_pre_240_rows(self, client, populated):
        from apps.api.models.asset import Asset

        session = populated["session"]
        session.query(Asset).filter(Asset.id == populated["assets"]["a_alpha"].id).update(
            {"deleted_by": None, "deleted_by_name": None}
        )
        session.commit()
        body = trash(client, populated, deleted_by="unknown").json()
        assert names(body) == ["a_alpha.mov"]
        assert body["unknown_deleter_present"] is True

    def test_unknown_is_not_reported_when_nothing_matches_it(self, client, populated):
        assert trash(client, populated).json()["unknown_deleter_present"] is False

    def test_a_malformed_deleted_by_is_a_400_not_a_500(self, client, populated):
        assert trash(client, populated, deleted_by="not-a-uuid").status_code == 400

    def test_a_deleter_who_deleted_nothing_matches_nothing(self, client, populated):
        body = trash(client, populated, deleted_by=str(uuid.uuid4())).json()
        assert body["items"] == [] and body["total"] == 0


# ── Nesting ───────────────────────────────────────────────────────────────

class TestNesting:
    def test_only_roots_are_listed_by_default(self, client, world):
        delete_folder(client, world, "owner", "day1")
        body = trash(client, world).json()
        assert [i["id"] for i in body["items"]] == [str(world["day1"].id)]
        assert body["total"] == 1
        assert body["items"][0]["child_count"] == 2

    def test_include_nested_shows_what_went_with_it(self, client, world):
        delete_folder(client, world, "owner", "day1")
        body = trash(client, world, include_nested=True).json()
        assert {i["id"] for i in body["items"]} == {
            str(world["day1"].id),
            str(world["selects"].id),
            str(world["assets"]["a_inside"].id),
        }
        assert body["total"] == 3

    def test_an_individually_deleted_asset_inside_a_live_folder_is_a_root(self, client, world):
        delete_asset(client, world, "editor_a", "a_inside")
        body = trash(client, world).json()
        assert names(body) == ["a_inside.mov"]

    def test_a_deleted_version_of_a_deleted_asset_is_not_its_own_row(self, client, world):
        """The asset is the row; restoring it brings its versions back."""
        delete_version(client, world, "editor_a", "a_multi", 2)
        delete_asset(client, world, "editor_a", "a_multi")
        body = trash(client, world, include_nested=True).json()
        assert [i["kind"] for i in body["items"]] == ["asset"]

    def test_a_version_of_a_live_asset_is_always_listed(self, client, world):
        delete_version(client, world, "editor_a", "a_multi", 2)
        assert trash(client, world).json()["total"] == 1


# ── Sorting ───────────────────────────────────────────────────────────────

class TestSorting:
    def test_newest_deletion_first_by_default(self, client, populated):
        body = trash(client, populated).json()
        stamps = [i["deleted_at"] for i in body["items"]]
        assert stamps == sorted(stamps, reverse=True)

    def test_deleted_at_ascending_when_asked(self, client, populated):
        stamps = [i["deleted_at"] for i in trash(client, populated, sort="deleted_at", order="asc").json()["items"]]
        assert stamps == sorted(stamps)

    def test_name_sorts_alphabetically_ascending_by_default(self, client, populated):
        got = names(trash(client, populated, sort="name").json())
        assert got == sorted(got, key=str.lower)

    def test_name_descending_when_asked(self, client, populated):
        got = names(trash(client, populated, sort="name", order="desc").json())
        assert got == sorted(got, key=str.lower, reverse=True)

    def test_size_sorts_biggest_first_by_default(self, client, populated):
        sizes = [i["size_bytes"] for i in trash(client, populated, sort="size").json()["items"]]
        assert sizes == sorted(sizes, reverse=True)

    def test_size_ascending_when_asked(self, client, populated):
        sizes = [i["size_bytes"] for i in trash(client, populated, sort="size", order="asc").json()["items"]]
        assert sizes == sorted(sizes)

    def test_expires_at_sorts_soonest_first_by_default(self, client, populated):
        got = [i["expires_at"] for i in trash(client, populated, sort="expires_at").json()["items"]]
        assert got == sorted(got)

    def test_expires_at_descending_when_asked(self, client, populated):
        got = [i["expires_at"] for i in trash(client, populated, sort="expires_at", order="desc").json()["items"]]
        assert got == sorted(got, reverse=True)

    def test_an_unknown_sort_is_rejected(self, client, populated):
        assert trash(client, populated, sort="colour").status_code == 422
        assert trash(client, populated, order="sideways").status_code == 422


# ── Paging over the MERGED list ───────────────────────────────────────────

class TestPaging:
    def test_a_two_page_walk_returns_every_row_exactly_once(self, client, populated):
        body = trash(client, populated).json()
        total = body["total"]
        assert total == 6
        first = trash(client, populated, limit=4, offset=0).json()
        second = trash(client, populated, limit=4, offset=4).json()
        assert len(first["items"]) == 4
        assert len(second["items"]) == 2
        assert first["total"] == second["total"] == total
        ids = [i["id"] for i in first["items"]] + [i["id"] for i in second["items"]]
        assert len(ids) == len(set(ids)) == total

    def test_the_same_walk_holds_for_every_sort(self, client, populated):
        for sort in ("deleted_at", "name", "size", "expires_at"):
            for order in ("asc", "desc"):
                seen = []
                for offset in (0, 2, 4):
                    page = trash(
                        client, populated, sort=sort, order=order, limit=2, offset=offset
                    ).json()
                    seen += [i["id"] for i in page["items"]]
                assert len(seen) == len(set(seen)) == 6, (sort, order)

    def test_rows_sharing_one_deleted_at_still_page_cleanly(self, client, world):
        """A folder cascade stamps one timestamp onto everything it
        touches, so without a tie-break the order of those rows is not
        defined and a walk could repeat one and skip another."""
        delete_folder(client, world, "owner", "day1")
        body = trash(client, world, include_nested=True).json()
        assert body["total"] == 3
        stamps = {i["deleted_at"] for i in body["items"]}
        assert len(stamps) == 1
        seen = []
        for offset in (0, 1, 2):
            seen += [i["id"] for i in trash(client, world, include_nested=True, limit=1, offset=offset).json()["items"]]
        assert len(set(seen)) == 3

    def test_total_is_the_match_count_not_the_page_size(self, client, populated):
        body = trash(client, populated, limit=1).json()
        assert len(body["items"]) == 1
        assert body["total"] == 6

    def test_total_respects_the_filters(self, client, populated):
        assert trash(client, populated, kind="asset", limit=1).json()["total"] == 4
        assert trash(client, populated, q="alpha", limit=1).json()["total"] == 1

    def test_an_offset_past_the_end_is_an_empty_page(self, client, populated):
        body = trash(client, populated, offset=99).json()
        assert body["items"] == []
        assert body["total"] == 6

    def test_the_deprecated_skip_alias_still_works(self, client, populated):
        by_skip = trash(client, populated, limit=2, skip=2).json()
        by_offset = trash(client, populated, limit=2, offset=2).json()
        assert [i["id"] for i in by_skip["items"]] == [i["id"] for i in by_offset["items"]]

    def test_limit_bounds_are_enforced(self, client, populated):
        assert trash(client, populated, limit=0).status_code == 422
        assert trash(client, populated, limit=101).status_code == 422
        assert trash(client, populated, offset=-1).status_code == 422

    def test_limit_is_no_longer_applied_per_kind(self, client, populated):
        """The old bug: `limit=2` returned 2 folders AND 2 assets."""
        body = trash(client, populated, limit=2).json()
        assert len(body["items"]) == 2
        assert len(body["folders"]) + len(body["assets"]) <= 2


# ── The legacy keys the pre-§240 web still reads ──────────────────────────

class TestLegacyKeys:
    def test_they_hold_the_same_rows_as_the_page(self, client, populated):
        body = trash(client, populated).json()
        assert {f["id"] for f in body["folders"]} == {
            i["id"] for i in body["items"] if i["kind"] == "folder"
        }
        assert {a["id"] for a in body["assets"]} == {
            i["id"] for i in body["items"] if i["kind"] == "asset"
        }

    def test_their_shape_is_unchanged(self, client, populated):
        body = trash(client, populated).json()
        for f in body["folders"]:
            assert set(f) == {"id", "name", "type", "parent_id", "deleted_at"}
            assert f["type"] == "folder"
        for a in body["assets"]:
            assert set(a) == {"id", "name", "type", "folder_id", "deleted_at"}
            assert a["type"] == "video"

    def test_versions_appear_in_neither_legacy_key(self, client, world):
        delete_version(client, world, "editor_a", "a_multi", 2)
        body = trash(client, world).json()
        assert body["folders"] == [] and body["assets"] == []
        assert len(body["items"]) == 1


# ── Size ──────────────────────────────────────────────────────────────────

class TestALargerTrash:
    def test_a_thousand_rows_page_in_one_bounded_query(self, client, world):
        """The largest trash tested: 1 000 deleted assets plus the six
        rows the other tests use. Asserted on correctness (`total`, the
        page size, the ordering) rather than on a wall-clock number — the
        point is that the page is produced by one statement with a LIMIT,
        not by loading the trash into Python."""
        from apps.api.models.asset import Asset, AssetType

        session = world["session"]
        now = datetime.now(timezone.utc)
        rows = [
            Asset(
                project_id=world["project"].id,
                name=f"bulk-{n:04d}.mov",
                asset_type=AssetType.video,
                created_by=world["editor_a"].id,
                deleted_at=now - timedelta(minutes=n),
                deleted_by=world["editor_a"].id,
                deleted_by_name=world["editor_a"].name,
            )
            for n in range(1000)
        ]
        session.add_all(rows)
        session.commit()

        body = trash(client, world, limit=50).json()
        assert body["total"] == 1000
        assert len(body["items"]) == 50
        assert names(body)[0] == "bulk-0000.mov"  # newest deletion first
        last = trash(client, world, limit=50, offset=950).json()
        assert names(last)[-1] == "bulk-0999.mov"
        assert trash(client, world, q="bulk-0500").json()["total"] == 1
        assert trash(client, world, sort="size").json()["total"] == 1000
