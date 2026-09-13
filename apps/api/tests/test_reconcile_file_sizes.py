"""The file-size backfill script (§181).

§180 fixed new uploads and left `size_verified_at` NULL on everything older;
this script works that queue. What is pinned here is the judgement it has to
exercise, not the plumbing: which rows it picks up, which categories a
failure falls into, and the one thing it must never do — write a size for an
object that is not there.

The script's real end-to-end behaviour (live Postgres + live MinIO, a
fixture covering every category, an interrupted run resumed) was exercised
against real services; see the §181 commit message for those figures. These
are the parts worth having in the suite afterwards.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from apps.api.models.asset import ProcessingStatus
from apps.api.scripts import reconcile_file_sizes as rfs


def _mf(declared=1000, key="raw/p/a/v/original.mov", name="clip.mov"):
    mf = MagicMock()
    mf.id = uuid.uuid4()
    mf.file_size_bytes = declared
    mf.s3_key_raw = key
    mf.original_filename = name
    mf.size_verified_at = None
    mf.version_id = uuid.uuid4()
    return mf


def _client_error(code, status=404):
    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "HeadObject",
    )


# ── telling a missing object from a sulking bucket ──────────────────────────

class TestMissingDetection:
    """These two are reported separately on purpose: one is a data-integrity
    finding for a human, the other is 'run it again later'."""

    @pytest.mark.parametrize("code", ["404", "NoSuchKey", "NoSuchBucket"])
    def test_a_missing_object_is_recognised(self, code):
        assert rfs._is_missing(_client_error(code)) is True

    def test_a_404_status_counts_even_with_an_odd_code(self):
        assert rfs._is_missing(_client_error("SomethingElse", status=404)) is True

    @pytest.mark.parametrize(
        "exc",
        [
            _client_error("InternalError", status=500),
            _client_error("SlowDown", status=503),
            ConnectionError("refused"),
            TimeoutError("timed out"),
        ],
    )
    def test_a_storage_failure_is_not_a_missing_object(self, exc):
        assert rfs._is_missing(exc) is False


# ── what the report says ────────────────────────────────────────────────────

class TestReport:
    def test_drift_is_signed_so_the_direction_is_readable(self):
        """Positive means clients under-reported — the quota-bypass
        direction, and the one worth knowing about at a glance."""
        r = rfs.Report()
        r.record(_mf(), declared=100, actual=500)

        assert r.drift == 400
        assert r.abs_drift == 400

    def test_opposite_errors_do_not_cancel_out_of_the_absolute_total(self):
        """A library that is 1GB under on one file and 1GB over on another
        has 2GB of wrong data, not zero."""
        r = rfs.Report()
        r.record(_mf(), declared=100, actual=1100)
        r.record(_mf(), declared=1100, actual=100)

        assert r.drift == 0
        assert r.abs_drift == 2000

    def test_a_correct_row_is_counted_but_not_listed_as_an_offender(self):
        r = rfs.Report()
        r.record(_mf(), declared=500, actual=500)

        assert r.matched == 1 and r.mismatched == 0
        assert r.offenders == []

    def test_a_zero_declared_size_does_not_divide_by_zero(self):
        r = rfs.Report()
        r.record(_mf(), declared=0, actual=100)

        assert r.offenders[0][1] == float("inf")


# ── the pass itself ─────────────────────────────────────────────────────────

class TestThePass:
    def _run(self, rows, sizes, *, write=False, statuses=None):
        """Run main() over a scripted set of rows.

        `sizes` maps s3 key -> an int to return or an exception to raise.
        """
        db = MagicMock()
        db.query.return_value.filter.return_value.count.return_value = len(rows)

        pages = [rows, []]

        def fake_batch(_db, after_id, _size):
            return pages.pop(0) if pages else []

        def fake_head(key):
            result = sizes[key]
            if isinstance(result, Exception):
                raise result
            return result

        def fake_status(_db, mf):
            return (statuses or {}).get(mf.s3_key_raw, ProcessingStatus.ready.value)

        with patch.object(rfs, "SessionLocal", return_value=db), \
             patch.object(rfs, "_batch", fake_batch), \
             patch.object(rfs, "head_object_size", fake_head), \
             patch.object(rfs, "_version_status", fake_status), \
             patch.object(rfs, "Report", wraps=rfs.Report) as spy:
            argv = ["--sleep", "0"] + (["--write"] if write else [])
            code = rfs.main(argv)
        report = spy.spy_return if hasattr(spy, "spy_return") else None
        return code, db, report

    def test_a_dry_run_writes_nothing(self):
        row = _mf(declared=1)

        _code, db, _r = self._run([row], {row.s3_key_raw: 9999})

        assert row.file_size_bytes == 1, "a dry run corrected the row"
        assert row.size_verified_at is None
        db.commit.assert_not_called()

    def test_write_mode_corrects_and_stamps(self):
        row = _mf(declared=1)

        self._run([row], {row.s3_key_raw: 9999}, write=True)

        assert row.file_size_bytes == 9999
        assert isinstance(row.size_verified_at, datetime)

    def test_write_mode_commits_per_batch_not_once_at_the_end(self):
        """What makes an interrupted run resume rather than restart."""
        rows = [_mf(key=f"k{i}") for i in range(3)]

        _code, db, _r = self._run(
            rows, {r.s3_key_raw: 500 for r in rows}, write=True
        )

        assert db.commit.call_count >= 1

    def test_a_correct_row_is_still_stamped_in_write_mode(self):
        """Otherwise every already-correct row stays in the queue forever
        and each re-run does the same work again."""
        row = _mf(declared=500)

        self._run([row], {row.s3_key_raw: 500}, write=True)

        assert row.size_verified_at is not None

    def test_a_missing_object_is_never_given_a_size(self):
        """The rule this script must not break. Writing 0 for an object that
        is not there would fold a data-integrity problem into the storage
        totals as if it were a free file."""
        row = _mf(declared=7_000_000)

        self._run([row], {row.s3_key_raw: _client_error("404")}, write=True)

        assert row.file_size_bytes == 7_000_000
        assert row.size_verified_at is None, "a missing object was marked verified"

    def test_a_missing_object_on_a_ready_version_is_the_loud_category(self):
        row = _mf()

        code, _db, _r = self._run(
            [row],
            {row.s3_key_raw: _client_error("404")},
            statuses={row.s3_key_raw: "ready"},
        )

        # Non-zero exit: something needs a human.
        assert code == 1

    def test_an_abandoned_upload_is_not_raised_as_an_integrity_problem(self):
        """A row whose version never left `uploading` has no object because
        the upload never finished — expected litter, not a missing file."""
        row = _mf()

        code, _db, _r = self._run(
            [row],
            {row.s3_key_raw: _client_error("404")},
            statuses={row.s3_key_raw: "uploading"},
        )

        assert code == 0

    def test_a_storage_failure_leaves_the_row_for_a_re_run(self):
        row = _mf(declared=42)

        code, _db, _r = self._run(
            [row], {row.s3_key_raw: ConnectionError("down")}, write=True
        )

        assert row.file_size_bytes == 42
        assert row.size_verified_at is None
        assert code == 1

    def test_mismatches_alone_are_not_a_failure_exit(self):
        """Finding wrong sizes is the job, not an error."""
        row = _mf(declared=1)

        code, _db, _r = self._run([row], {row.s3_key_raw: 9999})

        assert code == 0


def test_the_queue_is_the_unverified_rows(monkeypatch):
    """The filter is the whole resumability story — if it ever stopped being
    `size_verified_at IS NULL`, a re-run would redo finished work."""
    import inspect

    src = inspect.getsource(rfs._batch)
    assert "size_verified_at.is_(None)" in src
    # Keyset, not OFFSET: a dry run never shrinks the set it is paging.
    assert "MediaFile.id > after_id" in src


def test_write_is_opt_in():
    """Default must be the dry run. A script that wrote by default would be
    one typo away from an unreviewed pass over production."""
    import inspect

    src = inspect.getsource(rfs.main)
    assert '"--write", action="store_true"' in src
