"""A queued transcode is not a stuck one (§219).

`processing_status` is set to `processing` at DISPATCH, by whoever queues the
work. On a busy `transcoding` queue — concurrency 2, prefetch 1, multi-hour
ffmpeg jobs — a version then sits at `processing` for hours before a worker
frees up, and nothing touches the row while it waits. The sweeper, which
fails anything whose `updated_at` has not moved in 45 minutes, could not tell
that apart from a worker having died.

Measured on the live server during a 641 GiB import: two healthy 95 GiB
originals were relabelled `failed` while still waiting their turn. They were
only recoverable because `process_asset` happens to skip just `ready`.

So the tests that matter most in this file are the two about what the sweep
must NOT do: `test_a_queued_row_is_not_swept_by_the_minutes_rule` and
`test_a_queued_row_is_left_alone_well_past_the_minutes_rule`. A sweep that
fails healthy queued work destroys a user's place in the queue, which is
worse than leaving a dead row claiming to be busy for another week.

The rest covers the three long phases that genuinely have no progress to
report (the EXIF full-file download, the HLS upload, and an encode whose
duration ffprobe could not read) and now keep the row alive with a
byte-driven heartbeat instead.
"""

import ast
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]

_MISSING = object()


# ── a fake session that really filters ─────────────────────────────────────


class _Crit:
    """One SQLAlchemy filter criterion, re-applied to an in-memory row.

    Honouring the criteria is the entire reason this is not a MagicMock. The
    whole §219 fix lives in ONE filter — `processing_started_at IS NOT NULL`
    — so a fake that returned its rows regardless of what it was asked would
    make every assertion below vacuous: they would all pass just as happily
    against the sweep that failed two 95 GiB files.

    An operator this does not implement raises rather than being skipped, for
    the same reason: a silently dropped filter is indistinguishable from a
    filter the code under test never had.
    """

    def __init__(self, criterion):
        left = getattr(criterion, "left", None)
        right = getattr(criterion, "right", None)
        self.name = getattr(left, "name", None) or getattr(left, "key", None)
        self.op = getattr(getattr(criterion, "operator", None), "__name__", "")
        self.value = getattr(right, "value", _MISSING)
        if not self.name or not self.op:
            raise AssertionError(f"could not parse filter criterion {criterion!r}")

    def matches(self, row) -> bool:
        actual = getattr(row, self.name)
        if self.op in ("lt", "__lt__"):
            return actual < self.value
        if self.op in ("gt", "__gt__"):
            return actual > self.value
        if self.op in ("eq", "__eq__"):
            return actual == self.value
        if self.op == "in_op":
            return actual in self.value
        # `.is_(None)` / `.isnot(None)` carry a Null() on the right, which has
        # no `.value` at all — so these are decided by the operator alone.
        if self.op == "is_":
            return actual is None
        if self.op in ("is_not", "isnot"):
            return actual is not None
        raise AssertionError(
            f"the fake query does not implement operator {self.op!r} "
            f"(on column {self.name!r}); implement it rather than letting the "
            f"criterion be ignored"
        )


class _FakeQuery:
    def __init__(self, session):
        self.session = session
        self.criteria = []

    def filter(self, *criteria):
        self.criteria.extend(_Crit(c) for c in criteria)
        return self

    def all(self):
        return [
            v for v in self.session.versions
            if all(c.matches(v) for c in self.criteria)
        ]


