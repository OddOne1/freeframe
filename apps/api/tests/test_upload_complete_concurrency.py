"""Two completes at once dispatch one transcode — and the sweeper agrees (§236).

Two things that can only be shown against a real database:

* **The row lock.** `/upload/complete` checks the version's status and then
  writes it. Without `SELECT ... FOR UPDATE` around the pair, two
  simultaneous calls both read `uploading` and both dispatch
  `process_asset` for the same version — two transcodes writing the same
  output prefix. The mocked session has no locks and no isolation, so it
  would report success for either implementation.

* **§236 requirement C: the sweeper and this endpoint must not disagree.**
  §215's sweep marks an abandoned upload's version `failed`. A /complete
  arriving afterwards must get `upload_failed` and complete NOTHING — not
  a half-completion, not a resurrection. Both are run here for real, in
  order, against the same rows.

Storage is `tests/fake_multipart_store.FakeMultipartStore` (see its
docstring; real S3 is not available in this sandbox). It is shared between
the threads and does its own locking, so "the upload id was consumed once"
is a real, observed fact rather than a stubbed one.

    docker run -d --name ff236-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55446:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55446/freeframe \\
      pytest apps/api/tests/test_upload_complete_concurrency.py
"""

import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.tests.fake_multipart_store import FakeMultipartStore

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a row "
           "lock is not something the mocked session can express",
)

MIB = 1024 * 1024
PART = 16 * MIB
SIZES = {1: PART, 2: PART, 3: 7 * MIB}
DECLARED = sum(SIZES.values())


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def upload(sessionmaker_):
    """One asset, one version at `uploading`, its MediaFile, and a store
    holding all three parts of the declared file."""
    from apps.api.models.asset import (Asset, AssetType, AssetVersion, FileType,
                                       MediaFile, ProcessingStatus)
    from apps.api.models.project import (Project, ProjectMember, ProjectRole,
                                         ProjectType)
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    session = sessionmaker_()
    editor = User(email=f"editor-{uuid.uuid4().hex[:10]}@ff236.test",
                  first_name="Editor", last_name="Tester", password_hash="x",
                  status=UserStatus.active, role=UserGlobalRole.superadmin,
                  email_verified=True)
    session.add(editor)
    session.commit()
    project = Project(name=f"Shoot-{uuid.uuid4().hex[:8]}",
                      project_type=ProjectType.personal, created_by=editor.id)
    session.add(project)
    session.commit()
    session.add(ProjectMember(project_id=project.id, user_id=editor.id,
                              role=ProjectRole.owner))
    asset = Asset(project_id=project.id, name="A001C002",
                  asset_type=AssetType.video, created_by=editor.id)
    session.add(asset)
    session.commit()
    version = AssetVersion(asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.uploading,
                           created_by=editor.id)
    session.add(version)
    session.commit()
    key = f"raw/2026-01-02_shoot_{project.id}/{asset.id}/{version.id}/original.mov"
    media_file = MediaFile(version_id=version.id, file_type=FileType.video,
                           original_filename="A001C002.mov",
                           mime_type="video/quicktime",
                           file_size_bytes=DECLARED, s3_key_raw=key)
    session.add(media_file)
    session.commit()

    store = FakeMultipartStore()
    upload_id = "u-concurrent"
    store.seed_upload(key, upload_id, SIZES)

    bag = {"sessionmaker": sessionmaker_, "session": session, "editor": editor,
           "project": project, "asset": asset, "version": version,
           "media_file": media_file, "key": key, "upload_id": upload_id,
           "store": store}
    try:
        yield bag
    finally:
        session.rollback()
        session.query(MediaFile).filter(MediaFile.version_id == version.id).delete(
            synchronize_session=False)
        session.query(AssetVersion).filter(AssetVersion.asset_id == asset.id).delete(
            synchronize_session=False)
        session.query(Asset).filter(Asset.id == asset.id).delete(
            synchronize_session=False)
        session.query(ProjectMember).filter(
            ProjectMember.project_id == project.id).delete(synchronize_session=False)
        session.query(Project).filter(Project.id == project.id).delete(
            synchronize_session=False)
        session.query(User).filter(User.id == editor.id).delete(
            synchronize_session=False)
        session.commit()
        session.close()


