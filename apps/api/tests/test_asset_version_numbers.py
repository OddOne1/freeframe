"""`POST /assets/{id}/versions` numbers a version the same way (§236b).

This is the endpoint the web app's own "upload a new version" button calls
(`startVersionUpload` in `apps/web/stores/upload-store.ts`), and until
§236b it computed `version_number` with its own copy of the two lines §236
fixed in `/upload/initiate`:

    last_version = ... .filter(deleted_at IS NULL).order_by(desc()).first()
    next_version_number = last + 1

`uq_asset_versions_asset_version` spans EVERY row, soft-deleted included,
and no lock was taken. So the exact 500 §236 closed stayed open here.
Reproduced against real Postgres on this endpoint before the fix, by
`test_the_next_version_after_deleting_the_latest_one_gets_a_number`:

    sqlalchemy.exc.IntegrityError: (psycopg2.errors.UniqueViolation)
    duplicate key value violates unique constraint
    "uq_asset_versions_asset_version"
    DETAIL:  Key (asset_id, version_number)=(<uuid>, 2) already exists.

REAL POSTGRES, for the same two reasons as §236's suite: the constraint
being tested exists nowhere else (the suite's mocked session has no
constraints at all and would report success for any numbering whatsoever),
and `with_for_update()` — the other half of the fix — is a no-op on SQLite.

    docker run -d --name ff236-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55446:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55446/freeframe \\
      pytest apps/api/tests/test_asset_version_numbers.py

S3 is the only thing stubbed, in BOTH routers: `create_multipart_upload`
returns an id after a deliberate 0.2s, because both endpoints hold the
asset row lock across that call and an instant stub would hide what that
serialises.
"""

import os
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timezone

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; the "
           "unique constraint being tested does not exist in the mocked session",
)

#: Stands in for the S3 CreateMultipartUpload each request makes while its
#: transaction is open. Non-zero on purpose — see the module docstring.
FAKE_S3_SECONDS = 0.2

FILE_SIZE = 30 * 1024 * 1024
MIME = "video/quicktime"
FILENAME = "A001C002.mov"


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="module", autouse=True)
def stub_s3():
    """Both routers. `assets.py` imports the name itself, so patching
    `upload.create_multipart_upload` alone would send half these tests at a
    bucket that is not there."""
    from apps.api.routers import assets as assets_router
    from apps.api.routers import upload as upload_router

    def fake(key, content_type):
        time.sleep(FAKE_S3_SECONDS)
        return f"upload-{uuid.uuid4()}"

    saved = (assets_router.create_multipart_upload,
             upload_router.create_multipart_upload)
    assets_router.create_multipart_upload = fake
    upload_router.create_multipart_upload = fake
    yield
    assets_router.create_multipart_upload, upload_router.create_multipart_upload = saved


