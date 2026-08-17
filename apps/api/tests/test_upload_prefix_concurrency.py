"""Concurrent /upload/initiate against one fresh project (CLAUDE.md §27).

Runs against a REAL Postgres, because the bug is a Postgres deadlock and
SQLite cannot express it: `with_for_update()` is a no-op there, and there is
no KEY SHARE lock for a foreign key to conflict with. A mock session would
report success no matter what the ordering was.

The failure this pins:

    INSERT INTO assets      -> KEY SHARE lock on the referenced projects row
    SELECT ... FOR UPDATE   -> conflicts with every other initiate's KEY SHARE

Two concurrent initiates each end up holding KEY SHARE and waiting for FOR
UPDATE, and Postgres kills one with DeadlockDetected. Measured before the
fix: 12 concurrent initiates to a fresh project gave 2 successes and 10
deadlocks.

Skipped unless TEST_DATABASE_URL points at a Postgres with the schema
already migrated:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55440:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55440/freeframe \\
      pytest apps/api/tests/test_upload_prefix_concurrency.py
"""

import os
import threading
import uuid
from collections import Counter

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; the "
           "deadlock being tested cannot occur on SQLite",
)

N_CONCURRENT = 12
# Stands in for the S3 CreateMultipartUpload the request makes while its
# transaction is open. Any non-trivial duration is enough to make the
# ordering bug deterministic rather than a race.
FAKE_S3_SECONDS = 0.3


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="module", autouse=True)
def stub_s3():
    """The only thing stubbed. It SLEEPS on purpose: the defect was a row
    lock held across this network call, so an instant stub would hide it."""
    import time
    from apps.api.routers import upload as upload_router
    real = upload_router.create_multipart_upload
    upload_router.create_multipart_upload = (
        lambda key, content_type: (time.sleep(FAKE_S3_SECONDS), f"upload-{uuid.uuid4()}")[1]
    )
    yield
    upload_router.create_multipart_upload = real


@pytest.fixture(scope="module")
def user_id(sessionmaker_):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    uid = uuid.uuid4()
    s = sessionmaker_()
    s.add(User(id=uid, email=f"conc-{uid}@example.com", first_name="Conc", last_name="Tester",
               password_hash="x", role=UserGlobalRole.superadmin, status=UserStatus.active))
    s.commit()
    s.close()
    return uid


def _make_project(sessionmaker_, user_id, name):
    """A project with NO prefix locked — the only state that contends —
    plus the editor membership upload.py's permission gate requires."""
    from apps.api.models.project import Project, ProjectType, ProjectMember, ProjectRole
    pid = uuid.uuid4()
    s = sessionmaker_()
    s.add(Project(id=pid, name=name, project_type=ProjectType.personal,
                  created_by=user_id, created_by_name="Conc Tester"))
    s.flush()
    s.add(ProjectMember(project_id=pid, user_id=user_id, role=ProjectRole.owner))
    s.commit()
    s.close()
    return pid


@pytest.fixture
def fresh_project(sessionmaker_, user_id):
    return _make_project(sessionmaker_, user_id, "Concurrency Repro")


def _initiate_like(sessionmaker_, project_id, user_id, index, results, guard):
    """Calls the REAL initiate_upload endpoint function.

    Deliberately the shipped function rather than a copy of its steps: a
    local re-implementation would keep passing while upload.py's ordering
    regressed, which is precisely the bug being guarded against. Only the
    S3 CreateMultipartUpload is stubbed — and it sleeps, because the
    original defect was a row lock held across that network call.
    """
    from apps.api.models.user import User
    from apps.api.routers import upload as upload_router
    from apps.api.schemas.upload import InitiateUploadRequest

    db = sessionmaker_()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        body = InitiateUploadRequest(
            project_id=project_id,
            asset_name=f"clip{index}",
            original_filename=f"clip{index}.mov",
            mime_type="video/quicktime",
            file_size_bytes=1024,
        )
        res = upload_router.initiate_upload(body=body, db=db, current_user=user)
        with guard:
            results.append(("ok", res.s3_key.split("/")[1]))
    except BaseException as exc:  # noqa: BLE001 — classifying the failure is the point
        with guard:
            results.append((type(exc).__name__, str(exc).split("\n")[0][:120]))
    finally:
        try:
            db.close()
        except Exception:
            pass


def _run(sessionmaker_, project_id, user_id):
    results = []
    guard = threading.Lock()
    threads = [
        threading.Thread(target=_initiate_like,
                         args=(sessionmaker_, project_id, user_id, i, results, guard))
        for i in range(N_CONCURRENT)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def test_batch_initiate_does_not_deadlock(sessionmaker_, fresh_project, user_id):
    """The reported failure: most of a dropped batch 500s."""
    results = _run(sessionmaker_, fresh_project, user_id)
    outcomes = Counter(r[0] for r in results)
    assert outcomes.get("ok") == N_CONCURRENT, (
        f"expected all {N_CONCURRENT} to succeed, got {dict(outcomes)}: "
        + "; ".join(f"{a}: {b}" for a, b in results if a != "ok")
    )
    # Specifically, and by name — a generic "no exception" assertion would
    # not say which failure regressed.
    assert "OperationalError" not in outcomes


def test_all_agree_on_one_prefix(sessionmaker_, fresh_project, user_id):
    """The invariant the row lock exists for, and which the fix must keep.

    Two concurrent first uploads must not mint two different prefixes for
    one project — that would scatter one project's objects across two
    key namespaces.
    """
    results = _run(sessionmaker_, fresh_project, user_id)
    prefixes = {r[1] for r in results if r[0] == "ok"}
    assert len(prefixes) == 1, f"expected one prefix, got {prefixes}"


def test_repeated_fresh_projects_stay_consistent(sessionmaker_, user_id):
    """Run the whole race several times; a deadlock is order-dependent and
    a single green run proves less than it looks."""
    for _ in range(5):
        pid = _make_project(sessionmaker_, user_id, "Repeat Repro")
        results = _run(sessionmaker_, pid, user_id)
        outcomes = Counter(r[0] for r in results)
        prefixes = {r[1] for r in results if r[0] == "ok"}
        assert outcomes.get("ok") == N_CONCURRENT, dict(outcomes)
        assert len(prefixes) == 1, prefixes


def test_different_projects_are_not_serialised(sessionmaker_, user_id):
    """Concurrent first uploads to DIFFERENT projects must not queue behind
    each other — they contend on different rows, and the fix must not have
    introduced a global bottleneck."""
    import time

    pids = [_make_project(sessionmaker_, user_id, f"Parallel {i}") for i in range(N_CONCURRENT)]

    results = []
    guard = threading.Lock()
    threads = [
        threading.Thread(target=_initiate_like, args=(sessionmaker_, pid, user_id, 0, results, guard))
        for pid in pids
    ]
    started = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.time() - started

    assert Counter(r[0] for r in results).get("ok") == N_CONCURRENT
    # Serialised would be N * FAKE_S3_SECONDS; concurrent is ~one of them.
    # Half the serial time is a generous ceiling that still fails loudly if
    # a global lock ever gets reintroduced.
    assert elapsed < (N_CONCURRENT * FAKE_S3_SECONDS) / 2, (
        f"{N_CONCURRENT} different projects took {elapsed:.1f}s — that is "
        f"close to serial ({N_CONCURRENT * FAKE_S3_SECONDS:.1f}s)"
    )
