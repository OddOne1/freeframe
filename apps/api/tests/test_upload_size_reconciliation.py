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
    unless it does so before the commit.

    §236 CHANGED WHAT THIS CLASS CAN SAY. /upload/complete no longer takes
    the request's word for anything: the body's `s3_key` must be the
    version's own key and its `asset_id` must be the version's asset, the
    version has to be `uploading`, and the part list is read from the
    store. So the world each of these runs in is now a CONSISTENT one, and
    the two §180 properties are asserted inside it:

      * the size written is the one S3 reports, and
      * the key HEADed is the row's, not the request's.

    The second one used to be shown by sending a *different* key in the
    body and watching the HEAD ignore it. That request is now a 404 before
    it reaches any of this, which is a stronger version of the same
    guarantee — so it is asserted as a refusal below, and the HEAD's key is
    asserted directly.
    """

    def _run(self, mock_db, media_file, head=ACTUAL, key=None, asset_id=None,
             status=None):
        from apps.api.models.asset import ProcessingStatus
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import CompleteUploadRequest

        version = MagicMock()
        version.id = uuid.uuid4()
        version.asset_id = uuid.uuid4()
        version.created_by = uuid.uuid4()
        version.processing_status = status or ProcessingStatus.uploading
        version.deleted_at = None
        if media_file is not None:
            media_file.version_id = version.id

        # The version lookup and the media-file lookup both go through
        # db.query(...).filter(...).first().
        results = [version, media_file]
        mock_db.query.return_value.filter.return_value.first.side_effect = results

        body = CompleteUploadRequest(
            asset_id=asset_id or version.asset_id,
            version_id=version.id,
            s3_key=key if key is not None else getattr(media_file, "s3_key_raw", S3_KEY),
            upload_id="u-1",
            parts=[{"PartNumber": 1, "ETag": "e"}],
        )

        user = MagicMock()
        user.id = version.created_by

        # §236 — the store's list is what gets completed, so it has to
        # describe the whole declared file for the happy path to run.
        declared = getattr(media_file, "file_size_bytes", DECLARED) or DECLARED
        listed = [{"PartNumber": 1, "ETag": '"e1"', "Size": declared,
                   "LastModified": None}]

        with patch.object(upload_router, "list_multipart_parts", return_value=listed), \
             patch.object(upload_router, "complete_multipart_upload") as cmu, \
             patch.object(upload_router, "head_object_size", return_value=head) as hos:
            upload_router.complete_upload(
                body, MagicMock(), db=mock_db, current_user=user
            )
        return cmu, hos, version

    def test_complete_upload_reconciles_the_row(self, mock_db):
        mf = _media_file()

        self._run(mock_db, mf)

        assert mf.file_size_bytes == ACTUAL

    def test_it_heads_the_stored_key(self, mock_db):
        """NOT a key out of the request — which §236 refuses outright (see
        the test below), so the only key left to HEAD is the row's."""
        mf = _media_file(key="raw/server/generated.mov")

        _cmu, hos, _v = self._run(mock_db, mf)

        hos.assert_called_with("raw/server/generated.mov")

    def test_a_request_naming_another_key_is_refused_before_anything_runs(
        self, mock_db
    ):
        """§236 — the §180 docstring's "reconciling against a client-chosen
        key would check a number against whatever object the client pointed
        at" is now unreachable, because the request cannot name one."""
        from fastapi import HTTPException

        mf = _media_file(key="raw/server/generated.mov")
        with pytest.raises(HTTPException) as caught:
            self._run(mock_db, mf, key="raw/client/said/this.mov")
        assert caught.value.status_code == 404
        assert mf.size_verified_at is None

    def test_the_corrected_size_is_committed_with_the_status_change(self, mock_db):
        """One commit, so the row never exists in a committed-but-
        unreconciled state for another request's quota check to read."""
        mf = _media_file()

        self._run(mock_db, mf)

        assert mock_db.commit.call_count == 1

    def test_a_row_that_cannot_be_found_is_now_a_refusal(self, mock_db):
        """This used to assert that a missing MediaFile "does not break
        completion". §236 retires that: without the row there is no key to
        bind the request's to, no declared size to check the parts against,
        and nothing this endpoint is allowed to complete. The upload is
        refused instead of completed blind — and nothing is dispatched."""
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as caught:
            self._run(mock_db, None)
        assert caught.value.status_code == 404
        assert mock_db.commit.call_count == 0
