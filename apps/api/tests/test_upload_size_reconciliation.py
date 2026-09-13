"""The stored file size is the object's, not the client's claim (§180).

`file_size_bytes` was written at /upload/initiate from a number the browser
sent and never corrected. Both storage-quota checks in upload.py and every
storage figure in the admin UI are sums of that column, so a client that
under-reported walked straight past a quota, and one that over-reported
could be refused an upload that would have fit.

The fake S3 here returns a size that has NO relationship to anything the
caller passes in — a stub that echoed the declared number back would let a
completely unreconciled implementation pass. The real proof that this reads
from S3 at all is the live-MinIO run in scripts/; see its docstring.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.asset import MediaFile

DECLARED = 10 * 1024 * 1024      # what the client said
ACTUAL = 4_237_913               # what is really in the bucket
S3_KEY = "raw/proj/asset/version/original.mov"


def _media_file(declared=DECLARED, key=S3_KEY):
    mf = MagicMock(spec=MediaFile)
    mf.file_size_bytes = declared
    mf.s3_key_raw = key
    mf.size_verified_at = None
    return mf


def _reconcile(media_file, sizes):
    """Run the real reconciliation with a scripted head_object_size.

    `sizes` is what each successive call does: an int to return, or an
    exception instance to raise.
    """
    from apps.api.routers import upload as upload_router

    calls = []

    def fake_head(key):
        calls.append(key)
        result = sizes[min(len(calls) - 1, len(sizes) - 1)]
        if isinstance(result, Exception):
            raise result
        return result

    with patch.object(upload_router, "head_object_size", fake_head):
        upload_router._reconcile_file_size(media_file)
    return calls


# ── the correction itself ───────────────────────────────────────────────────

def test_an_under_reported_size_is_corrected_upwards():
    """The quota-bypass direction: claim 1 MB, upload 4 MB."""
    mf = _media_file(declared=1024 * 1024)

    _reconcile(mf, [ACTUAL])

    assert mf.file_size_bytes == ACTUAL


def test_an_over_reported_size_is_corrected_downwards():
    """The other direction is a real bug too — it refuses uploads that fit."""
    mf = _media_file(declared=900 * 1024 ** 3)

    _reconcile(mf, [ACTUAL])

    assert mf.file_size_bytes == ACTUAL


def test_the_stored_value_does_not_depend_on_what_the_client_declared():
    """Two rows claiming wildly different sizes for the same object end up
    identical. An implementation that trusted its input could not."""
    small = _media_file(declared=1)
    huge = _media_file(declared=10 ** 12)

    _reconcile(small, [ACTUAL])
    _reconcile(huge, [ACTUAL])

    assert small.file_size_bytes == huge.file_size_bytes == ACTUAL


def test_a_correct_declaration_is_left_as_it_was():
    mf = _media_file(declared=ACTUAL)

    _reconcile(mf, [ACTUAL])

    assert mf.file_size_bytes == ACTUAL
    assert mf.size_verified_at is not None


def test_a_verified_row_is_stamped():
    mf = _media_file()

    _reconcile(mf, [ACTUAL])

    assert isinstance(mf.size_verified_at, datetime)
    assert mf.size_verified_at.tzinfo is not None


def test_the_server_generated_key_is_what_gets_checked():
    """NOT `body.s3_key`, which the client also supplies. Reconciling
    against a client-chosen key would check the number against whatever
    object the client pointed at."""
    mf = _media_file(key="raw/real/server/key.mov")

    calls = _reconcile(mf, [ACTUAL])

    assert calls == ["raw/real/server/key.mov"]


# ── the failure path ────────────────────────────────────────────────────────

def test_a_transient_failure_is_retried_once_and_succeeds():
    mf = _media_file()

    calls = _reconcile(mf, [ConnectionError("blip"), ACTUAL])

    assert len(calls) == 2
    assert mf.file_size_bytes == ACTUAL
    assert mf.size_verified_at is not None


def test_a_persistent_failure_gives_up_after_two_attempts():
    """Not four, not forever: this runs inside a request the user is waiting
    on, and a bucket that is genuinely unreachable will not answer later in
    the same second either."""
    mf = _media_file()

    calls = _reconcile(mf, [ConnectionError("down")])

    assert len(calls) == 2


def test_a_persistent_failure_leaves_the_row_flagged_for_backfill():
    mf = _media_file()

    _reconcile(mf, [ConnectionError("down")])

    # NULL is the work queue: `WHERE size_verified_at IS NULL`.
    assert mf.size_verified_at is None


def test_a_persistent_failure_does_not_invent_a_size():
    """Zeroing it, or writing None, would corrupt every storage total that
    sums this column. The unverified number stays until something can do
    better."""
    mf = _media_file()

    _reconcile(mf, [ConnectionError("down")])

    assert mf.file_size_bytes == DECLARED


def test_a_missing_object_is_a_failure_not_a_zero():
    """A 404 here means the object this row describes is not there — which
    must not be recorded as a file of zero bytes."""
    mf = _media_file()

    _reconcile(mf, [KeyError("NoSuchKey")])

    assert mf.file_size_bytes == DECLARED
    assert mf.size_verified_at is None


def test_the_upload_is_not_failed_by_an_unverifiable_size():
    """The bytes are already in S3 and the multipart is already completed.
    Raising here would throw away a good file to protect a number."""
    from apps.api.routers import upload as upload_router

    mf = _media_file()
    with patch.object(upload_router, "head_object_size", side_effect=ConnectionError("down")):
        upload_router._reconcile_file_size(mf)  # must not raise


# ── it is actually wired into the request ───────────────────────────────────

class TestCompleteUploadWiring:
    """The function above is inert unless /upload/complete calls it, and
    unless it does so before the commit."""

    def _run(self, mock_db, media_file, head=ACTUAL):
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import CompleteUploadRequest

        version = MagicMock()
        version.id = uuid.uuid4()
        version.created_by = uuid.uuid4()

        # The version lookup and the media-file lookup both go through
        # db.query(...).filter(...).first().
        results = [version, media_file]
        mock_db.query.return_value.filter.return_value.first.side_effect = results

        body = CompleteUploadRequest(
            asset_id=uuid.uuid4(),
            version_id=version.id,
            s3_key="raw/client/said/this.mov",
            upload_id="u-1",
            parts=[{"PartNumber": 1, "ETag": "e"}],
        )

        user = MagicMock()
        user.id = version.created_by

        with patch.object(upload_router, "complete_multipart_upload") as cmu, \
             patch.object(upload_router, "head_object_size", return_value=head) as hos:
            upload_router.complete_upload(
                body, MagicMock(), db=mock_db, current_user=user
            )
        return cmu, hos, version

    def test_complete_upload_reconciles_the_row(self, mock_db):
        mf = _media_file()

        self._run(mock_db, mf)

        assert mf.file_size_bytes == ACTUAL

    def test_it_heads_the_stored_key_not_the_one_in_the_request(self, mock_db):
        mf = _media_file(key="raw/server/generated.mov")

        _cmu, hos, _v = self._run(mock_db, mf)

        hos.assert_called_with("raw/server/generated.mov")

    def test_the_corrected_size_is_committed_with_the_status_change(self, mock_db):
        """One commit, so the row never exists in a committed-but-
        unreconciled state for another request's quota check to read."""
        mf = _media_file()

        self._run(mock_db, mf)

        assert mock_db.commit.call_count == 1

    def test_a_row_that_cannot_be_found_does_not_break_completion(self, mock_db):
        """Defensive: no MediaFile means nothing to reconcile, not a 500 on
        an upload whose bytes are already safely stored."""
        self._run(mock_db, None)  # must not raise
