"""The CRC-32 pass a streamed zip cannot exist without (§217).

Three things are checked here, and the second is the one with a history.

1. **The value.** A CRC of the wrong number of bytes is well-formed and
   wrong, and a zip carrying it downloads cleanly and then fails
   extraction. So: the chunk size must not change the answer, a short read
   must store nothing, and an object that changed size must store nothing.

2. **That it reaches a worker at all.** Read from the LIVE
   `celery_app.conf`, not from the source text. Five tasks in that file
   have reached production routed onto a queue no container consumes and
   silently never run — `apply_watermark` (§126), four zip tasks (§143),
   `purge_expired_trash` (§182) — and a unit test of the function would
   have passed for every one of them. The symptom here would be every
   batch download stuck at `preparing` forever.

3. **That one unreadable file does not poison the other ninety-nine.** The
   build path already skipped a member it could not read; the freeze has to
   do the same, or a single deleted object holds a whole selection at
   `preparing` for the rest of its TTL.

Against a REAL Postgres for the parts that are about rows, and against a
mocked session for nothing — `object_checksums` has a unique constraint and
a "write both columns or neither" rule, and both are properties of the
database.
"""
import os
import uuid
import zlib
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
needs_pg = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


# ── 2. the wiring, read from the REAL config ───────────────────────────────

class TestItActuallyReachesAWorker:
    """The check that would have caught §126, §143 and §182."""

    def test_both_tasks_are_registered_under_their_names(self):
        from apps.api.tasks.celery_app import celery_app
        import apps.api.tasks.crc_tasks  # noqa: F401 — registers them

        assert "compute_object_crc32" in celery_app.tasks
        assert "backfill_object_crc32" in celery_app.tasks

    @pytest.mark.parametrize(
        "name", ["compute_object_crc32", "backfill_object_crc32"]
    )
    def test_each_is_routed_by_its_bare_name(self, name):
        """Both declare `name=`, so a module glob cannot match them — the
        exact trap that stranded apply_watermark and purge_expired_trash."""
        from apps.api.tasks.celery_app import celery_app

        assert celery_app.conf.task_routes.get(name) == {"queue": "transcoding"}

    def test_the_module_glob_is_there_too_for_anything_added_later(self):
        from apps.api.tasks.celery_app import celery_app

        assert celery_app.conf.task_routes.get(
            "apps.api.tasks.crc_tasks.*"
        ) == {"queue": "transcoding"}

    def test_transcoding_is_a_queue_a_container_consumes(self):
        """Not merely declared. `docker-compose.prod.yml` must have a
        consumer for it, which is the half the route alone cannot promise."""
        from pathlib import Path

        from apps.api.tasks.celery_app import celery_app

        assert "transcoding" in {q.name for q in celery_app.conf.task_queues}

        compose = (
            Path(__file__).resolve().parents[3] / "docker-compose.prod.yml"
        ).read_text()
        assert "-Q transcoding" in compose, (
            "nothing in docker-compose.prod.yml consumes `transcoding`"
        )

    def test_the_module_is_in_the_include_list(self):
        """Routing a task that is never imported registers nothing."""
        from apps.api.tasks.celery_app import celery_app

        assert "apps.api.tasks.crc_tasks" in celery_app.conf.include

    def test_neither_is_on_the_knowingly_unrouted_list(self):
        from apps.api.tasks.celery_app import KNOWN_UNROUTED

        assert "compute_object_crc32" not in KNOWN_UNROUTED
        assert "backfill_object_crc32" not in KNOWN_UNROUTED

    def test_the_time_limits_stay_under_the_brokers_visibility_timeout(self):
        """§219 — with `acks_late`, a task that outlives the visibility
        timeout is redelivered and STARTED AGAIN. The CRC task is idempotent
        so that is survivable, but the ceilings should make it impossible
        rather than merely harmless."""
        from apps.api.config import settings
        from apps.api.tasks.crc_tasks import CRC_HARD_TIME_LIMIT, CRC_SOFT_TIME_LIMIT

        assert CRC_SOFT_TIME_LIMIT < CRC_HARD_TIME_LIMIT
        assert CRC_HARD_TIME_LIMIT < settings.celery_visibility_timeout_seconds

    def test_the_crc_task_cannot_take_both_transcode_slots(self):
        """The §217 "do not occupy a transcode slot" decision, as a number.
        `transcoding` runs at concurrency 2 and is also the transcoder."""
        from apps.api.config import settings

        assert settings.crc_max_concurrent < settings.transcoding_concurrency


