"""A task that dies on a DB error must still record that it failed (§173).

`build_zip_export` hung in production because of this exact shape: a failed
write left the SQLAlchemy session in an aborted transaction, and the `except`
block then touched the DB again WITHOUT rolling back first. That second
statement raised InFailedSqlTransaction, so the failure status was never
written and the row kept whatever it last committed.

The trap is specific and easy to miss on review: the handler looks correct in
isolation. It only misbehaves when the exception it is handling came from the
database, which is the one case nobody writes a test for.

What these tests assert is that the failure is RECORDED — not merely that
nothing crashes. A test asserting "no exception escapes" would pass against
the broken code for `build_zip_export`, because the broken code did not crash
either; it just silently left the row untouched. That distinction is the whole
point of this file.

Both tasks here run for minutes (ffmpeg transcode, whisper transcription), so
they are MORE exposed to a mid-run database error than the zip build was, not
less.
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.exc import InternalError, OperationalError


class PoisonableSession:
    """A stand-in for a Session that behaves like Postgres actually does.

    A real SQLAlchemy session whose transaction has aborted raises
    InFailedSqlTransaction on EVERY subsequent statement — commit, query, all
    of it — until someone calls rollback(). Reproducing that rule is the whole
    fixture: a MagicMock happily accepts `commit()` on a dead transaction and
    would let the broken code pass.
    """

    def __init__(self, objects):
        self._objects = objects      # {model class: instance}
        self.poisoned = False
        self.rollbacks = 0
        self.commits = 0
        self.closed = False

    # -- the rule under test -------------------------------------------------
    def _guard(self):
        if self.poisoned:
            raise InternalError(
                "current transaction is aborted, commands ignored until end of "
                "transaction block", None, None,
            )

    def commit(self):
        self._guard()
        self.commits += 1

    def query(self, model):
        self._guard()
        result = MagicMock()
        result.filter.return_value.first.return_value = self._objects.get(model)
        result.filter.return_value.all.return_value = []
        return result

    def rollback(self):
        # The one operation that is legal on an aborted transaction, and the
        # only thing that makes the session usable again.
        self.poisoned = False
        self.rollbacks += 1

    def add(self, _obj):
        self._guard()

    def refresh(self, _obj):
        self._guard()

    def close(self):
        self.closed = True

    # -- what a failing DB write does to the session -------------------------
    def poison_and_raise(self):
        """Exactly what a real failed statement leaves behind."""
        self.poisoned = True
        raise OperationalError("server closed the connection unexpectedly", None, None)


def test_the_fixture_itself_models_a_poisoned_session():
    """Guards the guard. If this fixture were lenient, every test below would
    pass against broken code — which is the failure mode this file exists to
    prevent."""
    s = PoisonableSession({})
    with pytest.raises(OperationalError):
        s.poison_and_raise()
    with pytest.raises(InternalError):
        s.commit()
    with pytest.raises(InternalError):
        s.query(object)
    s.rollback()
    s.commit()  # usable again
    assert s.rollbacks == 1


# ─── transcode: process_asset ────────────────────────────────────────────────

def _transcode_world():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus,
    )
    from apps.api.models.project import Project

    project = Project(id=uuid.uuid4(), name="P")
    asset = Asset(
        id=uuid.uuid4(), project_id=project.id, name="a.mov",
        asset_type=AssetType.video,
    )
    version = AssetVersion(
        id=uuid.uuid4(), asset_id=asset.id, version_number=1,
        processing_status=ProcessingStatus.processing,
    )
    media_file = MediaFile(
        id=uuid.uuid4(), version_id=version.id, original_filename="a.mov",
        mime_type="video/quicktime", file_size_bytes=1, s3_key_raw="raw/a.mov",
    )
    db = PoisonableSession({
        AssetVersion: version, Asset: asset, MediaFile: media_file, Project: project,
    })
    return db, asset, version


def _run_transcode(db, asset, version):
    from apps.api.tasks import transcode_tasks

    with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
         patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
         patch.object(transcode_tasks, "prefix_for_project", return_value="p"), \
         patch.object(transcode_tasks, "_publish_event"), \
         patch.object(transcode_tasks, "_process_video",
                      side_effect=lambda *a, **k: db.poison_and_raise()), \
         patch.object(transcode_tasks.process_asset, "retry",
                      side_effect=RuntimeError("retry called")):
        with pytest.raises(Exception) as caught:
            transcode_tasks.process_asset.run(str(asset.id), str(version.id))
    return caught.value


def test_transcode_records_failure_after_a_database_error():
    """The headline. A DB error mid-transcode must still land as `failed`.

    Without the rollback the status write raises InFailedSqlTransaction, the
    version stays at `processing`, and the only thing that ever resolves it is
    §114's stuck-processing sweeper — minutes to hours later, if at all.
    """
    from apps.api.models.asset import ProcessingStatus

    db, asset, version = _transcode_world()
    _run_transcode(db, asset, version)

    assert db.rollbacks >= 1, "the handler touched the DB without rolling back first"
    assert version.processing_status == ProcessingStatus.failed, (
        "the failure was never recorded: the version is still 'processing', so "
        "nothing downstream can tell this transcode died"
    )


def test_transcode_still_retries_rather_than_dying_on_its_own_handler():
    """The original error must survive the handler.

    If recording the failure raises, that new exception replaces the original
    AND `self.retry` never runs — so a transient DB blip becomes a permanent
    failure instead of a retried one.
    """
    db, asset, version = _transcode_world()
    exc = _run_transcode(db, asset, version)

    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"expected the task to reach self.retry, but it raised {exc!r} from its "
        "own failure handler instead"
    )


# ─── transcription: transcribe_asset ─────────────────────────────────────────

def _transcribe_world():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus,
    )

    asset = Asset(
        id=uuid.uuid4(), project_id=uuid.uuid4(), name="a.mov",
        asset_type=AssetType.video,
        # §127's durable re-check returns early without it, so the task would
        # never reach the handler under test.
        transcription_enabled=True,
    )
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1)
    media_file = MediaFile(
        id=uuid.uuid4(), version_id=version.id, original_filename="a.mov",
        mime_type="video/quicktime", file_size_bytes=1, s3_key_raw="raw/a.mov",
        transcription_status=TranscriptionStatus.processing,
    )
    db = PoisonableSession({AssetVersion: version, Asset: asset, MediaFile: media_file})
    return db, asset, version, media_file


def _run_transcribe(db, asset, version):
    from apps.api.tasks import transcribe_tasks

    with patch.object(transcribe_tasks, "SessionLocal", return_value=db), \
         patch.object(transcribe_tasks, "get_s3_client", return_value=MagicMock()), \
         patch.object(transcribe_tasks, "_publish_event"), \
         patch.object(transcribe_tasks, "_extract_audio",
                      side_effect=lambda *a, **k: db.poison_and_raise()), \
         patch.object(transcribe_tasks.transcribe_asset, "retry",
                      side_effect=RuntimeError("retry called")):
        with pytest.raises(Exception) as caught:
            transcribe_tasks.transcribe_asset.run(str(asset.id), str(version.id))
    return caught.value


def test_transcription_records_failure_after_a_database_error():
    from apps.api.models.asset import TranscriptionStatus

    db, asset, version, media_file = _transcribe_world()
    _run_transcribe(db, asset, version)

    assert db.rollbacks >= 1, "the handler touched the DB without rolling back first"
    assert media_file.transcription_status == TranscriptionStatus.failed, (
        "the failure was never recorded: transcription_status is still "
        "'processing', so the per-file toggle and the UI both keep showing a "
        "run that is already dead"
    )


def test_transcription_still_retries_rather_than_dying_on_its_own_handler():
    db, asset, version, media_file = _transcribe_world()
    exc = _run_transcribe(db, asset, version)

    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"expected the task to reach self.retry, but it raised {exc!r} from its "
        "own failure handler instead"
    )


# ─── when even the rollback cannot run ───────────────────────────────────────

class DeadSession(PoisonableSession):
    """The connection is gone, not merely the transaction.

    Rollback is normally the one thing that still works on a broken session.
    It does not when the socket itself is dead — and at that point nothing can
    record the failure. What must still hold is that the ORIGINAL error
    survives and the task retries, rather than the handler's own failure
    replacing it and turning a transient outage into a permanent one.
    """

    def rollback(self):
        self.rollbacks += 1
        raise OperationalError("server closed the connection unexpectedly", None, None)


def test_transcode_retries_even_when_the_rollback_itself_fails():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus,
    )
    from apps.api.models.project import Project

    project = Project(id=uuid.uuid4(), name="P")
    asset = Asset(id=uuid.uuid4(), project_id=project.id, name="a.mov",
                  asset_type=AssetType.video)
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.processing)
    media_file = MediaFile(id=uuid.uuid4(), version_id=version.id,
                           original_filename="a.mov", mime_type="video/quicktime",
                           file_size_bytes=1, s3_key_raw="raw/a.mov")
    db = DeadSession({AssetVersion: version, Asset: asset,
                      MediaFile: media_file, Project: project})

    exc = _run_transcode(db, asset, version)

    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"the handler's own failure escaped as {exc!r}, losing the real error "
        "and skipping the retry"
    )


def test_transcription_retries_even_when_the_rollback_itself_fails():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus,
    )

    asset = Asset(id=uuid.uuid4(), project_id=uuid.uuid4(), name="a.mov",
                  asset_type=AssetType.video, transcription_enabled=True)
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1)
    media_file = MediaFile(id=uuid.uuid4(), version_id=version.id,
                           original_filename="a.mov", mime_type="video/quicktime",
                           file_size_bytes=1, s3_key_raw="raw/a.mov",
                           transcription_status=TranscriptionStatus.processing)
    db = DeadSession({AssetVersion: version, Asset: asset, MediaFile: media_file})

    exc = _run_transcribe(db, asset, version)

    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"the handler's own failure escaped as {exc!r}, losing the real error "
        "and skipping the retry"
    )


# ─── the ordering inside the handler ─────────────────────────────────────────

class ExpiringAsset:
    """Models what rollback() does to a loaded instance.

    SQLAlchemy expires every object in the session on rollback, so the next
    attribute read issues a fresh SELECT. That is harmless when only the
    transaction was aborted — but when the CONNECTION is what died, the SELECT
    raises, and here it would raise outside the handler's recording block,
    replacing the real error and skipping the retry.

    So `project_id` has to be read before the rollback, and this is what makes
    that ordering testable rather than merely asserted in a comment.
    """

    def __init__(self, asset, db):
        object.__setattr__(self, "_asset", asset)
        object.__setattr__(self, "_db", db)

    def __getattr__(self, name):
        db = object.__getattribute__(self, "_db")
        if name == "project_id" and db.rollbacks:
            raise OperationalError(
                "server closed the connection unexpectedly", None, None
            )
        return getattr(object.__getattribute__(self, "_asset"), name)


def test_transcode_reads_the_project_id_before_rolling_back():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus,
    )
    from apps.api.models.project import Project

    project = Project(id=uuid.uuid4(), name="P")
    real = Asset(id=uuid.uuid4(), project_id=project.id, name="a.mov",
                 asset_type=AssetType.video)
    version = AssetVersion(id=uuid.uuid4(), asset_id=real.id, version_number=1,
                           processing_status=ProcessingStatus.processing)
    media_file = MediaFile(id=uuid.uuid4(), version_id=version.id,
                           original_filename="a.mov", mime_type="video/quicktime",
                           file_size_bytes=1, s3_key_raw="raw/a.mov")
    db = PoisonableSession({AssetVersion: version, MediaFile: media_file,
                            Project: project})
    db._objects[Asset] = ExpiringAsset(real, db)

    exc = _run_transcode(db, real, version)

    assert version.processing_status == ProcessingStatus.failed
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"raised {exc!r} instead of retrying — the project id was read after "
        "the rollback, when the instance had been expired"
    )


def test_transcription_reads_the_project_id_before_rolling_back():
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus,
    )

    real = Asset(id=uuid.uuid4(), project_id=uuid.uuid4(), name="a.mov",
                 asset_type=AssetType.video, transcription_enabled=True)
    version = AssetVersion(id=uuid.uuid4(), asset_id=real.id, version_number=1)
    media_file = MediaFile(id=uuid.uuid4(), version_id=version.id,
                           original_filename="a.mov", mime_type="video/quicktime",
                           file_size_bytes=1, s3_key_raw="raw/a.mov",
                           transcription_status=TranscriptionStatus.processing)
    db = PoisonableSession({AssetVersion: version, MediaFile: media_file})
    db._objects[Asset] = ExpiringAsset(real, db)

    exc = _run_transcribe(db, real, version)

    assert media_file.transcription_status == TranscriptionStatus.failed
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc), (
        f"raised {exc!r} instead of retrying — the project id was read after "
        "the rollback, when the instance had been expired"
    )