def _complete(upload, session, dispatches, guard, results):
    """The REAL route function, on its own session."""
    from apps.api.routers import upload as upload_router
    from apps.api.models.user import User
    from apps.api.schemas.upload import CompleteUploadRequest

    version = upload["version"]
    background = MagicMock()
    try:
        user = session.query(User).filter(User.id == upload["editor"].id).first()
        body = CompleteUploadRequest(
            s3_key=upload["key"], upload_id=upload["upload_id"],
            asset_id=version.asset_id, version_id=version.id,
            parts=[{"PartNumber": n, "ETag": f'"client-{n}"'} for n in (1, 2, 3)],
        )
        with patch("apps.api.services.s3_service.get_s3_client",
                   return_value=upload["store"]):
            resp = upload_router.complete_upload(
                body, background, db=session, current_user=user
            )
        with guard:
            results.append(("ok", resp.status))
            dispatches.extend(
                call.args[1:] for call in background.add_task.call_args_list
                if call.args and call.args[0] is upload_router._trigger_processing
            )
    except BaseException as exc:   # noqa: BLE001 — classifying the failure is the point
        with guard:
            results.append((type(exc).__name__,
                            getattr(exc, "status_code", None) or
                            str(exc).split("\n")[0][:120]))
    finally:
        try:
            session.close()
        except Exception:
            pass