@pytest.fixture
def world(sessionmaker_):
    """A project, an editor, a viewer, and three assets.

    `asset` has two `ready` versions; `fresh` has none (the
    first-version-of-an-existing-asset case); `other` is a second asset in
    the same project, for the "do these serialise against each other"
    measurement.

    Named rows only, deleted on the way out: this database may be a scratch
    copy of a real one, so nothing here truncates a table.
    """
    from apps.api.models.asset import (Asset, AssetType, AssetVersion, MediaFile,
                                       ProcessingStatus)
    from apps.api.models.project import (Project, ProjectMember, ProjectRole,
                                         ProjectType)
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    session = sessionmaker_()

    def _user(stem):
        u = User(
            email=f"{stem}-{uuid.uuid4().hex[:10]}@ff236b.test",
            first_name=stem.capitalize(), last_name="Tester", password_hash="x",
            status=UserStatus.active, role=UserGlobalRole.superadmin,
            email_verified=True,
        )
        session.add(u)
        session.commit()
        return u

    editor = _user("editor")
    viewer = _user("viewer")

    project = Project(name=f"Shoot-{uuid.uuid4().hex[:8]}", project_type=ProjectType.personal,
                      created_by=editor.id, created_by_name="Editor Tester")
    session.add(project)
    session.commit()
    session.add(ProjectMember(project_id=project.id, user_id=editor.id,
                              role=ProjectRole.owner))
    session.add(ProjectMember(project_id=project.id, user_id=viewer.id,
                              role=ProjectRole.viewer))
    session.commit()

    def _asset(name):
        a = Asset(project_id=project.id, name=name, asset_type=AssetType.video,
                  created_by=editor.id, created_by_name="Editor Tester")
        session.add(a)
        session.commit()
        return a

    asset = _asset("A001C002")
    fresh = _asset("A001C003")
    other = _asset("A001C004")
    for number in (1, 2):
        session.add(AssetVersion(asset_id=asset.id, version_number=number,
                                 processing_status=ProcessingStatus.ready,
                                 created_by=editor.id))
    session.commit()

    bag = {"session": session, "sessionmaker": sessionmaker_, "editor": editor,
           "viewer": viewer, "project": project, "asset": asset, "fresh": fresh,
           "other": other}
    try:
        yield bag
    finally:
        session.rollback()
        asset_ids = [asset.id, fresh.id, other.id]
        extra = [a.id for a in session.query(Asset).filter(
            Asset.project_id == project.id).all()]
        asset_ids = list({*asset_ids, *extra})
        version_ids = [v.id for v in session.query(AssetVersion).filter(
            AssetVersion.asset_id.in_(asset_ids)).all()]
        if version_ids:
            session.query(MediaFile).filter(
                MediaFile.version_id.in_(version_ids)).delete(synchronize_session=False)
        session.query(AssetVersion).filter(
            AssetVersion.asset_id.in_(asset_ids)).delete(synchronize_session=False)
        session.query(Asset).filter(Asset.id.in_(asset_ids)).delete(
            synchronize_session=False)
        session.query(ProjectMember).filter(
            ProjectMember.project_id == project.id).delete(synchronize_session=False)
        session.query(Project).filter(Project.id == project.id).delete(
            synchronize_session=False)
        session.query(User).filter(User.id.in_([editor.id, viewer.id])).delete(
            synchronize_session=False)
        session.commit()
        session.close()


# ── Driving the two real route functions ──────────────────────────────────

def _body(world, size=FILE_SIZE, mime=MIME, asset_id=None):
    from apps.api.schemas.upload import InitiateUploadRequest

    return InitiateUploadRequest(
        project_id=world["project"].id,
        asset_name="A001C002",
        original_filename=FILENAME,
        mime_type=mime,
        file_size_bytes=size,
        asset_id=asset_id,
    )


def _as(session, user):
    from apps.api.models.user import User

    return session.query(User).filter(User.id == user.id).first()


def _new_version(session, world, asset_id=None, user=None, **kw):
    """THE REAL route function behind POST /assets/{id}/versions."""
    from apps.api.routers import assets as assets_router

    target = asset_id or world["asset"].id
    return assets_router.initiate_new_version(
        asset_id=target,
        body=_body(world, **kw),
        db=session,
        current_user=_as(session, user or world["editor"]),
    )


def _initiate(session, world, asset_id=None):
    """THE REAL route function behind POST /upload/initiate."""
    from apps.api.routers import upload as upload_router

    return upload_router.initiate_upload(
        body=_body(world, asset_id=asset_id or world["asset"].id),
        db=session,
        current_user=_as(session, world["editor"]),
    )


def _numbers(session, asset_id):
    from apps.api.models.asset import AssetVersion

    session.expire_all()
    return sorted(
        (v.version_number, v.deleted_at is not None)
        for v in session.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id).all()
    )


def _add_version(session, asset_id, number, deleted=False):
    from apps.api.models.asset import AssetVersion, ProcessingStatus

    session.add(AssetVersion(
        asset_id=asset_id, version_number=number,
        processing_status=ProcessingStatus.ready,
        created_by=None,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    ))
    session.commit()


def _soft_delete(session, asset_id, number):
    from apps.api.models.asset import AssetVersion

    row = session.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.version_number == number,
    ).first()
    row.deleted_at = datetime.now(timezone.utc)
    session.commit()


