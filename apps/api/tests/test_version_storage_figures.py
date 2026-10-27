"""§239 B — a deleted version stops counting, in all eight places.

Every storage figure in this app is one aggregate,
`SUM(media_files.file_size_bytes)` joined through `asset_versions` to
`assets`, and every copy of it filtered `assets.deleted_at IS NULL` and
nothing else. That was complete while a version could not be deleted on
its own; the moment §239 made it possible, each copy became a number that
counts bytes the user has already removed — including the two that REFUSE
UPLOADS, so an owner could delete a version to make room and be told
there is still none.

§239 routed all eight through `services/storage_usage.storage_bytes_query`.
There is one test per site here, named after it, because that is the only
way the mutation "omit `deleted_at IS NULL` from ONE of the quota sites"
fails loudly rather than being covered by a sibling:

  1. `routers/upload.py`      per-project limit enforcement
  2. `routers/upload.py`      platform limit enforcement
  3. `routers/site_settings.py` `_platform_storage_used_bytes`
  4. `routers/projects.py`    `GET /projects` (batched, per project)
  5. `routers/projects.py`    `GET /projects/{id}` (single)
  6. `routers/admin.py`       `GET /admin/projects`
  7. `routers/folders.py`     `_compute_folder_total_size` (recursive)
  8. `routers/folders.py`     the folder tree's direct sizes

NOT included, deliberately: `scripts/report_trash_backlog.py`. Its
aggregate answers "how much would the purge free", and the purge removes
soft-deleted version rows and clears the asset's prefix wholesale — so
excluding them there would UNDER-report by exactly the bytes of the
versions users deleted one at a time. See the comment at that query and
test_trash_backlog_versions.py.

See tests/version_world_239.py for the fixture and how to run this.
"""

import pytest
from unittest.mock import MagicMock, patch

from .fake_multipart_store import FakeMultipartStore
from .version_world_239 import (
    KIB,
    PG_URL,
    PROJECT_TOTAL,
    SIZES,
    auth_header,
    build_world,
    realdb,
    teardown_world,
)

pytestmark = realdb

#: The version every test here deletes, and what it is worth.
DELETED = ("clip", 2)
DELETED_BYTES = SIZES[DELETED]


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
        "apps.api.services.s3_service.create_multipart_upload", return_value="up-1"
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


@pytest.fixture
def drop_v2(client, world):
    """Delete clip v2 through the real route, and hand back its size."""

    def _drop():
        r = client.delete(
            f"/assets/{world['clip'].id}/versions/{world['versions'][DELETED].id}",
            headers=auth_header(world["owner"]),
        )
        assert r.status_code == 204, r.text
        world["session"].expire_all()
        return DELETED_BYTES

    return _drop


def project_row(payload, project_id):
    return next(p for p in payload if p["id"] == str(project_id))


# ── 1 & 2: the two ENFORCEMENT sites, which refuse uploads ───────────────

class TestUploadLimits:
    """These two are the ones with teeth: they do not display a number,
    they decide whether an upload is allowed at all."""

    def initiate(self, client, world, actor, size):
        return client.post(
            "/upload/initiate",
            json={
                "project_id": str(world["project"].id),
                "asset_name": "fresh",
                "original_filename": "fresh.mov",
                "mime_type": "video/quicktime",
                "file_size_bytes": size,
            },
            headers=auth_header(world[actor]),
        )

    def test_the_per_project_limit_frees_up_after_a_delete(
        self, client, world, drop_v2
    ):
        session = world["session"]
        # Full to the byte: PROJECT_TOTAL is exactly what this project
        # holds, so anything at all is refused.
        world["project"].storage_limit_bytes = PROJECT_TOTAL
        session.commit()

        refused = self.initiate(client, world, "uploader", 1 * KIB)
        assert refused.status_code == 400
        assert "Project storage limit" in refused.json()["detail"]

        freed = drop_v2()
        assert freed == 2 * KIB

        # Now exactly `freed` bytes fit, and one byte more does not —
        # which pins the figure to the version's size rather than merely
        # "something got smaller".
        too_big = self.initiate(client, world, "uploader", freed + 1)
        assert too_big.status_code == 400
        allowed = self.initiate(client, world, "uploader", freed)
        assert allowed.status_code == 200, allowed.text

    def test_the_platform_limit_frees_up_after_a_delete(
        self, client, world, drop_v2
    ):
        from apps.api.routers.site_settings import (
            _get_or_create_settings,
            _platform_storage_used_bytes,
        )

        session = world["session"]
        settings_row = _get_or_create_settings(session)
        previous = settings_row.total_storage_limit_bytes
        # Measured, not assumed: this database may hold other rows, and
        # the platform figure is every project on the instance.
        settings_row.total_storage_limit_bytes = _platform_storage_used_bytes(session)
        session.commit()
        try:
            refused = self.initiate(client, world, "uploader", 1 * KIB)
            assert refused.status_code == 400
            assert "Platform storage limit" in refused.json()["detail"]

            freed = drop_v2()
            allowed = self.initiate(client, world, "uploader", freed)
            assert allowed.status_code == 200, allowed.text
        finally:
            settings_row.total_storage_limit_bytes = previous
            session.commit()


