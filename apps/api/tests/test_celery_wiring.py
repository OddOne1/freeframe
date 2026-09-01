"""Static wiring checks for the Celery topology (CLAUDE.md §114).

Deliberately stdlib-only and import-free: these parse the source files rather
than importing celery_app, so they run identically in the container, in CI,
and on a laptop with no Celery installed. That matters because the failures
they catch are exactly the ones no runtime test sees --

  * `beat_schedule` names a task by STRING. A name that matches no task is
    not an error anywhere: beat dispatches it, no worker recognises it, and
    the job silently never runs.
  * A task routed (or defaulted) onto a queue no container consumes is
    likewise silent -- the message is accepted by the broker and sits there.
    This is not hypothetical: it is how `purge_expired_trash` and
    `send_due_date_reminders` ended up never executing in production, found
    while adding the sweeper that would have joined them.

Both are invisible to unit tests of the task functions themselves, which
pass perfectly while the task is never called.
"""

import ast
import re
from pathlib import Path

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]
CELERY_APP = API / "tasks" / "celery_app.py"
COMPOSE = REPO / "docker-compose.prod.yml"


def _celery_source() -> str:
    return CELERY_APP.read_text()


def _registered_task_names() -> dict:
    """{task name -> module} for every @celery_app.task(name=...) in tasks/."""
    found = {}
    for path in (API / "tasks").glob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            for dec in node.decorator_list:
                if not isinstance(dec, ast.Call):
                    continue
                for kw in dec.keywords:
                    if kw.arg == "name" and isinstance(kw.value, ast.Constant):
                        found[kw.value.value] = f"apps.api.tasks.{path.stem}"
    return found


def _beat_task_names() -> list:
    src = _celery_source()
    block = src[src.index("beat_schedule"):]
    return re.findall(r'"task":\s*"([^"]+)"', block)


def _consumed_queues() -> set:
    """Queues actually served by a `celery ... worker -Q ...` in compose."""
    queues = set()
    for m in re.finditer(r"celery -A [\w.]+ worker -Q ([\w,]+)", COMPOSE.read_text()):
        queues.update(m.group(1).split(","))
    return queues


def _queue_for(task_name: str, module: str) -> str:
    """Resolve a task's queue through task_routes, else the default queue."""
    src = _celery_source()
    routes = src[src.index("task_routes"):src.index("task_annotations")]
    # Longest pattern wins, matching Celery's own specificity.
    best = None
    for pattern, queue in re.findall(r'"([^"]+)":\s*\{"queue":\s*"([^"]+)"\}', routes):
        target = f"{module}.{task_name}"
        if pattern.endswith(".*"):
            if target.startswith(pattern[:-1]):
                if best is None or len(pattern) > len(best[0]):
                    best = (pattern, queue)
        elif pattern == target:
            best = (pattern, queue)
    if best:
        return best[1]
    return re.search(r'task_default_queue="([^"]+)"', src).group(1)


def test_every_scheduled_task_exists():
    """A beat entry naming a task nothing defines is dispatched into the void."""
    registered = _registered_task_names()
    missing = [n for n in _beat_task_names() if n not in registered]
    assert not missing, f"beat_schedule references undefined task(s): {missing}"


def test_every_scheduled_task_lands_on_a_consumed_queue():
    """The bug that hid purge_expired_trash and send_due_date_reminders."""
    registered = _registered_task_names()
    consumed = _consumed_queues()
    assert consumed, "parsed no worker -Q flags out of docker-compose.prod.yml"

    # celery_app.py's own record of the two it knowingly leaves stranded,
    # read from the source rather than duplicated here: a second copy of
    # that list would let the two disagree about which bugs are still open.
    known = set(re.findall(r'"([^"]+)"', re.search(
        r"KNOWN_UNROUTED = \{([^}]*)\}", _celery_source()).group(1)))

    stranded = {}
    for name in _beat_task_names():
        module = registered.get(name)
        if module is None:
            continue  # covered by the test above
        if name in known:
            continue
        queue = _queue_for(name, module)
        if queue not in consumed:
            stranded[name] = queue
    assert not stranded, (
        f"scheduled task(s) routed to a queue no container consumes: {stranded}; "
        f"consumed queues are {sorted(consumed)}"
    )


def test_known_unrouted_tasks_really_are_unrouted():
    """Keeps the exemption list from outliving the bug it exempts.

    If someone routes purge_expired_trash properly, this fails until the
    name is removed from KNOWN_UNROUTED -- so the list can never quietly
    become a place where a working task is still described as broken.
    """
    registered = _registered_task_names()
    consumed = _consumed_queues()
    known = set(re.findall(r'"([^"]+)"', re.search(
        r"KNOWN_UNROUTED = \{([^}]*)\}", _celery_source()).group(1)))

    fixed = {
        name: _queue_for(name, registered[name])
        for name in known
        if name in registered and _queue_for(name, registered[name]) in consumed
    }
    assert not fixed, (
        f"{fixed} now reach(es) a consumed queue -- remove from KNOWN_UNROUTED"
    )


def test_the_stuck_sweeper_is_actually_scheduled():
    """The whole recovery mechanism is one beat entry; assert it is present."""
    assert "sweep_stuck_processing" in _beat_task_names()


def test_late_acks_are_enabled():
    """Without these two, a killed worker's task is dropped, not redelivered.

    Asserted at the source because there is nothing observable to probe: the
    behaviour only manifests when a worker dies mid-task against a real
    broker.
    """
    src = _celery_source()
    assert re.search(r"^\s*task_acks_late=True,", src, re.M)
    assert re.search(r"^\s*task_reject_on_worker_lost=True,", src, re.M)


def test_celery_services_do_not_inherit_the_api_healthcheck():
    """Every Celery service must override it, or it is permanently unhealthy.

    The image's HEALTHCHECK curls localhost:8000/health, which no Celery
    process serves.
    """
    text = COMPOSE.read_text()
    # A service block runs to the next top-level service key: a line with
    # EXACTLY two spaces of indent then a name. Matching "\n  " alone would
    # stop at the block's own first child, which is indented four.
    for service in ("worker:", "transcribe_worker:", "email_worker:", "beat:"):
        start = text.index(f"\n  {service}")
        nxt = re.search(r"\n  [A-Za-z_][\w-]*:", text[start + 3:])
        block = text[start:start + 3 + nxt.start()] if nxt else text[start:]
        assert "healthcheck:" in block, f"{service} has no healthcheck override"
        # The COMMAND, not the block: the block also carries the comment
        # explaining what is being overridden, which names the API's own
        # probe. Asserting over the whole block matches that prose instead.
        cmd = re.search(r'healthcheck:\s*\n\s*test:\s*(.+)', block)
        assert cmd, f"{service} healthcheck has no test command"
        assert "localhost:8000" not in cmd.group(1), (
            f"{service} healthcheck probes the API port"
        )


if __name__ == "__main__":
    # Runnable without pytest: this machine has neither pytest nor a Docker
    # daemon (CLAUDE.md §37), and a check that cannot be run here is a check
    # that does not get run before a push.
    failures = 0
    for fname, fn in sorted(globals().items()):
        if fname.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {fname}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {fname}: {exc}")
    print("\nOK" if not failures else f"\n{failures} FAILED")
    raise SystemExit(1 if failures else 0)