class FakeSession:
    def __init__(self, versions):
        self.versions = list(versions)
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def query(self, *_entities):
        return _FakeQuery(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


def make_version(*, started_at, updated_minutes_ago=None, updated_hours_ago=None,
                 status=None, deleted_at=None):
    """A version row.

    A SimpleNamespace rather than a MagicMock on purpose: every attribute of a
    MagicMock exists and is truthy, so a column name this file got wrong would
    read as a populated value instead of raising.
    """
    from apps.api.models.asset import ProcessingStatus

    if updated_hours_ago is not None:
        updated_at = _now() - timedelta(hours=updated_hours_ago)
    else:
        updated_at = _now() - timedelta(minutes=updated_minutes_ago or 0)
    return SimpleNamespace(
        id=uuid.uuid4(),
        asset_id=uuid.uuid4(),
        processing_status=status or ProcessingStatus.processing,
        processing_started_at=started_at,
        updated_at=updated_at,
        deleted_at=deleted_at,
    )


def _now():
    return datetime.now(timezone.utc)


def _sweep(versions):
    """Run the real task against a fake session, and return (result, session)."""
    from apps.api.tasks import cleanup_tasks

    session = FakeSession(versions)
    with patch.object(cleanup_tasks, "SessionLocal", return_value=session):
        result = cleanup_tasks.sweep_stuck_processing()
    return result, session


# ── the fake, guarded ──────────────────────────────────────────────────────


def test_the_fake_query_really_applies_the_criteria_it_is_given():
    """Guards the guard.

    If this fixture were lenient, every sweep test below would pass against a
    sweep with no `processing_started_at` filter at all — which is precisely
    the bug being fixed.
    """
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    queued = make_version(started_at=None, updated_minutes_ago=600)
    started = make_version(started_at=_now() - timedelta(hours=3), updated_minutes_ago=600)
    session = FakeSession([queued, started])

    only_started = (
        session.query(AssetVersion)
        .filter(AssetVersion.processing_started_at.isnot(None))
        .all()
    )
    assert only_started == [started]

    only_queued = (
        session.query(AssetVersion)
        .filter(AssetVersion.processing_started_at.is_(None))
        .all()
    )
    assert only_queued == [queued]

    by_status = (
        session.query(AssetVersion)
        .filter(AssetVersion.processing_status.in_((ProcessingStatus.failed,)))
        .all()
    )
    assert by_status == []

    fresh_excluded = (
        session.query(AssetVersion)
        .filter(AssetVersion.updated_at < _now() - timedelta(days=365))
        .all()
    )
    assert fresh_excluded == []


# ── the sweep: what it must not touch ──────────────────────────────────────


def test_a_queued_row_is_not_swept_by_the_minutes_rule():
    """THE test. A `processing` row that never started is queued, not stuck.

    Ten hours of silence, which is ten times the old threshold, and it must
    survive — because its `updated_at` is its dispatch time and says nothing
    whatever about whether anything is wrong.
    """
    from apps.api.models.asset import ProcessingStatus

    queued = make_version(started_at=None, updated_hours_ago=10)
    result, session = _sweep([queued])

    assert queued.processing_status == ProcessingStatus.processing
    assert result["swept"] == 0
    assert result["swept_queued"] == 0


def test_a_queued_row_is_left_alone_well_past_the_minutes_rule():
    """The live incident, in miniature: a 95 GiB original waiting behind a
    641 GiB import, queued for three days, still perfectly healthy."""
    from apps.api.models.asset import ProcessingStatus

    queued = make_version(started_at=None, updated_hours_ago=72)
    result, _ = _sweep([queued])

    assert queued.processing_status == ProcessingStatus.processing
    assert result["swept"] == 0
    assert result["swept_queued"] == 0


def test_a_started_row_with_a_fresh_updated_at_is_left_alone():
    """A live transcode. Its heartbeat moved five minutes ago."""
    from apps.api.models.asset import ProcessingStatus

    live = make_version(started_at=_now() - timedelta(hours=2), updated_minutes_ago=5)
    result, _ = _sweep([live])

    assert live.processing_status == ProcessingStatus.processing
    assert result["swept"] == 0


def test_a_deleted_row_is_never_swept():
    from apps.api.models.asset import ProcessingStatus

    gone = make_version(
        started_at=_now() - timedelta(hours=5), updated_hours_ago=5,
        deleted_at=_now() - timedelta(days=1),
    )
    result, _ = _sweep([gone])

    assert gone.processing_status == ProcessingStatus.processing
    assert result["swept"] == 0


def test_a_row_that_is_not_processing_is_never_swept():
    from apps.api.models.asset import ProcessingStatus

    ready = make_version(
        started_at=_now() - timedelta(hours=5), updated_hours_ago=5,
        status=ProcessingStatus.ready,
    )
    uploading = make_version(
        started_at=None, updated_hours_ago=500, status=ProcessingStatus.uploading,
    )
    result, _ = _sweep([ready, uploading])

    assert ready.processing_status == ProcessingStatus.ready
    assert uploading.processing_status == ProcessingStatus.uploading
    assert result["swept"] == 0 and result["swept_queued"] == 0


# ── the sweep: what it must still catch ────────────────────────────────────


def test_a_started_row_gone_silent_is_failed():
    """The original §114 case, which still has to work: a worker began the
    job and then died or wedged, so the row has a start time and no activity
    since."""
    from apps.api.models.asset import ProcessingStatus
    from apps.api.config import settings

    stale = make_version(
        started_at=_now() - timedelta(hours=4),
        updated_minutes_ago=settings.stuck_processing_minutes + 45,
    )
    result, session = _sweep([stale])

    assert stale.processing_status == ProcessingStatus.failed
    assert result["swept"] == 1
    assert result["swept_queued"] == 0
    assert session.commits == 1


def test_a_queued_row_is_failed_once_past_the_queued_threshold():
    """The backstop that remains real: a task lost from the broker entirely,
    which nothing will ever pick up. A week by default, not 45 minutes."""
    from apps.api.models.asset import ProcessingStatus
    from apps.api.config import settings

    lost = make_version(
        started_at=None, updated_hours_ago=settings.stuck_queued_hours + 24,
    )
    result, session = _sweep([lost])

    assert lost.processing_status == ProcessingStatus.failed
    assert result["swept_queued"] == 1
    assert result["swept"] == 0
    assert session.commits == 1


def test_the_two_rules_are_reported_separately():
    """One pass can find both, and the counts must not be merged — the whole
    operational question is which rule fired."""
    from apps.api.models.asset import ProcessingStatus
    from apps.api.config import settings

    started = make_version(
        started_at=_now() - timedelta(hours=4),
        updated_minutes_ago=settings.stuck_processing_minutes + 10,
    )
    queued_lost = make_version(
        started_at=None, updated_hours_ago=settings.stuck_queued_hours + 1,
    )
    queued_waiting = make_version(started_at=None, updated_hours_ago=6)

    result, _ = _sweep([started, queued_lost, queued_waiting])

    assert result["swept"] == 1
    assert result["swept_queued"] == 1
    assert started.processing_status == ProcessingStatus.failed
    assert queued_lost.processing_status == ProcessingStatus.failed
    assert queued_waiting.processing_status == ProcessingStatus.processing


def test_an_empty_sweep_still_reports_both_thresholds_and_commits_nothing():
    from apps.api.config import settings

    result, session = _sweep([])

    assert result == {
        "swept": 0,
        "threshold_minutes": settings.stuck_processing_minutes,
        "swept_queued": 0,
        "threshold_queued_hours": settings.stuck_queued_hours,
    }
    assert session.commits == 0
    assert session.closed


def test_the_thresholds_come_from_settings_not_from_constants():
    """Both are overridable (STUCK_PROCESSING_MINUTES / STUCK_QUEUED_HOURS);
    a hardcoded 45 or 168 would make the env vars a lie."""
    from apps.api.config import settings

    result, _ = _sweep([])
    assert result["threshold_minutes"] == settings.stuck_processing_minutes
    assert result["threshold_queued_hours"] == settings.stuck_queued_hours
    # And the queued backstop must be the far longer of the two, or it is not
    # a backstop — it is the bug again in different units.
    assert settings.stuck_queued_hours * 60 > settings.stuck_processing_minutes


def test_a_sweep_failure_rolls_back_and_reraises():
    """A sweeper that fails silently is indistinguishable from one that found
    nothing, which is the failure mode this whole mechanism is about."""
    from apps.api.tasks import cleanup_tasks

    session = FakeSession([])
    session.commit = MagicMock(side_effect=RuntimeError("db gone"))
    broken = make_version(
        started_at=_now() - timedelta(hours=4), updated_hours_ago=4,
    )
    session.versions.append(broken)

    with patch.object(cleanup_tasks, "SessionLocal", return_value=session):
        with pytest.raises(RuntimeError):
            cleanup_tasks.sweep_stuck_processing()
    assert session.rollbacks == 1
    assert session.closed


# ── process_asset marks the real start ─────────────────────────────────────


class _World:
    """The minimum session `process_asset` needs, keyed by model class."""

    def __init__(self, objects):
        self._objects = objects
        self.commits = 0

    def query(self, model):
        q = MagicMock()
        q.filter.return_value.first.return_value = self._objects.get(model)
        q.filter.return_value.all.return_value = []
        return q

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def add(self, _obj):
        pass

    def refresh(self, _obj):
        pass

    def close(self):
        pass


def _world():
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
        # Dispatched: the status is already `processing` and no start is
        # recorded, which is exactly the state the sweeper must read as
        # queued until this task runs.
        processing_status=ProcessingStatus.processing,
        processing_started_at=None,
    )
    media_file = MediaFile(
        id=uuid.uuid4(), version_id=version.id, original_filename="a.mov",
        mime_type="video/quicktime", file_size_bytes=1, s3_key_raw="raw/a.mov",
    )
    db = _World({
        AssetVersion: version, Asset: asset, MediaFile: media_file, Project: project,
    })
    return db, asset, version