# ── 3–8: the figures that are DISPLAYED ──────────────────────────────────

class TestDisplayedFigures:

    def test_site_settings_platform_total(self, client, world, drop_v2):
        hdr = auth_header(world["superadmin"])
        before = client.get("/site-settings", headers=hdr).json()[
            "total_storage_used_bytes"
        ]
        freed = drop_v2()
        after = client.get("/site-settings", headers=hdr).json()[
            "total_storage_used_bytes"
        ]
        assert before - after == freed

    def test_projects_list_storage_bytes(self, client, world, drop_v2):
        hdr = auth_header(world["owner"])
        before = project_row(
            client.get("/projects", headers=hdr).json(), world["project"].id
        )["storage_bytes"]
        assert before == PROJECT_TOTAL
        freed = drop_v2()
        after = project_row(
            client.get("/projects", headers=hdr).json(), world["project"].id
        )["storage_bytes"]
        assert after == PROJECT_TOTAL - freed

    def test_project_detail_storage_bytes(self, client, world, drop_v2):
        hdr = auth_header(world["owner"])
        url = f"/projects/{world['project'].id}"
        assert client.get(url, headers=hdr).json()["storage_bytes"] == PROJECT_TOTAL
        freed = drop_v2()
        assert client.get(url, headers=hdr).json()["storage_bytes"] == (
            PROJECT_TOTAL - freed
        )

    def test_admin_projects_list_storage_bytes(self, client, world, drop_v2):
        hdr = auth_header(world["superadmin"])
        before = project_row(
            client.get("/admin/projects", headers=hdr).json(), world["project"].id
        )["storage_bytes"]
        assert before == PROJECT_TOTAL
        freed = drop_v2()
        after = project_row(
            client.get("/admin/projects", headers=hdr).json(), world["project"].id
        )["storage_bytes"]
        assert after == PROJECT_TOTAL - freed

    def test_folder_listing_total_size(self, client, world, drop_v2):
        """`_compute_folder_total_size`, the RECURSIVE rollup: `clip` lives
        in a subfolder, so the parent's figure only moves if the
        descendants are summed with the same predicate."""
        hdr = auth_header(world["owner"])
        url = f"/projects/{world['project'].id}/folders"
        clip_total = sum(SIZES[("clip", n)] for n in (1, 2, 3))

        def total_for(folder_id):
            rows = client.get(url, headers=hdr).json()
            return next(f for f in rows if f["id"] == str(folder_id))["total_size_bytes"]

        assert total_for(world["folder"].id) == clip_total
        freed = drop_v2()
        assert total_for(world["folder"].id) == clip_total - freed

    def test_folder_tree_direct_sizes(self, client, world, drop_v2):
        """The tree's `direct_sizes` is a SEPARATE grouped query from the
        one above and was wrong separately."""
        hdr = auth_header(world["owner"])
        url = f"/projects/{world['project'].id}/folder-tree"
        clip_total = sum(SIZES[("clip", n)] for n in (1, 2, 3))

        def subfolder_size(payload):
            for root in payload:
                for child in root.get("children") or []:
                    if child["id"] == str(world["subfolder"].id):
                        return child["total_size_bytes"]
            raise AssertionError("subfolder missing from the tree")

        assert subfolder_size(client.get(url, headers=hdr).json()) == clip_total
        freed = drop_v2()
        assert subfolder_size(client.get(url, headers=hdr).json()) == (
            clip_total - freed
        )


class TestSharedHelper:
    """The helper itself, so "one shared predicate" is a tested claim and
    not just an intention."""

    def test_every_quota_site_goes_through_storage_bytes_query(self):
        import inspect

        from apps.api.routers import admin, folders, projects, site_settings, upload

        for module in (upload, projects, site_settings, admin, folders):
            src = inspect.getsource(module)
            assert "storage_bytes_query" in src, module.__name__
            # And no hand-written copy of the aggregate is left behind.
            assert "func.sum(MediaFile.file_size_bytes)" not in src, module.__name__

    def test_the_predicate_names_both_deleted_at_columns(self):
        from apps.api.services.storage_usage import live_media_filter

        rendered = str(live_media_filter())
        assert "assets.deleted_at IS NULL" in rendered
        assert "asset_versions.deleted_at IS NULL" in rendered