# ── 1. the value ───────────────────────────────────────────────────────────

class _Body:
    """A body that hands out `chunk` bytes at a time, whatever is asked."""

    def __init__(self, data: bytes, served: int | None = None):
        self._data = data
        self._pos = 0
        self._served = served
        self.closed = False

    def read(self, size=-1):
        take = size if self._served is None else min(size, self._served)
        out = self._data[self._pos : self._pos + take]
        self._pos += len(out)
        return out

    def close(self):
        self.closed = True


@pytest.mark.parametrize("chunk", [1, 7, 1024, 8 * 1024 * 1024])
def test_the_chunk_size_does_not_change_the_answer(chunk):
    """The one way a CRC implementation goes wrong invisibly: carrying the
    running value between chunks incorrectly. A multi-chunk object has to
    agree with `zlib.crc32` over the whole thing."""
    from apps.api.tasks.crc_tasks import crc32_of_body

    data = bytes(range(256)) * 97          # 24,832 bytes, many chunks at 1
    crc, read = crc32_of_body(_Body(data), chunk_bytes=chunk)
    assert read == len(data)
    assert crc == zlib.crc32(data) & 0xFFFFFFFF


def test_a_body_that_returns_short_reads_still_produces_the_right_crc():
    """boto3 is allowed to return fewer bytes than asked for."""
    from apps.api.tasks.crc_tasks import crc32_of_body

    data = b"abcdefghij" * 500
    crc, read = crc32_of_body(_Body(data, served=3), chunk_bytes=1024)
    assert read == len(data)
    assert crc == zlib.crc32(data) & 0xFFFFFFFF


def test_an_empty_object_is_a_valid_crc_of_nothing():
    from apps.api.tasks.crc_tasks import crc32_of_body

    assert crc32_of_body(_Body(b""), chunk_bytes=64) == (zlib.crc32(b"") & 0xFFFFFFFF, 0)


# ── the store's refusals ───────────────────────────────────────────────────