def test_process_asset_records_the_start_before_doing_any_work():
    """Not merely that the column ends up set — that it is set BEFORE the
    work begins.

    Written after the work it would be useless: the silence rule has to apply
    from the moment the task starts, and a 95 GiB EXIF download happens first.
    """
    from apps.api.models.asset import ProcessingStatus
    from apps.api.tasks import transcode_tasks

    db, asset, version = _world()
    seen = {}

    def record_when_work_starts(*_a, **_k):
        seen["started_at"] = version.processing_started_at
        seen["status"] = version.processing_status
        seen["commits"] = db.commits

    with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
         patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
         patch.object(transcode_tasks, "prefix_for_project", return_value="p"), \
         patch.object(transcode_tasks, "_publish_event"), \
         patch.object(transcode_tasks, "_notify_new_version"), \
         patch.object(transcode_tasks, "_process_video",
                      side_effect=record_when_work_starts):
        transcode_tasks.process_asset.run(str(asset.id), str(version.id))

    assert isinstance(seen["started_at"], datetime), (
        "processing_started_at was still NULL when the transcode began, so "
        "the sweeper would have read a running job as queued"
    )
    assert seen["started_at"].tzinfo is not None, "must be tz-aware"
    assert seen["status"] == ProcessingStatus.processing
    assert seen["commits"] >= 1, "the start must be committed, not just assigned"
    assert version.processing_status == ProcessingStatus.ready