# ── 1-2: a deleted number is retired, not recycled ────────────────────────

class TestADeletedNumberIsNotReused:
    def test_the_next_version_after_deleting_the_latest_one_gets_a_number(self, world):
        """THE reproduction. On `main` this raised IntegrityError -> 500."""
        from apps.api.models.asset import AssetVersion

        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 2)
        assert _numbers(session, asset.id) == [(1, False), (2, True)]

        resp = _new_version(session, world)

        assert _numbers(session, asset.id) == [(1, False), (2, True), (3, False)]
        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 3

    def test_the_latest_deleted_and_an_earlier_gap(self, world):
        """v2 and the latest (v4) deleted, v3 alive: the next one is v5.

        Not 3 (the old query's answer, a duplicate), not 4 (the gap), and
        not a reset to 1: "v3" in somebody's comment has to keep meaning
        the same upload."""
        from apps.api.models.asset import AssetVersion

        session, asset = world["session"], world["asset"]
        _add_version(session, asset.id, 3)
        _add_version(session, asset.id, 4)
        _soft_delete(session, asset.id, 2)
        _soft_delete(session, asset.id, 4)

        resp = _new_version(session, world)

        assert _numbers(session, asset.id) == [
            (1, False), (2, True), (3, False), (4, True), (5, False),
        ]
        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 5

    def test_every_version_deleted_still_moves_forward(self, world):
        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 1)
        _soft_delete(session, asset.id, 2)

        _new_version(session, world)

        assert _numbers(session, asset.id) == [(1, True), (2, True), (3, False)]

    def test_an_asset_with_no_versions_starts_at_one(self, world):
        from apps.api.models.asset import AssetVersion

        session = world["session"]

        resp = _new_version(session, world, asset_id=world["fresh"].id)

        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 1


# ── 3-4: concurrency, within this endpoint and across the two ─────────────

def _race(world, jobs):
    """Run `jobs` (each a callable taking a fresh session) at once."""
    results = []
    guard = threading.Lock()
    ready = threading.Barrier(len(jobs))

    def one(job):
        session = world["sessionmaker"]()
        try:
            ready.wait()
            resp = job(session)
            from apps.api.models.asset import AssetVersion
            number = session.query(AssetVersion).filter(
                AssetVersion.id == resp.version_id).first().version_number
            with guard:
                results.append(("ok", number))
        except BaseException as exc:   # noqa: BLE001 — classifying is the point
            with guard:
                results.append((type(exc).__name__, str(exc).split("\n")[0][:160]))
        finally:
            try:
                session.close()
            except Exception:
                pass

    threads = [threading.Thread(target=one, args=(j,)) for j in jobs]
    started = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results, time.monotonic() - started


def _count_reads(monkeypatch):
    """Record every `next_version_number` answer handed out.

    One read per request is the signature of a lock that worked: a request
    that had to read twice collided on the insert and was rescued by the
    retry inside `add_next_version`, which is a fallback, not the
    mechanism. Both numbering races below assert on this, because without
    it the retry alone makes them pass — it absorbs up to one collision per
    request, which is exactly as many as an unlocked race produces.
    """
    from apps.api.services import asset_versions as svc

    reads = []
    guard = threading.Lock()
    real = svc.next_version_number

    def counting(db, asset_id):
        number = real(db, asset_id)
        with guard:
            reads.append(number)
        return number

    monkeypatch.setattr(svc, "next_version_number", counting)
    return reads


