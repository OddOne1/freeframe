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
    while adding the sweeper that would have joined them. `apply_watermark`
    (§126) and four zip tasks (§143) were the same bug again;
    `purge_expired_trash` was finally routed for real in §182, which is
    also when the checks below stopped letting an exemption hide one.

Both are invisible to unit tests of the task functions themselves, which
pass perfectly while the task is never called.
"""

import ast
import re
from pathlib import Path

TASK_DECORATORS = ("celery_app.task", "shared_task", "app.task")

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


def _queue_for_name(registered_name: str) -> str:
    """Resolve a task's queue the way Celery does: by its REGISTERED name.

    A task declared `name="apply_watermark"` is matched against that string,
    not against its module path — so a `apps.api.tasks.watermark_tasks.*`
    glob never sees it. Getting this wrong in the check is how the same task
    can look routed while falling through to the default queue in practice.
    """
    src = _celery_source()
    routes = src[src.index("task_routes"):src.index("task_annotations")]
    best = None
    for pattern, queue in re.findall(r'"([^"]+)":\s*\{"queue":\s*"([^"]+)"\}', routes):
        if pattern.endswith(".*"):
            if registered_name.startswith(pattern[:-1]):
                if best is None or len(pattern) > len(best[0]):
                    best = (pattern, queue)
        elif pattern == registered_name:
            # An exact match is the most specific there is.
            best = (pattern, queue)
            break
    if best:
        return best[1]
    return re.search(r'task_default_queue="([^"]+)"', src).group(1)


def _queue_for(task_name: str, module: str) -> str:
    """Same, for callers that hold a module and a function name."""
    return _queue_for_name(f"{module}.{task_name}")


def _decorated_tasks() -> dict:
    """{function name -> (module, decorator sources)} for every Celery task."""
    out = {}
    for path in (API / "tasks").glob("*.py"):
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, ast.FunctionDef) or not node.decorator_list:
                continue
            decs = [ast.unparse(d) for d in node.decorator_list]
            if any(any(k in d for k in TASK_DECORATORS) for d in decs):
                out[node.name] = (path.name, decs, node)
    return out


def test_no_task_decorator_sits_on_a_private_helper():
    """The §115 outage, made impossible to reintroduce silently.

    A decorator is applied to whatever `def` follows it, so inserting a
    helper between the decorator and its intended task silently moves the
    registration onto the helper -- and leaves the real task a plain
    function with no .delay(). Nothing raises at import time; it fails only
    at the first dispatch, in a background thread, in production.

    A leading underscore is this codebase's own marker for "called
    directly, not dispatched", so a decorated one is the signature of
    exactly that drift.
    """
    private = {
        name: mod for name, (mod, _decs, _node) in _decorated_tasks().items()
        if name.startswith("_")
    }
    assert not private, f"private helper(s) registered as Celery tasks: {private}"


def test_bound_tasks_take_self_first():
    """`bind=True` injects the task instance as the first positional arg.

    So a bound task whose first parameter is not `self` is either
    mis-decorated or will be called with one argument too many. This is the
    mechanical form of the same drift: _notify_new_version(db, asset,
    version) carried bind=True, which would have shifted `db` into `asset`
    had it ever actually been reached.
    """
    wrong = {}
    for name, (mod, decs, node) in _decorated_tasks().items():
        if not any("bind=True" in d for d in decs):
            continue
        first = node.args.args[0].arg if node.args.args else None
        if first != "self":
            wrong[name] = f"{mod}: first param is {first!r}"
    assert not wrong, f"bind=True task(s) not taking self first: {wrong}"


def test_send_task_safe_targets_are_registered_tasks():
    """Dispatching a plain function raises AttributeError at runtime only.

    send_task_safe calls .delay(), which a plain function does not have --
    and it runs in a daemon thread, so the failure surfaces as a stray
    traceback rather than a failed request. Checking the call sites
    statically is the only place this is cheap to catch.
    """
    tasks = set(_decorated_tasks())
    bad = {}
    for folder in ("routers", "tasks", "services"):
        d = API / folder
        if not d.is_dir():
            continue
        for path in d.glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                if getattr(fn, "id", None) != "send_task_safe" or not node.args:
                    continue
                target = node.args[0]
                # Only resolvable bare names; anything else is out of reach
                # of a static check and is left alone rather than guessed at.
                if isinstance(target, ast.Name) and target.id not in tasks:
                    bad[f"{path.name}:{node.lineno}"] = target.id
    assert not bad, f"send_task_safe called with non-task target(s): {bad}"


def test_dispatch_error_handlers_cannot_throw():
    """The logger must never be the thing that crashes.

    `task.name` exists only on a registered task, so reading it inside the
    handler that fires *because* the target was not one replaces the real
    error with a second traceback from the reporting code. That is what
    turned the §115 outage into two stacked tracebacks with the actual
    AttributeError buried.

    Asserted statically rather than behaviourally: exercising it means
    importing celery_app, and the machine this is written on has no celery
    (CLAUDE.md §37). A static check that runs is worth more here than a
    behavioural one that does not.
    """
    # Parsed, not sliced out of the text: both of these functions explain
    # the hazard in their own comments, which name `task.name` -- so a
    # substring check over the source matches the prose rather than the
    # code. (This bit me twice writing this file.)
    module = ast.parse(CELERY_APP.read_text())
    funcs = {
        n.name: n for n in module.body
        if isinstance(n, ast.FunctionDef)
    }
    for name in ("_task_label", "_dispatch_task"):
        assert name in funcs, f"{name} is missing from celery_app.py"
        body = ast.unparse(ast.Module(body=funcs[name].body[
            1 if ast.get_docstring(funcs[name]) else 0:], type_ignores=[]))
        assert "task.name" not in body, (
            f"{name} reads task.name directly; on a non-task target that "
            f"raises inside the very handler meant to report it"
        )
    dispatch_body = ast.unparse(funcs["_dispatch_task"])
    assert "_task_label(task)" in dispatch_body, "handlers should label via _task_label"
    assert dispatch_body.count("exc_info=True") == 2, (
        "both handlers need exc_info, or the log names the task without saying why"
    )


def _all_task_names() -> dict:
    """{task name -> module} for EVERY @celery_app.task in tasks/.

    Not just the beat-scheduled ones. A task without an explicit `name=` is
    auto-named `<module path>.<function>`, which is what task_routes matches
    against — so its routing is only correct as long as that path is what
    the route patterns expect. transcribe_asset and process_asset are both
    in this category, and neither was covered before §126.
    """
    out = {}
    for path in (API / "tasks").glob("*.py"):
        module = f"apps.api.tasks.{path.stem}"
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, ast.FunctionDef) or not node.decorator_list:
                continue
            decs = [ast.unparse(d) for d in node.decorator_list]
            if not any(k in d for d in decs for k in TASK_DECORATORS):
                continue
            explicit = None
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call):
                    for kw in dec.keywords:
                        if kw.arg == "name" and isinstance(kw.value, ast.Constant):
                            explicit = kw.value.value
            out[explicit or f"{module}.{node.name}"] = module
    return out


def test_every_task_reaches_a_consumed_queue():
    """Not only the scheduled ones (§126).

    Transcription was investigated three times on the theory that
    transcribe_asset never reached its worker. It does -- verified against
    the pinned celery 5.4.0/kombu 5.4.2 by tracing send_task: it publishes on
    the anonymous exchange with routing_key 'transcription', which is the
    Redis list the worker consumes. This makes that answer a check rather
    than an investigation.
    """
    consumed = _consumed_queues()
    known = set(re.findall(r'"([^"]+)"', re.search(
        r"KNOWN_UNROUTED = \{([^}]*)\}", _celery_source()).group(1)))

    stranded = {}
    for name, module in _all_task_names().items():
        if name in known:
            continue
        queue = _queue_for_name(name)
        if queue not in consumed:
            stranded[name] = queue
    assert not stranded, (
        f"task(s) routed to a queue no container consumes: {stranded}; "
        f"consumed queues are {sorted(consumed)}"
    )


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


def test_the_unrouted_exemption_list_is_exactly_what_we_expect():
    """The escape hatch, pinned shut (§182).

    `test_every_scheduled_task_lands_on_a_consumed_queue` SKIPS anything in
    KNOWN_UNROUTED. That is what let `purge_expired_trash` sit broken
    through three separate discoveries of its own bug class: the check was
    green the whole time, because the bug was on the exemption list.

    An exemption should be a deliberate, reviewed act. Adding a name here
    means editing this test, which means saying out loud in a diff that a
    scheduled task is knowingly not running.
    """
    known = set(re.findall(r'"([^"]+)"', re.search(
        r"KNOWN_UNROUTED = \{([^}]*)\}", _celery_source()).group(1)))
    assert known == {"send_due_date_reminders"}, (
        f"KNOWN_UNROUTED changed to {known}. Removing a name is the fix "
        f"landing — update this test. ADDING one means a scheduled task is "
        f"being knowingly left broken; say why in the diff."
    )


def test_purge_expired_trash_actually_reaches_a_worker():
    """§182 — the fix, asserted directly rather than only via the general
    check above, because this one has a history.

    Present in beat_schedule since Recently Deleted shipped, and never once
    executed: it declares an explicit name=, so the module glob never
    matched it and it fell through to `default`, which no container
    consumes.
    """
    registered = _registered_task_names()
    assert "purge_expired_trash" in registered, "the task is not defined"
    assert "purge_expired_trash" in _beat_task_names(), "it is not scheduled"

    queue = _queue_for_name("purge_expired_trash")
    consumed = _consumed_queues()
    assert queue in consumed, (
        f"purge_expired_trash routes to {queue!r}, which no worker consumes "
        f"(consumed: {sorted(consumed)}). 30-day retention would still be a "
        f"promise nothing keeps."
    )


def test_every_beat_task_is_routed_by_its_registered_name():
    """The bug CLASS, not this instance of it (§126, §143, §182).

    Three tasks have now been found falling through to `default` for the
    same reason: an explicit name= that no module glob can match. Each was
    found by a lucky read-through. This resolves every scheduled task the
    way Celery itself does — by registered name — and fails on the next one
    rather than waiting for a fourth accident.
    """
    consumed = _consumed_queues()
    known = set(re.findall(r'"([^"]+)"', re.search(
        r"KNOWN_UNROUTED = \{([^}]*)\}", _celery_source()).group(1)))
    registered = _registered_task_names()

    report = {}
    for name in _beat_task_names():
        if name in known:
            continue
        assert name in registered, f"beat_schedule names undefined task {name!r}"
        queue = _queue_for_name(name)
        report[name] = queue

    stranded = {n: q for n, q in report.items() if q not in consumed}
    assert not stranded, (
        f"scheduled task(s) whose REGISTERED name routes nowhere a worker "
        f"listens: {stranded}. Add both an explicit-name route and a module "
        f"glob, as the zip/LUT/purge tasks do."
    )
    # And prove the check has teeth: it must actually have resolved
    # something, rather than silently iterating an empty list.
    assert len(report) >= 4, f"only checked {len(report)} scheduled tasks"


def test_the_wall_clock_jobs_tick_often_enough_to_hit_their_window():
    """§182 — the window and the cadence have to agree.

    `purge_expired_trash` and `reconcile_file_sizes` are scheduled every 15
    minutes and each returns immediately unless it is their hour in
    `site_settings.timezone`. If either were put back on a daily crontab,
    it would fire once at a fixed UTC hour and its own window check would
    then reject it — the job would never run again, silently.
    """
    src = _celery_source()
    block = src[src.index("beat_schedule"):]
    for entry in ("purge-expired-trash", "reconcile-file-sizes"):
        at = block.index(f'"{entry}"')
        chunk = block[at:at + 400]
        assert 'crontab(minute="*/15")' in chunk, (
            f"{entry} must tick every 15 minutes; its task self-gates on a "
            f"local wall-clock window and a daily crontab would make the "
            f"two disagree"
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