def test_a_redelivered_attempt_overwrites_an_older_start():
    """A retry's clock starts now, not when the dead attempt began — else the
    replacement is swept almost immediately."""
    from apps.api.tasks import transcode_tasks

    db, asset, version = _world()
    ancient = datetime(2020, 1, 1, tzinfo=timezone.utc)
    version.processing_started_at = ancient

    with patch.object(transcode_tasks, "SessionLocal", return_value=db), \
         patch.object(transcode_tasks, "get_s3_client", return_value=MagicMock()), \
         patch.object(transcode_tasks, "prefix_for_project", return_value="p"), \
         patch.object(transcode_tasks, "_publish_event"), \
         patch.object(transcode_tasks, "_notify_new_version"), \
         patch.object(transcode_tasks, "_process_video"):
        transcode_tasks.process_asset.run(str(asset.id), str(version.id))

    assert version.processing_started_at > ancient


# ── every dispatch path clears it ──────────────────────────────────────────


def _functions_setting_processing(path: Path):
    """{function name -> assigned attribute names} for every function in
    `path` that sets some `.processing_status` to `ProcessingStatus.processing`.
    """
    out = {}
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        sets_processing = False
        assigned = {}
        for inner in ast.walk(node):
            if not isinstance(inner, ast.Assign):
                continue
            for target in inner.targets:
                if not isinstance(target, ast.Attribute):
                    continue
                assigned.setdefault(target.attr, []).append(ast.unparse(inner.value))
                if target.attr == "processing_status" and \
                        ast.unparse(inner.value) == "ProcessingStatus.processing":
                    sets_processing = True
        if sets_processing:
            out[node.name] = assigned
    return out