class TestTwoNewVersionsAtOnce:
    """Two concurrent requests to THIS endpoint for one asset. Both read the
    highest number; without the row lock they read the same one and one of
    them dies on the insert — a 500 after the user picked a file."""

    def test_all_of_them_succeed_with_distinct_numbers(self, world):
        jobs = [lambda s: _new_version(s, world)] * 6
        results, _ = _race(world, jobs)

        outcomes = Counter(kind for kind, _ in results)
        assert outcomes.get("ok") == 6, (
            f"{dict(outcomes)}: "
            + "; ".join(f"{a}: {b}" for a, b in results if a != "ok")
        )
        assert sorted(n for k, n in results if k == "ok") == [3, 4, 5, 6, 7, 8]

    def test_the_lock_gets_there_first_so_nobody_retries(self, world, monkeypatch):
        reads = _count_reads(monkeypatch)

        results, _ = _race(world, [lambda s: _new_version(s, world)] * 6)

        assert Counter(k for k, _ in results).get("ok") == 6, results
        assert sorted(reads) == [3, 4, 5, 6, 7, 8], (
            "six requests should have read the highest number six times, once "
            "each. A repeated number means one of them collided on the insert "
            f"and was rescued by the retry rather than by the lock: {sorted(reads)}"
        )

    def test_it_still_works_with_the_latest_version_deleted(self, world):
        """Both halves at once: `max()` over all rows AND serialised readers."""
        session, asset = world["session"], world["asset"]
        _soft_delete(session, asset.id, 2)

        results, _ = _race(world, [lambda s: _new_version(s, world)] * 4)

        assert Counter(k for k, _ in results).get("ok") == 4, results
        assert sorted(n for k, n in results if k == "ok") == [3, 4, 5, 6]


class TestTheTwoEndpointsSerialiseAgainstEachOther:
    """§236b item C — the property §236 could not provide while this
    endpoint was out of scope. Both lock the SAME asset row before reading
    the highest number, so it does not matter which door a request came
    through."""

    def test_one_request_through_each_gets_distinct_numbers(self, world):
        results, _ = _race(world, [
            lambda s: _new_version(s, world),
            lambda s: _initiate(s, world),
        ])

        assert Counter(k for k, _ in results).get("ok") == 2, results
        assert sorted(n for k, n in results if k == "ok") == [3, 4]

    def test_three_through_each_door_at_once(self, world):
        results, _ = _race(world, [
            lambda s: _new_version(s, world), lambda s: _initiate(s, world),
            lambda s: _new_version(s, world), lambda s: _initiate(s, world),
            lambda s: _new_version(s, world), lambda s: _initiate(s, world),
        ])

        assert Counter(k for k, _ in results).get("ok") == 6, results
        assert sorted(n for k, n in results if k == "ok") == [3, 4, 5, 6, 7, 8]

    def test_neither_door_has_to_retry_either(self, world, monkeypatch):
        reads = _count_reads(monkeypatch)

        results, _ = _race(world, [
            lambda s: _new_version(s, world), lambda s: _initiate(s, world),
            lambda s: _new_version(s, world), lambda s: _initiate(s, world),
        ])

        assert Counter(k for k, _ in results).get("ok") == 4, results
        assert sorted(reads) == [3, 4, 5, 6], (
            "the two endpoints are not taking the same lock on the same row: "
            f"{sorted(reads)}"
        )

    def test_the_lock_is_what_does_it_not_the_endpoint(self, world):
        """The same race with the latest version deleted, through both
        doors: the retired number is not handed out by either."""
        session = world["session"]
        _soft_delete(session, world["asset"].id, 2)

        results, _ = _race(world, [
            lambda s: _initiate(s, world),
            lambda s: _new_version(s, world),
            lambda s: _initiate(s, world),
            lambda s: _new_version(s, world),
        ])

        assert Counter(k for k, _ in results).get("ok") == 4, results
        assert sorted(n for k, n in results if k == "ok") == [3, 4, 5, 6]


# ── The ordering question: where the storage-prefix lock goes ─────────────