class TestTwoCompletesAtOnce:
    def _race(self, upload, n=2):
        dispatches, results = [], []
        guard = threading.Lock()
        sessions = [upload["sessionmaker"]() for _ in range(n)]
        threads = [
            threading.Thread(target=_complete,
                             args=(upload, s, dispatches, guard, results))
            for s in sessions
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return results, dispatches

    def test_exactly_one_transcode_is_dispatched(self, upload):
        """THE assertion. Two transcodes for one version write the same
        `processed/{project}/{asset}/{version}` prefix at the same time."""
        results, dispatches = self._race(upload)

        assert [kind for kind, _ in results] == ["ok", "ok"], results
        assert len(dispatches) == 1, (
            f"{len(dispatches)} dispatches for one version: {dispatches}"
        )
        assert dispatches[0] == (upload["version"].asset_id, upload["version"].id)

    def test_both_callers_are_told_it_worked(self, upload):
        """Neither of them did anything wrong, and both are a client whose
        upload has in fact completed."""
        results, _ = self._race(upload)

        assert sorted(status for _, status in results) == ["processing", "processing"]

    def test_the_upload_is_completed_once_at_the_store(self, upload):
        self._race(upload)

        assert upload["store"].count("complete_multipart_upload") == 1
        assert upload["store"].objects[upload["key"]] == DECLARED
        assert upload["store"].open_uploads() == []

    def test_the_row_ends_up_processing(self, upload):
        from apps.api.models.asset import ProcessingStatus

        self._race(upload)

        session = upload["session"]
        session.expire_all()
        from apps.api.models.asset import AssetVersion
        row = session.query(AssetVersion).filter(
            AssetVersion.id == upload["version"].id).first()
        assert row.processing_status == ProcessingStatus.processing
        assert row.processing_started_at is None

    def test_six_at_once_is_still_one_dispatch(self, upload):
        """A desktop client that retried while the first call was in flight,
        several times over."""
        results, dispatches = self._race(upload, n=6)

        assert [kind for kind, _ in results] == ["ok"] * 6, results
        assert len(dispatches) == 1, dispatches
        assert upload["store"].count("complete_multipart_upload") == 1


class TestTheSweeperAndCompleteAgree:
    """§236 requirement C. The §215 sweep and this endpoint are two writers
    of the same column, and a version one of them resolved must not be
    half-completed by the other."""

    def _sweep(self, upload, *, uploads, exists):
        """The REAL sweep task, on the real session, with the store faked
        the way `test_upload_sweep.py` fakes it."""
        from apps.api.tasks import upload_sweep_tasks as mod

        session = upload["sessionmaker"]()
        store = upload["store"]

        def fake_list_uploads(prefix):
            return list(uploads)

        def fake_list_parts(key, upload_id, strict=False):
            assert strict is True, "the sweep must ask strictly (§215a)"
            return [
                {"PartNumber": n, "ETag": f'"e{n}"', "Size": s,
                 "LastModified": datetime.now(timezone.utc) - timedelta(days=30)}
                for n, s in sorted(SIZES.items())
            ]

        def fake_abort(key, upload_id):
            store.abort_multipart_upload(Bucket="b", Key=key, UploadId=upload_id)

        def fake_exists(key):
            return bool(exists.get(key, False))

        settings_patches = {
            "upload_sweep_enabled": True, "upload_sweep_dry_run": False,
            "upload_abandon_days": 14, "upload_ghost_grace_hours": 24,
            "upload_sweep_max_aborts": 50,
        }
        with patch.object(mod, "list_multipart_uploads_all", fake_list_uploads), \
             patch.object(mod, "list_multipart_parts", fake_list_parts), \
             patch.object(mod, "abort_multipart_upload", fake_abort), \
             patch.object(mod, "object_exists", fake_exists), \
             patch.object(mod, "SessionLocal", lambda: session):
            started = [patch.object(mod.settings, k, v, create=True)
                       for k, v in settings_patches.items()]
            for pp in started:
                pp.start()
            try:
                return mod.sweep_abandoned_uploads()
            finally:
                for pp in started:
                    pp.stop()

    def _complete_once(self, upload):
        from fastapi import HTTPException

        results, dispatches = [], []
        guard = threading.Lock()
        session = upload["sessionmaker"]()
        _complete(upload, session, dispatches, guard, results)
        return results[0], dispatches

    def test_a_version_the_sweep_failed_gets_upload_failed(self, upload):
        """Pass 1: the open upload has no recent activity, so the sweep
        aborts it and writes `failed`. The client's /complete then arrives."""
        from apps.api.models.asset import AssetVersion, ProcessingStatus

        result = self._sweep(
            upload,
            uploads=[{"Key": upload["key"], "UploadId": upload["upload_id"],
                      "Initiated": datetime.now(timezone.utc) - timedelta(days=30)}],
            exists={},
        )
        assert result["aborted"] == 1
        assert result["versions_failed"] == 1

        session = upload["session"]
        session.expire_all()
        row = session.query(AssetVersion).filter(
            AssetVersion.id == upload["version"].id).first()
        assert row.processing_status == ProcessingStatus.failed

        (kind, detail), dispatches = self._complete_once(upload)

        assert kind == "HTTPException"
        assert detail == 409
        assert dispatches == []
        # And crucially: no half-completion. The sweep already freed the
        # parts, and nothing re-created an object at the key.
        assert upload["key"] not in upload["store"].objects

    def test_a_ghost_row_the_sweep_failed_gets_upload_failed_too(self, upload):
        """Pass 2: nothing open at the store and no object, so the row is a
        ghost and is failed. A late /complete must not revive it."""
        from apps.api.models.asset import AssetVersion, ProcessingStatus

        store = upload["store"]
        store.abort_multipart_upload(Bucket="b", Key=upload["key"],
                                     UploadId=upload["upload_id"])

        # The ghost pass has a grace period (`max(1, grace_hours)`), so a
        # row created a second ago is never a ghost. Backdated rather than
        # waiting it out.
        session = upload["session"]
        session.query(AssetVersion).filter(
            AssetVersion.id == upload["version"].id
        ).update(
            {"created_at": datetime.now(timezone.utc) - timedelta(days=2)},
            synchronize_session=False,
        )
        session.commit()

        result = self._sweep(upload, uploads=[], exists={})
        assert result["ghosts_failed"] >= 1

        session = upload["session"]
        session.expire_all()
        row = session.query(AssetVersion).filter(
            AssetVersion.id == upload["version"].id).first()
        assert row.processing_status == ProcessingStatus.failed

        (kind, detail), dispatches = self._complete_once(upload)
        assert kind == "HTTPException"
        assert detail == 409
        assert dispatches == []

    def test_the_sweep_leaves_a_completed_upload_alone(self, upload):
        """The other direction: /complete first, then the sweep. §215's
        pass 1 only fails a row still claiming `uploading`, and after this
        change the row is `processing` before the response goes out."""
        from apps.api.models.asset import AssetVersion, ProcessingStatus

        (kind, status), dispatches = self._complete_once(upload)
        assert (kind, status) == ("ok", "processing")
        assert len(dispatches) == 1

        # The leftover session is gone (completion consumed it), so the
        # sweep sees a row at `processing` with an object at the key.
        result = self._sweep(
            upload, uploads=[],
            exists={upload["key"]: True},
        )
        assert result["versions_failed"] == 0
        assert result["ghosts_failed"] == 0

        session = upload["session"]
        session.expire_all()
        row = session.query(AssetVersion).filter(
            AssetVersion.id == upload["version"].id).first()
        assert row.processing_status == ProcessingStatus.processing