def test_every_dispatch_path_clears_the_start_marker():
    """The bug CLASS, not just today's two call sites.

    A new way to queue a transcode that sets `processing` and leaves a stale
    `processing_started_at` in place hands the sweeper a row claiming to have
    started hours ago and been silent ever since — and it is failed within the
    next 15 minutes while its task waits healthily in the queue. Checked
    statically because the alternative is driving `complete_upload` and
    `restart_processing` through the full request stack to assert one column.
    """
    dispatchers = {}
    for folder in ("routers", "tasks", "services", "scripts"):
        directory = API / folder
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.py")):
            for fn, assigned in _functions_setting_processing(path).items():
                # process_asset is the one place that is a real START rather
                # than a dispatch; it is asserted separately below.
                if fn == "process_asset":
                    continue
                dispatchers[f"{folder}/{path.name}::{fn}"] = assigned

    assert dispatchers, "found no dispatch sites at all — the scan is broken"

    missing = {
        where: "no processing_started_at assignment"
        for where, assigned in dispatchers.items()
        if "processing_started_at" not in assigned
    }
    assert not missing, (
        f"dispatch path(s) that set `processing` without clearing the start "
        f"marker: {missing}"
    )

    wrong = {
        where: assigned["processing_started_at"]
        for where, assigned in dispatchers.items()
        if any(v != "None" for v in assigned["processing_started_at"])
    }
    assert not wrong, (
        f"dispatch path(s) setting processing_started_at to something other "
        f"than None: {wrong}. Dispatch means queued; only process_asset may "
        f"record a real start."
    )


def test_process_asset_sets_a_real_timestamp_not_none():
    """The mirror of the check above: the one place that must NOT clear it."""
    found = _functions_setting_processing(API / "tasks" / "transcode_tasks.py")
    assert "process_asset" in found, "process_asset no longer sets `processing`"
    values = found["process_asset"].get("processing_started_at")
    assert values, "process_asset does not set processing_started_at at all"
    assert all(v != "None" for v in values), (
        f"process_asset clears the start marker instead of setting it: {values}"
    )


# ── the heartbeat for the silent phases ────────────────────────────────────


class _Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += timedelta(seconds=seconds)


def _heartbeat(interval=60):
    from apps.api.tasks import transcode_tasks

    clock = _Clock()
    touches = []
    hb = transcode_tasks._make_transfer_heartbeat(
        "v-1", interval_seconds=interval, now=clock, touch=touches.append,
    )
    return hb, clock, touches


def test_a_whole_download_of_chunks_touches_the_row_once_per_interval():
    """One beat a minute, not one per 8 MB chunk. A 95 GiB download is
    thousands of callbacks."""
    hb, clock, touches = _heartbeat()

    for _ in range(200):
        hb(8 * 1024 * 1024)
    assert len(touches) == 1, "throttle let more than one beat through"

    clock.advance(59)
    hb(8 * 1024 * 1024)
    assert len(touches) == 1, "beat fired before the interval elapsed"

    clock.advance(2)
    hb(8 * 1024 * 1024)
    assert len(touches) == 2
    assert touches == ["v-1", "v-1"]


def test_no_bytes_means_no_heartbeat_at_all():
    """The design constraint. A beat must be evidence of work, not of time
    passing — a timer would keep a wedged ffmpeg or a hung S3 read looking
    alive forever and defeat the sweeper entirely.
    """
    hb, clock, touches = _heartbeat()

    hb(0)
    clock.advance(3600)
    hb(0)
    assert touches == []


def test_a_heartbeat_that_is_never_called_touches_nothing():
    """The same point from the other side: a phase that produces no callbacks
    at all (a stalled transfer) goes silent and is swept, as intended."""
    _hb, clock, touches = _heartbeat()
    clock.advance(86400)
    assert touches == []


def test_the_heartbeat_never_raises_into_the_transcode():
    """A bookkeeping UPDATE must not be able to fail a multi-hour encode."""
    from apps.api.tasks import transcode_tasks

    session = MagicMock()
    session.query.side_effect = RuntimeError("connection pool exhausted")
    with patch.object(transcode_tasks, "SessionLocal", return_value=session):
        transcode_tasks._touch_version_activity(str(uuid.uuid4()))
    session.rollback.assert_called_once()
    session.close.assert_called_once()


def test_the_touch_writes_updated_at_and_nothing_else():
    """`onupdate` needs some other column to ride along on, and "touch this
    row" is exactly the case with no other column to write — so updated_at is
    set explicitly."""
    from apps.api.models.asset import AssetVersion
    from apps.api.tasks import transcode_tasks

    session = MagicMock()
    with patch.object(transcode_tasks, "SessionLocal", return_value=session):
        transcode_tasks._touch_version_activity(str(uuid.uuid4()))

    update = session.query.return_value.filter.return_value.update
    update.assert_called_once()
    values = update.call_args[0][0]
    assert list(values) == [AssetVersion.updated_at], (
        "the heartbeat must write updated_at and only updated_at"
    )
    session.commit.assert_called_once()