class TestTheProjectLockIsNotHeldAcrossS3:
    """§236b — why `lock_storage_prefix` + `db.commit()` moved ahead of the
    version insert, as `initiate_upload` already does it (§14/§27).

    §27's KEY SHARE deadlock cannot happen on this endpoint: it inserts an
    `asset_versions` row and a `media_files` row, neither of which carries
    a foreign key to `projects`, so there is no KEY SHARE on the project
    row to deadlock a `FOR UPDATE` against. The LATENCY half of §27 does
    apply, and that is what this measures: held to the end of the request,
    that `FOR UPDATE` spans the S3 CreateMultipartUpload, so new versions
    of DIFFERENT files in one project queue up behind one S3 round trip
    each.

    Four at once, S3 stubbed at 0.2s: ~0.2s when the lock is committed
    first, ~0.8s when it is held (measured 0.87s with the old order)."""

    def test_four_different_assets_in_one_project_do_not_queue_up(self, world):
        session = world["session"]
        from apps.api.models.asset import Asset, AssetType

        extra = []
        for i in range(4):
            a = Asset(project_id=world["project"].id, name=f"B00{i}",
                      asset_type=AssetType.video, created_by=world["editor"].id,
                      created_by_name="Editor Tester")
            session.add(a)
            extra.append(a)
        session.commit()
        ids = [a.id for a in extra]

        results, elapsed = _race(
            world, [(lambda i: (lambda s: _new_version(s, world, asset_id=ids[i])))(i)
                    for i in range(4)])

        assert Counter(k for k, _ in results).get("ok") == 4, results
        assert all(n == 1 for k, n in results if k == "ok")
        # One S3 round trip's worth of slack for scheduling, well under the
        # 4 x 0.2s the serialised order cost.
        assert elapsed < 2 * FAKE_S3_SECONDS, (
            f"{elapsed:.2f}s for 4 concurrent new-version uploads in one "
            f"project: the project row lock is being held across S3 again"
        )


class TestTheAssetLockExcludesEveryOtherVersionWriter:
    """Why the lock is strong enough on its own, and what it costs.

    `asset_versions.asset_id` is a foreign key to `assets.id`, so ANY
    transaction inserting a version takes `FOR KEY SHARE` on that asset
    row — which conflicts with the `FOR UPDATE` this endpoint holds. A
    writer that never heard of the lock therefore cannot insert a version
    for this asset while an initiate is in flight; that is what makes the
    numbering safe rather than merely likely.

    The cost is the same conflict seen from the other side: anything with a
    foreign key to this asset row (a comment, a vote, an approval, a view)
    waits out the S3 round trip too. It is ~0.2s here and one
    CreateMultipartUpload in production, it is the same cost §236 accepted
    for `/upload/initiate`, and it is per-asset — but it is not nothing,
    and this test is where it is written down."""

    def test_an_fk_writer_on_the_same_asset_waits_for_the_initiate(self, world):
        from sqlalchemy import text

        done = threading.Event()
        waited = {}

        def initiate():
            session = world["sessionmaker"]()
            try:
                _new_version(session, world)
            finally:
                done.set()
                session.close()

        t = threading.Thread(target=initiate)
        t.start()
        time.sleep(FAKE_S3_SECONDS / 4)   # let it reach the S3 call

        other = world["sessionmaker"]()
        try:
            started = time.monotonic()
            # Exactly the lock an FK insert referencing this asset takes.
            other.execute(text("SELECT 1 FROM assets WHERE id = :id FOR KEY SHARE"),
                          {"id": str(world["asset"].id)})
            waited["seconds"] = time.monotonic() - started
            other.commit()
        finally:
            other.close()
        t.join()

        assert waited["seconds"] > FAKE_S3_SECONDS / 4, (
            "an FK writer did not wait for the asset lock, so the lock is "
            f"not being taken: waited {waited['seconds']:.3f}s"
        )


# ── The retry inside add_next_version ─────────────────────────────────────

