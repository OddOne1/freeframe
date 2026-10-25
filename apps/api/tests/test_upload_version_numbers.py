"""A deleted version's number is retired, not recycled (§236, item 5).

`initiate_upload` picked the next `version_number` from the asset's
versions `WHERE deleted_at IS NULL`, but `AssetVersion` carries
`UniqueConstraint("asset_id", "version_number")` over EVERY row. So
deleting the latest version made the next upload of that asset reuse its
number and die on the insert.

Reproduced against real Postgres before the fix, by exactly the sequence
in `test_the_next_version_after_deleting_the_latest_one_gets_a_number`:

    psycopg2.errors.UniqueViolation: duplicate key value violates unique
    constraint "uq_asset_versions_asset_version"

— i.e. an unhandled IntegrityError and a 500 for a user who had just
picked a file.

REAL POSTGRES, because that is the only place the constraint exists. The
suite's mocked session has no constraints at all and would report success
for any numbering whatsoever, and `with_for_update()` — the other half of
the fix — is a no-op on SQLite.

    docker run -d --name ff236-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55446:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55446/freeframe \\
      pytest apps/api/tests/test_upload_version_numbers.py

S3 is the only thing stubbed: `create_multipart_upload` returns an id.
"""

import os
import threading
import uuid
from collections import Counter
from datetime import datetime, timezone

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; the "
           "unique constraint being tested does not exist in the mocked session",
)

#: Stands in for the S3 CreateMultipartUpload each request makes while its
#: transaction is open. Non-zero on purpose: the asset row lock is held
#: across it, so an instant stub would hide whether that serialises.
FAKE_S3_SECONDS = 0.2


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="module", autouse=True)
def stub_s3():
    import time

    from apps.api.routers import upload as upload_router

    real = upload_router.create_multipart_upload
    upload_router.create_multipart_upload = (
        lambda key, content_type: (time.sleep(FAKE_S3_SECONDS),
                                   f"upload-{uuid.uuid4()}")[1]
    )
    yield
    upload_router.create_multipart_upload = real


@pytest.fixture
def world(sessionmaker_):
    """A project, its editor, and an asset with two `ready` versions.

    Named rows only, deleted on the way out: this database may be a
    scratch copy of a real one, so nothing here truncates a table.
    """
    from apps.api.models.asset import (Asset, AssetType, AssetVersion, MediaFile,
                                       ProcessingStatus)
    from apps.api.models.project import (Project, ProjectMember, ProjectRole,
                                         ProjectType)
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    session = sessionmaker_()
    editor = User(
        email=f"editor-{uuid.uuid4().hex[:10]}@ff236.test",
        first_name="Editor", last_name="Tester", password_hash="x",
        status=UserStatus.active, role=UserGlobalRole.superadmin,
        email_verified=True,
    )
    session.add(editor)
    session.commit()

    project = Project(name=f"Shoot-{uuid.uuid4().hex[:8]}", project_type=ProjectType.personal,
                      created_by=editor.id, created_by_name="Editor Tester")
    session.add(project)
    session.commit()
    session.add(ProjectMember(project_id=project.id, user_id=editor.id,
                              role=ProjectRole.owner))
    session.commit()

    asset = Asset(project_id=project.id, name="A001C002", asset_type=AssetType.video,
                  created_by=editor.id, created_by_name="Editor Tester")
    session.add(asset)
    session.commit()
    for number in (1, 2):
        session.add(AssetVersion(asset_id=asset.id, version_number=number,
                                 processing_status=ProcessingStatus.ready,
                                 created_by=editor.id))
    session.commit()

    bag = {"session": session, "sessionmaker": sessionmaker_, "editor": editor,
           "project": project, "asset": asset}
    try:
        yield bag
    finally:
        session.rollback()
        version_ids = [v.id for v in session.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id).all()]
        if version_ids:
            session.query(MediaFile).filter(
                MediaFile.version_id.in_(version_ids)).delete(synchronize_session=False)
        session.query(AssetVersion).filter(
            AssetVersion.asset_id == asset.id).delete(synchronize_session=False)
        session.query(Asset).filter(Asset.id == asset.id).delete(synchronize_session=False)
        session.query(ProjectMember).filter(
            ProjectMember.project_id == project.id).delete(synchronize_session=False)
        session.query(Project).filter(Project.id == project.id).delete(
            synchronize_session=False)
        session.query(User).filter(User.id == editor.id).delete(synchronize_session=False)
        session.commit()
        session.close()


_SAME_ASSET = object()


def _initiate(session, world, asset_id=_SAME_ASSET):
    """The REAL route function, not a copy of its steps."""
    from apps.api.routers import upload as upload_router
    from apps.api.models.user import User
    from apps.api.schemas.upload import InitiateUploadRequest

    user = session.query(User).filter(User.id == world["editor"].id).first()
    body = InitiateUploadRequest(
        project_id=world["project"].id,
        asset_name="A001C002",
        original_filename="A001C002.mov",
        mime_type="video/quicktime",
        file_size_bytes=30 * 1024 * 1024,
        asset_id=world["asset"].id if asset_id is _SAME_ASSET else asset_id,
    )
    return upload_router.initiate_upload(body=body, db=session, current_user=user)


