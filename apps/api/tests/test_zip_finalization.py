"""The half of a zip build that happens AFTER the last file is gathered (§147).

A 103-file/13.25GB build reached `files_done=103, file_count=103,
total_bytes=0, status=building` and stayed there. Every file had been
fetched; the hang was entirely in finalization, which no test covered and
which the UI reported nothing about.

Two independent defects lived there, and either alone is fatal on a large
batch:

1. The archive went up via `put_object` — a SINGLE PUT, capped at 5GB by
   the S3 API. Past that the server stops reading a body it has already
   refused while boto3 keeps writing, the socket buffers fill, and the send
   blocks with no timeout. Not a clean rejection: a hang.
2. `zip_exports.total_bytes` was a 4-byte Integer, so `export.total_bytes =
   size` for any archive past 2.1GB raised NumericValueOutOfRange — on the
   very last commit, after the entire build had otherwise succeeded.

The existing happy-path tests missed both because they only ever built
archives of a few hundred bytes, where a single PUT is legal and the size
fits an int. The tests here are written around SIZE and around the upload
CALL, which is what makes them able to fail.
"""

import io
import os
import uuid
import zipfile
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.zip_export import ZipExportStatus


# ─── harness ─────────────────────────────────────────────────────────────────

def _export(n_files: int, payload: bytes = b"x" * 32):
    export = MagicMock()
    export.id = uuid.uuid4()
    export.status = ZipExportStatus.pending
    export.phase = None
    export.file_count = n_files
    export.files_done = 0
    export.total_bytes = 0
    export.bytes_done = 0
    export.s3_key = f"zip-exports/p/link/l/{export.id}.zip"
    export.manifest = [
        {"s3_key": f"raw/{i}.bin", "path": f"f{i}.bin", "needs_render": False}
        for i in range(n_files)
    ]
    export._payload = payload
    return export


class _Body:
    def __init__(self, payload: bytes):
        self._payload = payload
        self._done = False

    def read(self, _n=None):
        if self._done:
            return b""
        self._done = True
        return self._payload