def test_an_encode_with_an_unknown_duration_still_beats():
    """The silent phase that hides.

    Every progress report is gated on `total_duration > 0`, so an encode
    whose duration ffprobe could not read (tolerated, non-fatal) reports no
    percent for its entire run — up to the four-hour timeout — and used to
    touch the row exactly never.
    """
    from packages.transcoder import ffmpeg_transcoder

    lines = ["out_time_ms=1000000", "frame=10", "out_time_ms=2000000", "progress=end"]
    beats = []
    reports = []

    process = MagicMock()
    process.stdout = iter(lines)
    process.poll.return_value = 0
    process.wait.return_value = 0
    # Explicit: a MagicMock's returncode is a truthy object, which the
    # function reads as a non-zero exit and raises FFmpegError on.
    process.returncode = 0

    with patch.object(ffmpeg_transcoder.subprocess, "Popen", return_value=process):
        ffmpeg_transcoder.FFmpegTranscoder._run_ffmpeg_with_progress(
            ["ffmpeg"], 0.0, reports.append, timeout=60,
            heartbeat_callback=lambda n=1: beats.append(n),
        )

    assert reports == [], "no percent is computable without a duration"
    assert len(beats) == 2, (
        "an encode with no duration produced no heartbeat, so a four-hour run "
        "would look silent to the sweeper"
    )


def test_a_normal_encode_still_reports_progress_and_also_beats():
    from packages.transcoder import ffmpeg_transcoder

    lines = ["out_time_ms=5000000", "out_time_ms=10000000"]
    beats, reports = [], []

    process = MagicMock()
    process.stdout = iter(lines)
    process.poll.return_value = 0
    process.wait.return_value = 0
    # Explicit: a MagicMock's returncode is a truthy object, which the
    # function reads as a non-zero exit and raises FFmpegError on.
    process.returncode = 0

    with patch.object(ffmpeg_transcoder.subprocess, "Popen", return_value=process):
        ffmpeg_transcoder.FFmpegTranscoder._run_ffmpeg_with_progress(
            ["ffmpeg"], 100.0, reports.append, timeout=60,
            heartbeat_callback=lambda n=1: beats.append(n),
        )

    assert reports == [5, 10]
    assert len(beats) == 2


def test_the_transfer_call_sites_pass_the_heartbeat_as_a_boto3_callback():
    """The two byte-driven phases, checked at the source.

    Driving these behaviourally would mean a real multipart transfer; what is
    worth pinning is that the heartbeat is handed to boto3's own `Callback`
    (so beats track bytes that actually moved) rather than being wrapped in
    anything time-based.
    """
    src = (REPO / "packages" / "transcoder" / "ffmpeg_transcoder.py").read_text()
    tree = ast.parse(src)

    guarded = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = ast.unparse(node.func)
        if not fn.endswith(("s3.download_file", "s3.upload_file")):
            continue
        rendered = ast.unparse(node)
        if "Callback" in rendered and "heartbeat_callback" in rendered:
            guarded.append(fn)

    assert "self.s3.download_file" in guarded, (
        "the EXIF full-file download has no heartbeat; on a 95 GiB master "
        "that is tens of minutes of silence"
    )
    assert "self.s3.upload_file" in guarded, (
        "the HLS ladder upload has no heartbeat; the encode's last report is "
        "99% and the upload that follows can be many GB"
    )


def test_the_heartbeat_is_threaded_from_the_task_into_the_transcoder():
    """The wiring, end to end: a callback the transcoder never receives is a
    heartbeat that never happens."""
    task_src = (API / "tasks" / "transcode_tasks.py").read_text()
    assert "_make_transfer_heartbeat(version.id)" in task_src
    assert "heartbeat_callback=heartbeat" in task_src

    transcoder_src = (REPO / "packages" / "transcoder" / "ffmpeg_transcoder.py").read_text()
    assert "heartbeat_callback: Optional[Callable[[int], None]] = None" in transcoder_src


def test_the_heartbeat_interval_is_far_below_the_sweep_threshold():
    """Otherwise a phase that is beating correctly can still be swept."""
    from apps.api.config import settings
    from apps.api.tasks import transcode_tasks

    assert transcode_tasks.TRANSFER_HEARTBEAT_SECONDS * 10 < \
        settings.stuck_processing_minutes * 60