def _numbers(session, asset_id):
    from apps.api.models.asset import AssetVersion

    session.expire_all()
    return sorted(
        (v.version_number, v.deleted_at is not None)
        for v in session.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id).all()
    )


def _soft_delete(session, asset_id, number):
    from apps.api.models.asset import AssetVersion

    row = session.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.version_number == number,
    ).first()
    row.deleted_at = datetime.now(timezone.utc)
    session.commit()


class TestADeletedNumberIsNotReused:
    def test_the_next_version_after_deleting_the_latest_one_gets_a_number(self, world):
        """THE reproduction. Before §236 this raised IntegrityError."""
        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 2)
        assert _numbers(session, asset.id) == [(1, False), (2, True)]

        resp = _initiate(session, world)

        assert _numbers(session, asset.id) == [(1, False), (2, True), (3, False)]
        from apps.api.models.asset import AssetVersion
        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 3

    def test_deleting_every_version_still_moves_forward(self, world):
        """`max()` over all rows, not a count and not a reset to 1."""
        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 1)
        _soft_delete(session, asset.id, 2)

        _initiate(session, world)

        assert _numbers(session, asset.id) == [(1, True), (2, True), (3, False)]

    def test_a_hole_in_the_middle_is_not_filled_in(self, world):
        """v2 deleted while v3 lives: the next upload is v4, because 'v3' in
        somebody's comment has to keep meaning the same upload."""
        from apps.api.models.asset import AssetVersion, ProcessingStatus

        session, asset = world["session"], world["asset"]
        session.add(AssetVersion(asset_id=asset.id, version_number=3,
                                 processing_status=ProcessingStatus.ready,
                                 created_by=world["editor"].id))
        session.commit()
        _soft_delete(session, asset.id, 2)

        _initiate(session, world)

        assert _numbers(session, asset.id) == [
            (1, False), (2, True), (3, False), (4, False),
        ]

    def test_a_brand_new_asset_still_starts_at_one(self, world):
        session = world["session"]

        resp = _initiate(session, world, asset_id=None)

        from apps.api.models.asset import AssetVersion
        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 1
        assert created.asset_id != world["asset"].id

        # Clean up the asset this one created — the fixture only knows about
        # its own.
        from apps.api.models.asset import MediaFile
        from apps.api.models.asset import Asset
        new_asset_id = created.asset_id
        session.query(MediaFile).filter(MediaFile.version_id == created.id).delete(
            synchronize_session=False)
        session.query(AssetVersion).filter(AssetVersion.asset_id == new_asset_id).delete(
            synchronize_session=False)
        session.query(Asset).filter(Asset.id == new_asset_id).delete(
            synchronize_session=False)
        session.commit()


class TestTwoInitiatesAtOnce:
    """Two concurrent new versions of the SAME asset. Both read the highest
    number; without the row lock they read the same one, and one of them
    dies on the insert with a 500 after the user picked a file."""

    def _race(self, world, n=6):
        results = []
        guard = threading.Lock()

        def one():
            session = world["sessionmaker"]()
            try:
                resp = _initiate(session, world)
                from apps.api.models.asset import AssetVersion
                number = session.query(AssetVersion).filter(
                    AssetVersion.id == resp.version_id).first().version_number
                with guard:
                    results.append(("ok", number))
            except BaseException as exc:   # noqa: BLE001 — classifying is the point
                with guard:
                    results.append((type(exc).__name__,
                                    str(exc).split("\n")[0][:140]))
            finally:
                try:
                    session.close()
                except Exception:
                    pass

        threads = [threading.Thread(target=one) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return results

    def test_all_of_them_succeed(self, world):
        results = self._race(world)
        outcomes = Counter(kind for kind, _ in results)
        assert outcomes.get("ok") == 6, (
            f"{dict(outcomes)}: "
            + "; ".join(f"{a}: {b}" for a, b in results if a != "ok")
        )
        assert "IntegrityError" not in outcomes
        assert "HTTPException" not in outcomes

    def test_every_number_is_distinct(self, world):
        results = self._race(world)
        numbers = [n for kind, n in results if kind == "ok"]
        assert sorted(numbers) == [3, 4, 5, 6, 7, 8]

    def test_it_still_works_with_the_latest_version_deleted(self, world):
        """Both halves of the fix at once: the number comes from `max()`
        over all rows AND the readers are serialised."""
        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 2)

        results = self._race(world, n=4)

        assert Counter(k for k, _ in results).get("ok") == 4, results
        assert sorted(n for k, n in results if k == "ok") == [3, 4, 5, 6]