class TestTheRetryTurnsACollisionIntoAVersionNotAnError:
    """What the retry in `add_next_version` is for, now that BOTH endpoints
    lock.

    Under Postgres with the lock held it cannot fire through either
    endpoint — the FK conflict above means no other transaction can insert
    a version for this asset at all (see
    `TestTheAssetLockExcludesEveryOtherVersionWriter`). It is defence in
    depth for the cases the lock does not reach: a caller passing
    `locked=False`, a repair script or migration writing versions directly,
    and SQLite, where `with_for_update()` is a no-op.

    So the collision here is INJECTED rather than raced: the number
    computation is made to return a stale number once, which is exactly
    what any of those cases looks like from inside this function. Without
    the retry the user gets a 409 ("try again") where they could have had
    their version; with it, the second read under a re-taken lock gets the
    right number and the upload proceeds."""

    def test_a_stale_number_is_recomputed_rather_than_refused(self, world, monkeypatch):
        from apps.api.models.asset import AssetVersion
        from apps.api.services import asset_versions as svc

        session = world["session"]
        calls = []
        real = svc.next_version_number

        def stale_once(db, asset_id):
            calls.append(asset_id)
            if len(calls) == 1:
                return 2          # already taken by this asset's v2
            return real(db, asset_id)

        monkeypatch.setattr(svc, "next_version_number", stale_once)

        resp = _new_version(session, world)

        assert len(calls) == 2, "the collision was not retried"
        created = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert created.version_number == 3
        assert _numbers(session, world["asset"].id) == [
            (1, False), (2, False), (3, False)]

    def test_a_collision_that_will_not_clear_is_a_409_not_a_500(self, world, monkeypatch):
        """The retry is ONE attempt, not a loop: a number that stays stale
        ends as a clean 409 the client can act on."""
        from fastapi import HTTPException
        from apps.api.services import asset_versions as svc

        session = world["session"]
        monkeypatch.setattr(svc, "next_version_number", lambda db, asset_id: 2)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world)

        assert caught.value.status_code == 409
        assert "version number" in caught.value.detail
        assert _numbers(session, world["asset"].id) == [(1, False), (2, False)]


# ── 5: the refusals, unchanged, leaving no row ────────────────────────────

class TestTheRefusalsAreUnchangedAndLeaveNoRow:
    """Order and status codes exactly as before §236b: 404 (unknown or
    deleted asset), 403 (not an editor), 400 (mime), 413 (too large) — and
    none of them may leave a version row behind, which is why every one of
    them still runs before the first write."""

    def _versions_everywhere(self, session, world):
        return {
            key: _numbers(session, world[key].id)
            for key in ("asset", "fresh", "other")
        }

    def test_an_unknown_asset_is_404(self, world):
        from fastapi import HTTPException

        session = world["session"]
        before = self._versions_everywhere(session, world)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world, asset_id=uuid.uuid4())

        assert caught.value.status_code == 404
        session.rollback()
        assert self._versions_everywhere(session, world) == before

    def test_a_deleted_asset_is_404(self, world):
        from fastapi import HTTPException
        from apps.api.models.asset import Asset

        session = world["session"]
        session.query(Asset).filter(Asset.id == world["other"].id).update(
            {"deleted_at": datetime.now(timezone.utc)}, synchronize_session=False)
        session.commit()
        before = self._versions_everywhere(session, world)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world, asset_id=world["other"].id)

        assert caught.value.status_code == 404
        session.rollback()
        assert self._versions_everywhere(session, world) == before

    def test_a_viewer_is_403(self, world):
        from fastapi import HTTPException

        session = world["session"]
        before = self._versions_everywhere(session, world)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world, user=world["viewer"])

        assert caught.value.status_code == 403
        session.rollback()
        assert self._versions_everywhere(session, world) == before

    def test_an_unsupported_mime_type_is_400(self, world):
        from fastapi import HTTPException

        session = world["session"]
        before = self._versions_everywhere(session, world)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world, mime="application/zip")

        assert caught.value.status_code == 400
        session.rollback()
        assert self._versions_everywhere(session, world) == before

    def test_a_file_too_large_to_split_is_413(self, world):
        from fastapi import HTTPException
        from apps.api.services.upload_policy import max_file_bytes

        session = world["session"]
        before = self._versions_everywhere(session, world)

        with pytest.raises(HTTPException) as caught:
            _new_version(session, world, size=max_file_bytes() + 1)

        assert caught.value.status_code == 413
        assert "GiB" in caught.value.detail
        session.rollback()
        assert self._versions_everywhere(session, world) == before

    def test_a_refusal_does_not_lock_the_projects_storage_prefix(self, world):
        """The refusals run before `lock_storage_prefix`, which is now
        committed in its own transaction — so a refused request must not
        freeze an unlocked project's prefix as a side effect."""
        from fastapi import HTTPException
        from apps.api.models.project import Project

        session = world["session"]
        project = session.query(Project).filter(
            Project.id == world["project"].id).first()
        assert project.storage_date_prefix is None, "fixture project starts unlocked"

        for kwargs in ({"mime": "application/zip"}, {"size": 10 ** 18}):
            with pytest.raises(HTTPException):
                _new_version(session, world, **kwargs)
            session.rollback()
            session.expire_all()
            project = session.query(Project).filter(
                Project.id == world["project"].id).first()
            assert project.storage_date_prefix is None


