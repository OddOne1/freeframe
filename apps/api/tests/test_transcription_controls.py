"""The transcription toggle's rules, and the cancellation ordering (§127).

Two of these are pure logic and are exercised for real. The rest assert the
ordering inside the toggle endpoint, which is the part that cannot be
retried if it is wrong: `revoke(terminate=True)` may kill the worker child
mid-call, so the task's own except/finally is not guaranteed to run. If the
caller does not write the terminal state BEFORE sending the signal, nothing
ever will, and the row sits at `processing` forever -- the exact failure
this codebase has already hit twice (§114, §121).

Static and stdlib-only: this machine has no Postgres, no Celery and no
pytest (CLAUDE.md §37), so the endpoint cannot be called here.
"""

import ast
import re
import sys
from pathlib import Path

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API / "services"))


def _endpoint_source() -> str:
    text = (API / "routers" / "assets.py").read_text()
    start = text.index("def set_asset_transcription(")
    end = text.index("\n@router.", start)
    return text[start:end]


def _code_only(text: str) -> str:
    """Comments AND docstrings stripped.

    Every function here explains itself, and that prose names the very
    identifiers being asserted on — a docstring saying `revoke(terminate=True)`
    satisfied the check for terminate=True while the call itself said
    otherwise. This has now caught me four times across this codebase.
    """
    out, in_doc = [], False
    for line in text.splitlines():
        stripped = line.strip()
        if in_doc:
            if stripped.endswith('"""'):
                in_doc = False
            continue
        if stripped.startswith('"""'):
            # A one-line docstring opens and closes on the same line.
            if not (len(stripped) > 3 and stripped.endswith('"""')):
                in_doc = True
            continue
        if stripped.startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


# ── The resolver, exercised directly ────────────────────────────────────────

def _resolver():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "td", API / "services" / "transcription_defaults.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Project:
    def __init__(self, value):
        self.transcription_default = value


def test_project_default_is_used_when_set():
    td = _resolver()
    assert td.default_transcription_enabled(_Project(False)) is False
    assert td.default_transcription_enabled(_Project(True)) is True


def test_unchosen_falls_through_to_the_app_default():
    """None is "nobody chose", which is NOT the same as chosen-false."""
    td = _resolver()
    assert td.default_transcription_enabled(_Project(None)) is td.APP_DEFAULT
    assert td.default_transcription_enabled(None) is td.APP_DEFAULT


def test_the_app_default_matches_what_the_app_already_did():
    """Every video and audio upload was transcribed unconditionally before
    this existed; defaulting to false would silently switch that off."""
    td = _resolver()
    assert td.APP_DEFAULT is True


# ── Cancellation ordering ───────────────────────────────────────────────────

def test_terminal_state_is_written_before_the_revoke():
    code = _code_only(_endpoint_source())
    cleared = code.index("transcription_status = TranscriptionStatus.not_started")
    revoked = code.index("control.revoke(")
    assert cleared < revoked, (
        "the revoke may kill the worker mid-call, so nothing after it in the "
        "task is guaranteed to run -- the row must already be terminal"
    )


def test_the_run_handle_is_cleared_on_cancel():
    code = _code_only(_endpoint_source())
    assert "transcription_task_id = None" in code


def test_revoke_terminates_rather_than_only_marking():
    """A queued task is stopped by the revoked set; a running one needs the
    signal. Concurrency is 1 on this worker, so both cases are common."""
    code = _code_only(_endpoint_source())
    call = code[code.index("control.revoke("):]
    assert "terminate=True" in call[:120]


def test_a_failed_revoke_does_not_undo_the_state():
    """The broker may not carry the revoke. The state is already correct, and
    the task itself re-checks the toggle when it starts, so the failure path
    must not write status back."""
    code = _code_only(_endpoint_source())
    lines = code.splitlines()
    at = next(i for i, l in enumerate(lines) if "control.revoke(" in l)
    handler = next(i for i in range(at, len(lines)) if lines[i].strip().startswith("except "))
    indent = len(lines[handler]) - len(lines[handler].lstrip())
    # Only the handler's own body, not everything that follows it in the
    # function -- the enable branch further down legitimately sets a status.
    body = []
    for line in lines[handler + 1:]:
        if line.strip() and (len(line) - len(line.lstrip())) <= indent:
            break
        body.append(line)
    assert body, "the revoke has no failure handler"
    assert "transcription_status" not in "\n".join(body)


# ── Starting a run ──────────────────────────────────────────────────────────

def test_turning_it_on_only_starts_when_there_is_nothing_to_show():
    """The toggle is intent, not a trigger: on for an already-transcribed
    file is a no-op, not a fresh run."""
    code = _code_only(_endpoint_source())
    guard = code[code.index("if body.enabled") if "if body.enabled" in code else 0:]
    assert "TranscriptionStatus.not_started" in code
    assert "TranscriptionStatus.failed" in code
    assert "TranscriptionStatus.ready" not in guard.split("transcribe_asset.delay")[0]


def test_a_started_run_records_its_id():
    """Without this the next toggle-off has nothing to revoke."""
    code = _code_only(_endpoint_source())
    assert "transcription_task_id = result.id" in code


# ── The task and the dispatcher ─────────────────────────────────────────────

def test_dispatch_is_gated_on_the_toggle():
    code = _code_only((API / "tasks" / "transcode_tasks.py").read_text())
    assert "asset.transcription_enabled" in code


def test_the_task_rechecks_the_toggle_when_it_starts():
    """revoke() only helps while the worker holds the revoked set; a task
    that outlives that must still decline."""
    code = _code_only((API / "tasks" / "transcribe_tasks.py").read_text())
    assert "if not asset.transcription_enabled" in code


def test_progress_is_throttled_to_whole_percents():
    """A long recording yields thousands of segments; an unthrottled write
    would be one commit each."""
    code = _code_only((API / "tasks" / "transcribe_tasks.py").read_text())
    # The declaration alone is not the throttle — the early return is.
    assert 'last_pct["v"] == pct' in code
    assert "return" in code[code.index('last_pct["v"] == pct'):][:80]


def test_progress_has_its_own_column():
    """Not AssetVersion.processing_progress: transcription runs after the
    version is already ready, so sharing it would overwrite the transcode's
    final value."""
    models = (API / "models" / "asset.py").read_text()
    assert "transcription_progress" in models


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {name}: {exc}")
    print("\nOK" if not failures else f"\n{failures} FAILED")
    raise SystemExit(1 if failures else 0)