@needs_pg
class TestTheStoreRefusesAWrongCrc:
    @pytest.fixture
    def db(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        s = sessionmaker(bind=create_engine(PG_URL))()
        try:
            yield s
        finally:
            s.rollback()
            s.close()

    def test_a_truncated_read_stores_nothing(self, db):
        """`bytes_read != ContentLength` means the connection ended early.
        The CRC on hand is a perfectly good CRC of the wrong data."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        with pytest.raises(cs.ChecksumSizeMismatch):
            cs.record_checksum(
                db, key, crc32=123, bytes_read=500, content_length=1000
            )
        assert cs.get_checksum(db, key) is None

    def test_an_object_that_changed_under_us_stores_nothing(self, db):
        """`bytes_read != expected_size`: the object was REPLACED between
        the caller deciding to read it and the read happening."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        with pytest.raises(cs.ChecksumSizeMismatch):
            cs.record_checksum(
                db, key, crc32=123, bytes_read=1000,
                content_length=1000, expected_size=900,
            )
        assert cs.get_checksum(db, key) is None

    def test_a_good_read_stores_both_columns_together(self, db):
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        row = cs.record_checksum(
            db, key, crc32=0xFFFFFFFF, bytes_read=1000,
            content_length=1000, expected_size=1000,
        )
        assert row.crc32 == 0xFFFFFFFF, "an unsigned CRC must survive the column"
        assert row.size_bytes == 1000
        assert row.verified_at is not None
        assert cs.is_verified(row)
        db.delete(row); db.commit()

    def test_a_failure_never_clears_an_existing_crc(self, db):
        """An object verified a month ago and unreachable for five minutes
        is still an object whose CRC we know."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        cs.record_checksum(db, key, crc32=7, bytes_read=10, content_length=10)
        cs.mark_attempt_failed(db, key, "the bucket hiccuped")
        row = cs.get_checksum(db, key)
        assert row.crc32 == 7 and cs.is_verified(row)
        db.delete(row); db.commit()

    def test_an_object_is_given_up_on_only_after_the_attempt_ceiling(self, db):
        from apps.api.config import settings
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        for n in range(1, settings.crc_max_attempts + 1):
            cs.begin_attempt(db, key)
            cs.mark_attempt_failed(db, key, "gone")
            row = cs.get_checksum(db, key)
            assert cs.has_given_up(row) is (n >= settings.crc_max_attempts), n
        db.delete(cs.get_checksum(db, key)); db.commit()

    def test_a_verified_object_is_never_in_the_work_queue_again(self, db):
        """The whole point: a 105 GB original is read ONCE, forever."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        assert cs.needs_checksum(db, [key]) == [key]
        cs.record_checksum(db, key, crc32=1, bytes_read=5, content_length=5)
        assert cs.needs_checksum(db, [key]) == []
        db.delete(cs.get_checksum(db, key)); db.commit()


# ── the task's own behaviour ───────────────────────────────────────────────

class _AlwaysFreeRedis:
    """A lease store that always grants and releases cleanly."""

    def __init__(self):
        self.held = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.held:
            return False
        self.held[key] = value
        return True

    def get(self, key):
        return self.held.get(key)

    def expire(self, key, seconds):
        return True

    def delete(self, key):
        self.held.pop(key, None)


@needs_pg
class TestTheTask:
    @pytest.fixture
    def db(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        s = sessionmaker(bind=create_engine(PG_URL))()
        try:
            yield s
        finally:
            s.rollback()
            s.close()

    @pytest.fixture
    def run_task(self, db):
        """Run the real task against the test's session and a fake bucket."""
        import apps.api.tasks.crc_tasks as ct

        class _NoClose:
            def __init__(self, inner):
                self._inner = inner

            def __getattr__(self, name):
                return getattr(self._inner, name)

            def close(self):
                pass

        def go(key, objects, *, expected_size=0):
            s3 = MagicMock()

            def get_object(Bucket=None, Key=None):
                if Key not in objects:
                    raise RuntimeError("NoSuchKey")
                blob = objects[Key]
                return {"Body": _Body(blob), "ContentLength": len(blob)}

            s3.get_object.side_effect = get_object
            # The lease needs Redis, and the lease is not what these tests
            # are about — it has its own, below. A fake keeps them
            # hermetic; CI has no Redis.
            with patch.object(ct, "SessionLocal", return_value=_NoClose(db)), \
                 patch.object(ct, "get_redis", return_value=_AlwaysFreeRedis()), \
                 patch.object(ct.s3_service, "get_s3_client", return_value=s3):
                return ct.compute_object_crc32(key, expected_size)

        return go

    def test_it_stores_the_right_crc(self, run_task, db):
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        blob = bytes(range(256)) * 300
        assert run_task(key, {key: blob}, expected_size=len(blob)) == "verified"

        row = cs.get_checksum(db, key)
        assert row.crc32 == zlib.crc32(blob) & 0xFFFFFFFF
        assert row.size_bytes == len(blob)
        db.delete(row); db.commit()

    def test_it_is_idempotent(self, run_task, db):
        """A redelivered message after §219's 12 h visibility timeout must
        not re-read 105 GB."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        blob = b"x" * 1000
        assert run_task(key, {key: blob}) == "verified"
        assert run_task(key, {key: blob}) == "already verified"
        db.delete(cs.get_checksum(db, key)); db.commit()

    def test_a_missing_object_is_recorded_and_not_raised(self, run_task, db):
        """One deleted file must cost its own entry and nothing else."""
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        assert run_task(key, {}) == "unreadable"
        row = cs.get_checksum(db, key)
        assert row.crc32 is None and row.error
        db.delete(row); db.commit()

    def test_an_object_that_is_not_the_expected_size_stores_nothing(
        self, run_task, db
    ):
        from apps.api.services import checksum_service as cs

        key = f"raw/{uuid.uuid4().hex}/o.mov"
        assert run_task(key, {key: b"y" * 100}, expected_size=99) == "size mismatch"
        row = cs.get_checksum(db, key)
        assert row.crc32 is None and "expected 99" in row.error
        db.delete(row); db.commit()

    def test_the_lease_caps_concurrency(self, db):
        """A second CRC job may not start while one is running, so one of
        the worker's two slots always stays free for a transcode."""
        import apps.api.tasks.crc_tasks as ct
        from apps.api.config import settings

        store = {}

        class _FakeRedis:
            def set(self, key, value, nx=False, ex=None):
                if nx and key in store:
                    return False
                store[key] = value
                return True

            def get(self, key):
                return store.get(key)

            def expire(self, key, seconds):
                return True

            def delete(self, key):
                store.pop(key, None)

        with patch.object(ct, "get_redis", return_value=_FakeRedis()):
            with ct._lease("first"):
                assert len(store) == settings.crc_max_concurrent
                with pytest.raises(ct._LeaseUnavailable):
                    with ct._lease("second"):
                        pass
            # Released on the way out, so the next job gets the slot.
            assert store == {}
            with ct._lease("third"):
                pass

    def test_the_lease_is_not_stolen_back_after_it_expires(self):
        """Refreshing a lease someone else now holds would give two readers
        the same slot."""
        import apps.api.tasks.crc_tasks as ct

        class _FakeRedis:
            def __init__(self):
                self.expired = []

            def set(self, key, value, nx=False, ex=None):
                return True

            def get(self, key):
                return "somebody-elses-token"

            def expire(self, key, seconds):
                self.expired.append(key)
                return True

            def delete(self, key):
                self.expired.append(("delete", key))

        fake = _FakeRedis()
        with patch.object(ct, "get_redis", return_value=fake):
            with ct._lease("x"):
                pass
        assert ("delete", "crc32_lease:0") not in fake.expired, (
            "released a lease it no longer owned"
        )


# ── the backfill ───────────────────────────────────────────────────────────

@needs_pg
class TestTheBackfill:
    @pytest.fixture
    def db(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        s = sessionmaker(bind=create_engine(PG_URL))()
        try:
            yield s
        finally:
            s.rollback()
            s.close()

    @pytest.fixture
    def media(self, db):
        """Two versions with raw objects, one of which also has a proxy."""
        from apps.api.models.asset import (
            Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
        )
        from apps.api.models.project import Project
        from apps.api.models.user import User

        owner = User(id=uuid.uuid4(), email=f"bf-{uuid.uuid4().hex[:8]}@e.com",
                     first_name="B", last_name="F", password_hash="x")
        db.add(owner); db.flush()
        proj = Project(id=uuid.uuid4(), name="Backfill", created_by=owner.id)
        db.add(proj); db.flush()
        rows = []
        for n, proxy in ((1, None), (2, f"proxies/{uuid.uuid4().hex}/1080.mp4")):
            a = Asset(id=uuid.uuid4(), name=f"a{n}", project_id=proj.id,
                      asset_type=AssetType.video, created_by=owner.id)
            db.add(a); db.flush()
            v = AssetVersion(id=uuid.uuid4(), asset_id=a.id, version_number=1,
                             processing_status=ProcessingStatus.ready,
                             created_by=owner.id)
            db.add(v); db.flush()
            mf = MediaFile(id=uuid.uuid4(), version_id=v.id,
                           s3_key_raw=f"raw/{uuid.uuid4().hex}/o.mov",
                           proxy_1080p_key=proxy, file_size_bytes=123,
                           mime_type="video/quicktime", file_type=FileType.video,
                           original_filename=f"a{n}.mov")
            db.add(mf); rows.append(mf)
        db.commit()
        return rows

    def _run(self, db, cursor=""):
        import apps.api.tasks.crc_tasks as ct

        class _NoClose:
            def __init__(self, inner):
                self._inner = inner

            def __getattr__(self, name):
                return getattr(self._inner, name)

            def close(self):
                pass

        queued = []
        requeued = []
        with patch.object(ct, "SessionLocal", return_value=_NoClose(db)), \
             patch.object(ct.compute_object_crc32, "apply_async",
                          side_effect=lambda args=None, **kw: queued.append(args)), \
             patch.object(ct.backfill_object_crc32, "apply_async",
                          side_effect=lambda args=None, **kw: requeued.append((args, kw))):
            result = ct.backfill_object_crc32(cursor)
        return result, queued, requeued

    def test_it_queues_one_object_at_a_time_and_re_queues_itself(self, db, media):
        """One command drains the whole library: the throttle is the
        countdown, so there is nothing to remember to run again."""
        from apps.api.config import settings

        result, queued, requeued = self._run(db)
        assert len(queued) == settings.crc_backfill_objects_per_run
        assert len(requeued) == 1
        assert requeued[0][1]["countdown"] == settings.crc_backfill_pause_seconds
        # And it carries a cursor, so the next run does not rescan from zero.
        assert requeued[0][0][0] == result["cursor"]

    def test_it_never_asks_for_a_crc_it_already_has(self, db, media):
        """"Skips rows that already have a CRC, never re-reads a verified
        one" — the property that makes starting it twice harmless."""
        from apps.api.services import checksum_service as cs

        first, queued_first, _ = self._run(db)
        key = queued_first[0][0]
        cs.record_checksum(db, key, crc32=5, bytes_read=1, content_length=1)

        _second, queued_second, _ = self._run(db)
        assert key not in [q[0] for q in queued_second]
        db.delete(cs.get_checksum(db, key)); db.commit()

    def test_it_resumes_from_its_cursor(self, db, media):
        result, _q, _r = self._run(db)
        cursor = result["cursor"]
        assert cursor
        again, queued, _r = self._run(db, cursor)
        # Nothing before the cursor is looked at again.
        assert again.get("cursor") != cursor or not queued

    def test_the_kill_switch_stops_it(self, db, media):
        import apps.api.tasks.crc_tasks as ct
        from apps.api.config import settings

        with patch.object(settings, "crc_backfill_enabled", False):
            result, queued, requeued = self._run(db)
        assert result == {"stopped": "disabled"}
        assert queued == [] and requeued == []

    def test_a_proxy_object_is_backfilled_too(self, db, media):
        """§57's persisted 1080p proxy is a stored object a batch may
        contain, so it needs a CRC exactly as the original does — and
        `media_files` columns alone could not have held both."""
        from apps.api.services import checksum_service as cs

        mf = media[1]
        keys = cs.downloadable_keys_for_media_file(mf)
        assert mf.s3_key_raw in keys
        assert mf.proxy_1080p_key in keys

    def test_the_key_list_agrees_with_what_a_batch_can_actually_contain(self, db, media):
        """`downloadable_keys_for_media_file` mirrors
        `zip_export_service.source_key_for`, which is the single place that
        decides which object backs which variant. Asserted rather than
        trusted, because the two live in different modules to avoid a cycle."""
        from apps.api.models.share import ALL_DOWNLOAD_VARIANTS
        from apps.api.services import checksum_service as cs
        from apps.api.services import zip_export_service as zx

        for mf in media:
            asset = MagicMock(applied_lut_id=None)
            from_source = {
                zx.source_key_for(v, mf)[0]
                for v in zx.stored_variants_for(ALL_DOWNLOAD_VARIANTS, asset, mf)
            }
            assert from_source == set(cs.downloadable_keys_for_media_file(mf))