# ── 6: the response and the key are byte-for-byte what they were ──────────

class TestTheResponseAndTheKeyAreUnchanged:
    def test_the_first_version_of_an_existing_asset(self, world):
        """Response shape, part plan, S3 key format and the MediaFile row —
        none of which §236b touches, and all of which a reordering of this
        endpoint could have."""
        from apps.api.models.asset import AssetVersion, FileType, MediaFile, ProcessingStatus
        from apps.api.models.project import Project
        from apps.api.services.storage_prefix import prefix_for_project
        from apps.api.services.upload_policy import plan_parts

        session, fresh = world["session"], world["fresh"]

        resp = _new_version(session, world, asset_id=fresh.id)

        plan = plan_parts(FILE_SIZE)
        assert resp.asset_id == fresh.id
        assert resp.part_size == plan.part_size
        assert resp.total_parts == plan.total_parts
        assert resp.upload_id.startswith("upload-")

        session.expire_all()
        project = session.query(Project).filter(
            Project.id == world["project"].id).first()
        expected = (f"raw/{prefix_for_project(project)}/{fresh.id}/"
                    f"{resp.version_id}/original.mov")
        assert resp.s3_key == expected
        # And the prefix is the frozen, human-readable one (§14), not the
        # bare project id — i.e. the prefix lock still happens.
        assert project.storage_date_prefix is not None
        assert project.storage_slug is not None
        assert resp.s3_key.startswith(
            f"raw/{project.storage_date_prefix}_{project.storage_slug}_{project.id}/")

        version = session.query(AssetVersion).filter(
            AssetVersion.id == resp.version_id).first()
        assert version.version_number == 1
        assert version.processing_status == ProcessingStatus.uploading
        assert version.created_by == world["editor"].id
        assert version.created_by_name == world["editor"].name

        media = session.query(MediaFile).filter(
            MediaFile.version_id == resp.version_id).first()
        assert media.s3_key_raw == resp.s3_key
        assert media.file_type == FileType.video
        assert media.original_filename == FILENAME
        assert media.mime_type == MIME
        assert media.file_size_bytes == FILE_SIZE

    def test_a_new_version_of_an_asset_that_has_some(self, world):
        from apps.api.models.asset import MediaFile
        from apps.api.models.project import Project
        from apps.api.services.storage_prefix import prefix_for_project

        session, asset = world["session"], world["asset"]

        resp = _new_version(session, world)

        session.expire_all()
        project = session.query(Project).filter(
            Project.id == world["project"].id).first()
        assert resp.s3_key == (f"raw/{prefix_for_project(project)}/{asset.id}/"
                               f"{resp.version_id}/original.mov")
        media = session.query(MediaFile).filter(
            MediaFile.version_id == resp.version_id).first()
        assert media.s3_key_raw == resp.s3_key

    def test_the_two_endpoints_write_the_same_key_format(self, world):
        """Same asset, one upload through each door: the keys differ only in
        the version id."""
        session = world["session"]

        via_assets = _new_version(session, world)
        via_upload = _initiate(session, world)

        assert (via_assets.s3_key.replace(str(via_assets.version_id), "<v>")
                == via_upload.s3_key.replace(str(via_upload.version_id), "<v>"))