def _client(export, uploads: list):
    """An S3 stub that records how the archive was sent, not just that it was."""
    client = MagicMock()
    client.get_object.side_effect = lambda Bucket=None, Key=None: {
        "Body": _Body(export._payload)
    }

    def upload_fileobj(fh, bucket, key, ExtraArgs=None, Config=None, Callback=None):
        body = fh.read()
        if Callback:
            # A real multipart transfer reports progress in chunks. Feeding it
            # in one lump would let a callback that is never invoked pass.
            step = max(1, len(body) // 4)
            for off in range(0, len(body), step):
                Callback(min(step, len(body) - off))
        uploads.append(
            {"key": key, "bucket": bucket, "body": body,
             "extra": ExtraArgs, "config": Config}
        )

    client.upload_fileobj.side_effect = upload_fileobj
    # put_object is left as a bare MagicMock on purpose: if the code regresses
    # to it, nothing is recorded and every assertion below fails loudly rather
    # than silently passing on a MagicMock's return value.
    return client


def _run(export, client, db=None):
    db = db or MagicMock()
    db.query.return_value.filter.return_value.first.return_value = export
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.zip_tasks.s3_service.get_s3_client", return_value=client), \
         patch("apps.api.tasks.zip_tasks.delete_zip_export"):
        from apps.api.tasks.zip_tasks import build_zip_export
        build_zip_export.run(str(export.id))


# ─── finalization in isolation ───────────────────────────────────────────────

def test_finalization_commits_ready_with_a_valid_archive():
    """The headline: a completed gather must produce a readable zip and `ready`.

    Asserts the bytes actually handed to storage open as a zip and contain
    every member — not merely that the row flipped to ready, which it would
    do just as happily for an empty or truncated upload.
    """
    uploads: list = []
    export = _export(5)
    _run(export, _client(export, uploads))

    assert export.status == ZipExportStatus.ready
    assert len(uploads) == 1, "the archive must be uploaded exactly once"

    z = zipfile.ZipFile(io.BytesIO(uploads[0]["body"]))
    assert sorted(z.namelist()) == sorted(f"f{i}.bin" for i in range(5))
    assert z.testzip() is None, "the uploaded archive is corrupt"
    assert uploads[0]["key"] == export.s3_key
    assert uploads[0]["extra"]["ContentType"] == "application/zip"


def test_the_archive_goes_up_multipart_not_as_one_put():
    """The hang itself. A single PUT over 5GB blocks rather than failing.

    Pinned as "parts stay under the single-PUT ceiling", not as "chunksize
    equals 64MB" — the constant may be tuned, the ceiling is the S3 API's
    and is not ours to move.
    """
    from apps.api.tasks.zip_tasks import _UPLOAD_PART_SIZE

    uploads: list = []
    export = _export(3)
    client = _client(export, uploads)
    _run(export, client)

    assert client.upload_fileobj.called, "must use the multipart-capable transfer"
    assert not client.put_object.called, "a single PUT cannot carry a large archive"

    cfg = uploads[0]["config"]
    assert cfg is not None, "no TransferConfig means boto3's defaults, unpinned"
    single_put_ceiling = 5 * 1024 ** 3
    assert cfg.multipart_chunksize <= single_put_ceiling
    assert cfg.multipart_threshold <= single_put_ceiling
    assert _UPLOAD_PART_SIZE <= single_put_ceiling

    # 10,000 parts is the S3 maximum. At this part size the ceiling on one
    # archive is what that multiplies out to -- assert it clears the batch
    # that prompted this fix by a real margin.
    assert _UPLOAD_PART_SIZE * 10_000 > 100 * 1024 ** 3


def test_total_bytes_is_set_before_the_upload_not_after():
    """`total_bytes=0` next to a full file count was the whole diagnostic trail.

    Setting it first is what lets a stuck build say which half it is stuck in.
    """
    seen = {}
    uploads: list = []
    export = _export(3)
    client = _client(export, uploads)

    def upload_fileobj(fh, bucket, key, ExtraArgs=None, Config=None, Callback=None):
        seen["total_bytes"] = export.total_bytes
        seen["phase"] = export.phase
        uploads.append({"body": fh.read(), "config": Config, "key": key,
                        "extra": ExtraArgs})

    client.upload_fileobj.side_effect = upload_fileobj
    _run(export, client)

    assert seen["total_bytes"] > 0, "size must be known and published before sending"
    assert seen["phase"] == "uploading"


def test_phase_reports_which_half_is_running_and_clears_when_done():
    phases: list = []
    uploads: list = []
    export = _export(3)
    client = _client(export, uploads)

    def get_object(Bucket=None, Key=None):
        phases.append(export.phase)
        return {"Body": _Body(export._payload)}

    client.get_object.side_effect = get_object
    _run(export, client)

    assert phases and set(phases) == {"gathering"}, \
        "the fetch loop must run under the gathering phase"
    assert export.phase is None, "a finished build is in neither phase"


def test_upload_progress_is_reported_so_a_long_send_is_not_a_frozen_bar():
    """Without this the UI showed '103 of 103' for the entire upload.

    It also matters to the server: staleness is measured against progress, so
    an upload that reported nothing for 25 minutes would be declared wedged
    while working perfectly.

    Calls `_upload_archive` DIRECTLY. Going through the whole task instead
    proves nothing here: the success path assigns `bytes_done = size` at the
    end regardless, so an upload reporting nothing the entire way still ends
    on the right number. (That is not hypothetical -- it is exactly how the
    first version of this test passed with the progress callback removed.)
    The return value is the only thing that reflects what was actually
    observed in flight.
    """
    import tempfile

    from apps.api.tasks import zip_tasks

    payload = b"y" * 4096
    with tempfile.NamedTemporaryFile(delete=False) as fh:
        fh.write(payload)
        zip_path = fh.name

    seen_callback = {}

    client = MagicMock()

    def upload_fileobj(fh_, bucket, key, ExtraArgs=None, Config=None, Callback=None):
        seen_callback["given"] = Callback is not None
        body = fh_.read()
        step = max(1, len(body) // 8)
        for off in range(0, len(body), step):
            if Callback:
                Callback(min(step, len(body) - off))

    client.upload_fileobj.side_effect = upload_fileobj

    export = _export(1)
    db = MagicMock()
    try:
        acknowledged = zip_tasks._upload_archive(
            db, export, client, zip_path, len(payload), str(export.id)
        )
    finally:
        os.unlink(zip_path)

    assert seen_callback.get("given"), "the transfer was given no progress callback"
    assert acknowledged == len(payload), (
        f"only {acknowledged} of {len(payload)} bytes were reported in flight -- "
        "a long upload would show no movement at all"
    )


def test_upload_progress_reaches_the_database_while_the_send_is_running():
    """The monitor thread, which is what staleness detection actually reads.

    The callback fires on the transfer's own worker threads, so the value it
    accumulates has to reach Postgres by some other route; a SQLAlchemy
    Session cannot be shared across those threads. This asserts the monitor
    both writes and carries a real byte count -- and that it writes DURING
    the upload, not once at the end.
    """
    import tempfile
    import time as _time

    from apps.api.tasks import zip_tasks

    payload = b"z" * 8192
    with tempfile.NamedTemporaryFile(delete=False) as fh:
        fh.write(payload)
        zip_path = fh.name

    client = MagicMock()

    def upload_fileobj(fh_, bucket, key, ExtraArgs=None, Config=None, Callback=None):
        body = fh_.read()
        half = len(body) // 2
        Callback(half)
        # Long enough for at least one monitor tick at the patched interval,
        # while the upload is still in flight.
        _time.sleep(0.25)
        Callback(len(body) - half)

    client.upload_fileobj.side_effect = upload_fileobj

    monitor_db = MagicMock()
    export = _export(1)
    with patch.object(zip_tasks, "_UPLOAD_PROGRESS_INTERVAL_S", 0.02), \
         patch.object(zip_tasks, "SessionLocal", return_value=monitor_db):
        try:
            zip_tasks._upload_archive(
                MagicMock(), export, client, zip_path, len(payload), str(export.id)
            )
        finally:
            os.unlink(zip_path)

    writes = monitor_db.query.return_value.filter.return_value.update.call_args_list
    assert writes, "no progress was ever persisted during the upload"
    recorded = [c.args[0]["bytes_done"] for c in writes if c.args and "bytes_done" in c.args[0]]
    assert recorded, "the progress write carried no byte count"
    assert max(recorded) > 0


def test_a_failed_upload_fails_the_row_rather_than_leaving_it_building():
    uploads: list = []
    export = _export(3)
    client = _client(export, uploads)
    client.upload_fileobj.side_effect = RuntimeError("storage refused the archive")

    with patch("apps.api.tasks.zip_tasks.build_zip_export.retry",
               side_effect=RuntimeError("retry")):
        with pytest.raises(Exception):
            _run(export, client)

    assert export.status == ZipExportStatus.failed
    assert export.phase is None, "a failed build must not look like it is still uploading"


# ─── the size ceiling, against a real column ─────────────────────────────────

PG_URL = os.environ.get("TEST_DATABASE_URL")


@pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL; a column's integer width is not something "
           "a mock session can express -- which is why this went unnoticed",
)
def test_a_multi_gigabyte_size_can_actually_be_stored():
    """The second defect, and the one no mock could ever have caught.

    A MagicMock accepts `export.total_bytes = 14_227_000_000` without
    complaint. Postgres, with the column as Integer, raised
    NumericValueOutOfRange and failed a build that had already done all of
    its work.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from apps.api.models.project import Project
    from apps.api.models.zip_export import ZipExport

    engine = create_engine(PG_URL)
    session = sessionmaker(bind=engine)()
    project = Project(name="Zip Size Test %s" % uuid.uuid4().hex[:8])
    session.add(project)
    session.commit()
    try:
        thirteen_gb = 13.25 * 1024 ** 3
        row = ZipExport(
            cache_key="a" * 64,
            project_id=project.id,
            s3_key="zip-exports/size-test.zip",
            file_count=103,
            files_done=103,
            total_bytes=int(thirteen_gb),
            bytes_done=int(thirteen_gb),
        )
        session.add(row)
        session.commit()          # this is the line that used to raise
        session.expire_all()

        stored = session.query(ZipExport).filter(ZipExport.id == row.id).one()
        assert stored.total_bytes == int(thirteen_gb)
        assert stored.total_bytes > 2_147_483_647, \
            "the value must exceed what the old 4-byte column could hold"
    finally:
        session.rollback()
        session.query(ZipExport).filter(ZipExport.project_id == project.id).delete(
            synchronize_session=False
        )
        session.query(Project).filter(Project.id == project.id).delete(
            synchronize_session=False
        )
        session.commit()
        session.close()


# ─── the failure that could not report itself ────────────────────────────────

def test_a_database_error_still_marks_the_row_failed():
    """Why the reported build sat at "building" forever rather than "failed".

    The build died on a DB error (assigning a 13.25GB size to a 4-byte
    column). That poisons the session: every later statement on it raises
    InFailedSqlTransaction — INCLUDING the handler's own attempt to record
    the failure, whose `except` then swallowed the reason. So the row kept
    the last status it managed to commit, "building", and the client polled
    a row that would never change.

    Rolling back before writing is what makes any DB-level failure
    reportable at all, so this is not specific to the overflow that exposed
    it.
    """
    from sqlalchemy.exc import InternalError

    export = _export(2)
    uploads: list = []
    client = _client(export, uploads)

    poisoned = {"on": False}
    recorded = {}

    db = MagicMock()

    def query(*_a, **_k):
        if poisoned["on"]:
            raise InternalError("current transaction is aborted", None, None)
        result = MagicMock()
        result.filter.return_value.first.return_value = export
        return result

    def commit():
        # The real failure: committing the oversized size blows up, and the
        # session stays unusable until someone rolls back.
        if export.total_bytes and export.total_bytes > 2_147_483_647:
            poisoned["on"] = True
            raise InternalError("integer out of range", None, None)

    def rollback():
        poisoned["on"] = False
        recorded["rolled_back"] = True

    db.query.side_effect = query
    db.commit.side_effect = commit
    db.rollback.side_effect = rollback

    # An archive whose size exceeds what the old column could hold.
    with patch("apps.api.tasks.zip_tasks.os.path.getsize", return_value=13 * 1024 ** 3), \
         patch("apps.api.tasks.zip_tasks.build_zip_export.retry",
               side_effect=RuntimeError("retry")):
        with pytest.raises(Exception):
            _run(export, client, db=db)

    assert recorded.get("rolled_back"), (
        "the handler never rolled back, so its own write ran on a poisoned "
        "session and the row keeps whatever status it last committed"
    )
    assert export.status == ZipExportStatus.failed, (
        "a build that died must not be left reading as 'building' — that is "
        "a row the client polls forever"
    )
