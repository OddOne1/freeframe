"""The server decides which parts make the file (§236).

Four separate ways `/upload/complete` and `/upload/abort` used to act on a
request body nobody had checked, and the tests for each are grouped below
in that order:

1. the part list was the CLIENT's, so an omitted part completed a
   truncated object (`TestThePartListIsTheStores`)
2. `body.asset_id` and `body.s3_key` were used unchecked, so a completion
   could be pointed at another asset (`TestTheBodysIdsAreBound`)
3. there was no state check, so a retry after a lost response 500'd and
   two concurrent calls both dispatched (`TestTheStateMachine`)
4. an abort could flip a finished version to `failed`
   (`TestAbortOnlyEndsAnUploadInProgress`)

── What S3 is here ─────────────────────────────────────────────────────
Real S3/AIStor is NOT available in this sandbox. Everything storage-side
runs against `tests/fake_multipart_store.FakeMultipartStore`, patched in
at `get_s3_client` so the REAL `services/s3_service.py` functions run on
top of it — the paginator in `list_multipart_parts`, the error
translation, all of it. Read that module's docstring for exactly what it
fakes; the one thing worth repeating here is that its
`complete_multipart_upload` ASSEMBLES WHATEVER SUBSET OF PARTS IT IS
GIVEN, because that is what a real store does and it is the behaviour the
whole change exists to stop the server from relying on. A fake that
refused a short list would let an unfixed server pass every test in this
file.

What this file therefore cannot show, and what the §236 report says
plainly: AIStor's real `ListParts` paging on a 6,000-part upload, a real
`CompleteMultipartUpload` over that many parts, and a real HEAD of a
100+ GB assembled object.
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from fastapi import HTTPException

from apps.api.models.asset import ProcessingStatus
from apps.api.tests.fake_multipart_store import FakeMultipartStore

MIB = 1024 * 1024
KEY = "raw/2026-01-02_shoot_p1/a1/v1/original.mov"
#: Three 16 MiB parts and a short tail: the ordinary shape of a real file.
PART = 16 * MIB
SIZES = {1: PART, 2: PART, 3: 7 * MIB}
DECLARED = sum(SIZES.values())
UPLOAD_ID = "u-236"


# ── the world a request runs in ─────────────────────────────────────────

class World:
    """A version + media file + mock session, and the call that runs the
    real route function against them.

    The route functions are called DIRECTLY rather than through
    `TestClient`: an `HTTPException` carries the status and the structured
    detail already, and reading them here is what the clients' branches
    key on. `TestTheErrorsReachTheWire` below goes over HTTP instead, for
    the one thing a direct call cannot show — that the detail dict
    survives serialisation.
    """

    def __init__(self, mock_db, status=ProcessingStatus.uploading,
                 declared=DECLARED, key=KEY, with_media_file=True,
                 owner=None):
        self.db = mock_db
        self.version = MagicMock()
        self.version.id = uuid.uuid4()
        self.version.asset_id = uuid.uuid4()
        self.version.created_by = owner or uuid.uuid4()
        self.version.processing_status = status
        self.version.processing_started_at = "untouched"
        self.version.deleted_at = None

        self.media_file = None
        if with_media_file:
            self.media_file = MagicMock()
            self.media_file.version_id = self.version.id
            self.media_file.s3_key_raw = key
            self.media_file.file_size_bytes = declared
            self.media_file.size_verified_at = None

        self.user = MagicMock()
        self.user.id = self.version.created_by

        self.store = FakeMultipartStore()
        self.background = MagicMock()
        mock_db.query.return_value.filter.return_value.first.side_effect = [
            self.version, self.media_file,
        ]

    # ── storage state ──────────────────────────────────────────────────

    def seed_parts(self, sizes, upload_id=UPLOAD_ID, key=None):
        self.store.seed_upload(key or KEY, upload_id, sizes)
        return self

    def seed_object(self, size, key=None):
        self.store.objects[key or KEY] = size
        return self

    # ── the calls ──────────────────────────────────────────────────────

    def complete(self, *, parts=None, key=None, asset_id=None, upload_id=UPLOAD_ID,
                 version_id=None):
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import CompleteUploadRequest

        body = CompleteUploadRequest(
            s3_key=key if key is not None else KEY,
            upload_id=upload_id,
            asset_id=asset_id or self.version.asset_id,
            version_id=version_id or self.version.id,
            **({"parts": parts} if parts is not None else {}),
        )
        with patch("apps.api.services.s3_service.get_s3_client",
                   return_value=self.store):
            return upload_router.complete_upload(
                body, self.background, db=self.db, current_user=self.user
            )

    def abort(self, *, key=None, upload_id=UPLOAD_ID, version_id=None):
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import AbortUploadRequest

        body = AbortUploadRequest(
            s3_key=key if key is not None else KEY,
            upload_id=upload_id,
            version_id=version_id or self.version.id,
        )
        with patch("apps.api.services.s3_service.get_s3_client",
                   return_value=self.store):
            return upload_router.abort_upload(
                body, db=self.db, current_user=self.user
            )

    # ── what happened ──────────────────────────────────────────────────

    @property
    def dispatched(self):
        """Every `_trigger_processing` dispatch, as (asset_id, version_id)."""
        from apps.api.routers import upload as upload_router

        return [
            call.args[1:]
            for call in self.background.add_task.call_args_list
            if call.args and call.args[0] is upload_router._trigger_processing
        ]

    @property
    def completed_parts(self):
        """The part numbers the store was asked to assemble, or None."""
        return self._completed

    _completed = None


def _detail_of(caught) -> dict:
    detail = caught.value.detail
    return detail if isinstance(detail, dict) else {"message": detail}


def _client_list(numbers):
    return [{"PartNumber": n, "ETag": f'"client-{n}"'} for n in numbers]


# ── 1. the part list is the store's ─────────────────────────────────────

class TestThePartListIsTheStores:
    def test_the_happy_path_completes_the_stores_list(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)

        resp = w.complete(parts=_client_list([1, 2, 3]))

        assert resp.status == "processing"
        assert w.store.objects[KEY] == DECLARED
        assert w.store.open_uploads() == []
        assert w.version.processing_status == ProcessingStatus.processing

    def test_the_clients_etags_are_not_what_gets_sent(self, mock_db):
        """The client's list here names every part, so a server that
        trusted it would still complete the file — with the WRONG ETags,
        which the store refuses. That refusal is the proof."""
        w = World(mock_db).seed_parts(SIZES)

        # `'"client-1"'` matches nothing the store holds; if these reached
        # CompleteMultipartUpload the fake would raise InvalidPart.
        resp = w.complete(parts=_client_list([1, 2, 3]))

        assert resp.status == "processing"
        assert w.store.objects[KEY] == DECLARED

    def test_a_client_that_reports_fewer_parts_still_completes_the_whole_file(
        self, mock_db
    ):
        """THE truncation bug, from the client's side. Before §236 this
        assembled 16 MiB of a 39 MiB file and called it done."""
        w = World(mock_db).seed_parts(SIZES)

        resp = w.complete(parts=_client_list([1]))

        assert resp.status == "processing"
        assert w.store.objects[KEY] == DECLARED

    def test_an_empty_client_list_is_not_an_error_any_more(self, mock_db):
        """`parts` is optional: a future client need not send one at all."""
        w = World(mock_db).seed_parts(SIZES)

        assert w.complete().status == "processing"
        assert w.store.objects[KEY] == DECLARED

    def test_a_missing_part_at_the_store_is_a_409_and_completes_nothing(
        self, mock_db
    ):
        """THE truncation bug, from the store's side: part 2 never arrived."""
        w = World(mock_db).seed_parts({1: PART, 3: 7 * MIB})

        with pytest.raises(HTTPException) as caught:
            w.complete(parts=_client_list([1, 2, 3]))

        assert caught.value.status_code == 409
        detail = _detail_of(caught)
        assert detail["code"] == "parts_incomplete"
        assert detail["missing"] == [2]
        # Nothing completed, nothing dispatched, and the upload is LEFT
        # OPEN so the client can send part 2 and try again.
        assert KEY not in w.store.objects
        assert w.store.count("complete_multipart_upload") == 0
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.dispatched == []
        assert (KEY, UPLOAD_ID) in w.store.open_uploads()
        assert w.db.commit.call_count == 0

    def test_a_gap_names_every_missing_number(self, mock_db):
        w = World(mock_db, declared=5 * PART).seed_parts(
            {1: PART, 4: PART, 5: PART}
        )

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert _detail_of(caught)["missing"] == [2, 3]
        assert _detail_of(caught)["missing_count"] == 2

    def test_a_short_last_part_is_caught_by_the_byte_total(self, mock_db):
        """No part number is missing — part 3 is simply 17 bytes short. Only
        the sum of sizes can see this."""
        w = World(mock_db).seed_parts({1: PART, 2: PART, 3: 7 * MIB - 17})

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 409
        detail = _detail_of(caught)
        assert detail["code"] == "parts_incomplete"
        assert "missing" not in detail
        assert f"{DECLARED:,}" in detail["message"]
        assert KEY not in w.store.objects

    def test_a_store_holding_nothing_at_all_is_a_409(self, mock_db):
        w = World(mock_db).seed_parts({})

        with pytest.raises(HTTPException) as caught:
            w.complete(parts=_client_list([1, 2, 3]))

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "parts_incomplete"
        assert w.store.count("complete_multipart_upload") == 0

    def test_a_listing_that_cannot_be_paged_to_the_end_completes_nothing(
        self, mock_db
    ):
        """§215a — `IncompleteListingError`. A list that is short because
        paging broke is indistinguishable from a short upload, so it must
        not be completed from. 502, and the upload is untouched."""
        from apps.api.routers import upload as upload_router
        from apps.api.services.s3_service import IncompleteListingError

        w = World(mock_db).seed_parts(SIZES)

        with patch.object(upload_router, "list_multipart_parts",
                          side_effect=IncompleteListingError("paging stopped")):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 502
        assert _detail_of(caught)["code"] == "parts_unverifiable"
        assert KEY not in w.store.objects
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.dispatched == []

    def test_the_listing_is_strict(self, mock_db):
        """Not the lenient default. `list_multipart_parts(strict=False)`
        returns whatever it managed to read, which HERE would mean
        completing a file from a partial list — see §215a and that
        function's own docstring on why the mode is the caller's to pick.

        Asserted on the call rather than on an outcome, because the two
        modes differ only when paging breaks; a test that waited for that
        would be testing the paginator, which `list_multipart_parts` tests
        already do."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        sentinel = RuntimeError("stop here")
        with patch.object(upload_router, "list_multipart_parts",
                          side_effect=sentinel) as lmp:
            with pytest.raises(RuntimeError):
                w.complete()

        assert lmp.call_args.kwargs.get("strict") is True

    def test_a_broken_listing_is_unverifiable_not_a_short_upload(self, mock_db):
        """The lenient mode's answer is WRONG HERE, not merely slower.

        Run through the real `list_multipart_parts` against a store whose
        page says `IsTruncated` with no usable marker. `strict=True` raises
        and this endpoint answers 502 `parts_unverifiable` with the upload
        untouched. The default `strict=False` would hand back the parts it
        managed to read — and a short list of parts reads here as a short
        FILE, so the client would be told `parts_incomplete` and sent back
        to re-send parts the store already holds, up to its round limit,
        for a problem that is not its own.
        """
        w = World(mock_db).seed_parts(SIZES)
        store = w.store
        real_list_parts = store.list_parts

        def truncated(**kwargs):
            page = real_list_parts(**kwargs)
            # One part, then a cliff: truncated, and no marker to continue
            # from. Exactly §215a's shape.
            return {
                "Parts": page["Parts"][:1],
                "IsTruncated": True,
                "NextPartNumberMarker": None,
                "MaxParts": page["MaxParts"],
            }

        store.list_parts = truncated

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 502
        assert _detail_of(caught)["code"] == "parts_unverifiable"
        assert KEY not in store.objects
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.dispatched == []

    def test_more_than_one_page_of_parts_is_walked_to_the_end(self, mock_db):
        """`list_parts` returns at most 1,000 per page. A paginator that
        stopped at the first page would report 1,000 of 1,200 parts and
        refuse a complete file."""
        sizes = {n: 5 * MIB for n in range(1, 1201)}
        w = World(mock_db, declared=1200 * 5 * MIB).seed_parts(sizes)

        assert w.complete().status == "processing"
        assert w.store.objects[KEY] == 1200 * 5 * MIB
        # Proof it paged rather than guessed.
        assert w.store.count("list_parts") >= 2

    def test_a_client_that_used_a_different_part_size_still_completes(self, mock_db):
        """The checks are contiguity and the byte total, never the part
        size. An older web client cutting its own 10 MiB against a 16 MiB
        plan sends a complete file, and so does a resume that mixes two
        part sizes across runs."""
        sizes = {1: 10 * MIB, 2: 10 * MIB, 3: 10 * MIB, 4: 9 * MIB}
        w = World(mock_db, declared=39 * MIB).seed_parts(sizes)

        assert w.complete().status == "processing"
        assert w.store.objects[KEY] == 39 * MIB

    def test_a_zero_byte_file_completes_from_its_one_empty_part(self, mock_db):
        """Declared 0 is a legal file. The same two rules decide it: part 1
        must be there, and the sizes must total 0."""
        w = World(mock_db, declared=0).seed_parts({1: 0})

        assert w.complete().status == "processing"
        assert w.store.objects[KEY] == 0

    def test_a_zero_byte_file_with_no_parts_at_all_is_a_409(self, mock_db):
        """`CompleteMultipartUpload` needs at least one part, so there is
        nothing here that could be completed — and answering 200 would mark
        a version ready for an object that does not exist."""
        w = World(mock_db, declared=0).seed_parts({})

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "parts_incomplete"

    def test_a_duplicate_part_number_is_refused_rather_than_guessed(self, mock_db):
        """Two writes of one part cannot be chosen between from here, and
        picking the stale one assembles the wrong bytes silently."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db)
        listed = [
            {"PartNumber": 1, "ETag": '"a"', "Size": PART, "LastModified": None},
            {"PartNumber": 1, "ETag": '"b"', "Size": PART, "LastModified": None},
            {"PartNumber": 2, "ETag": '"c"', "Size": PART, "LastModified": None},
            {"PartNumber": 3, "ETag": '"d"', "Size": 7 * MIB, "LastModified": None},
        ]
        with patch.object(upload_router, "list_multipart_parts", return_value=listed):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "parts_incomplete"
        assert w.store.count("complete_multipart_upload") == 0

    def test_a_store_that_refuses_the_part_list_is_a_409_not_a_500(self, mock_db):
        """InvalidPart / EntityTooSmall: the store looked at a whole,
        contiguous list and would not assemble it. Retrying the identical
        request cannot help, so 409 — and the upload stays open."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        err = ClientError({"Error": {"Code": "InvalidPart", "Message": "no"}},
                          "CompleteMultipartUpload")
        with patch.object(upload_router, "complete_multipart_upload",
                          side_effect=err):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "parts_rejected"
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.dispatched == []

    def test_any_other_storage_failure_is_a_502_not_a_500(self, mock_db):
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        err = ClientError({"Error": {"Code": "ServiceUnavailable", "Message": "x"}},
                          "CompleteMultipartUpload")
        with patch.object(upload_router, "complete_multipart_upload",
                          side_effect=err):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 502
        assert _detail_of(caught)["code"] == "storage_error"
        assert w.version.processing_status == ProcessingStatus.uploading

    def test_an_unreachable_store_is_a_502_not_a_500(self, mock_db):
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        with patch.object(
            upload_router, "list_multipart_parts",
            side_effect=EndpointConnectionError(endpoint_url="http://s3.invalid"),
        ):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 502
        assert w.version.processing_status == ProcessingStatus.uploading


# ── 2. the body's ids are bound to the version ──────────────────────────

class TestTheBodysIdsAreBound:
    def test_a_key_that_is_not_this_versions_is_refused(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)

        with pytest.raises(HTTPException) as caught:
            w.complete(key="raw/other/project/original.mov")

        assert caught.value.status_code == 404
        assert caught.value.detail == "Upload not found"
        assert w.store.count("complete_multipart_upload") == 0
        assert w.store.count("list_parts") == 0
        assert w.dispatched == []

    def test_an_asset_id_that_is_not_this_versions_is_refused(self, mock_db):
        """The cross-asset dispatch. `process_asset` derives its output
        prefix and its event-stream project from the id it is handed, so a
        completion naming someone else's asset wrote this version's
        renditions under their prefix."""
        w = World(mock_db).seed_parts(SIZES)

        with pytest.raises(HTTPException) as caught:
            w.complete(asset_id=uuid.uuid4())

        assert caught.value.status_code == 404
        assert caught.value.detail == "Upload not found"
        assert w.store.count("complete_multipart_upload") == 0
        assert w.dispatched == []

    def test_both_refusals_read_identically_to_an_unknown_version(self, mock_db):
        """No oracle: "wrong asset" must not be distinguishable from
        "wrong key" or from "no such version"."""
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import CompleteUploadRequest

        messages = set()
        for kwargs in ({"key": "raw/nope.mov"}, {"asset_id": uuid.uuid4()}):
            w = World(mock_db).seed_parts(SIZES)
            with pytest.raises(HTTPException) as caught:
                w.complete(**kwargs)
            messages.add((caught.value.status_code, caught.value.detail))

        # And the unknown-version answer, which was always 404.
        mock_db.query.return_value.filter.return_value.first.side_effect = [None]
        body = CompleteUploadRequest(
            s3_key=KEY, upload_id=UPLOAD_ID, asset_id=uuid.uuid4(),
            version_id=uuid.uuid4(),
        )
        with pytest.raises(HTTPException) as caught:
            upload_router.complete_upload(
                body, MagicMock(), db=mock_db, current_user=MagicMock()
            )
        messages.add((caught.value.status_code, caught.value.detail))
        # ONE answer for all three. A different message per cause would
        # answer "which of these ids is the real one".
        assert messages == {(404, "Upload not found")}

    def test_another_users_version_is_still_a_403(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)
        w.user.id = uuid.uuid4()   # not the creator

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 403
        assert w.store.count("list_parts") == 0
        assert w.dispatched == []

    def test_the_dispatch_carries_the_versions_own_ids(self, mock_db):
        """Not the body's copies. With the check above in place they are
        equal — which is the point: the dispatch is right on its own."""
        w = World(mock_db).seed_parts(SIZES)

        w.complete()

        assert w.dispatched == [(w.version.asset_id, w.version.id)]

    def test_the_dispatch_does_not_READ_the_body_at_all(self):
        """Asserted on the SOURCE, because no behavioural test can say it.

        With the binding above in place `body.asset_id == version.asset_id`
        always, so dispatching either one produces an identical call — a
        mutation that puts `body.asset_id` back changes nothing observable
        and no test of behaviour can fail on it. (Upstream's own PR says
        the same: "with the guard in place those are equal, so it changes
        nothing today".)

        What is being protected is therefore not an outcome but a
        DEPENDENCY: the dispatch must be correct on its own rather than by
        way of a check somewhere else in the function, so that removing or
        weakening that check later cannot silently re-point a transcode at
        another project's prefix. A dependency is syntax, so syntax is what
        this reads — the same way `test_declared_dependencies.py` asserts
        about imports rather than about behaviour.
        """
        import ast
        import inspect

        from apps.api.routers import upload as upload_router

        tree = ast.parse(inspect.getsource(upload_router))
        fn = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "complete_upload"
        )
        dispatches = [
            call for call in ast.walk(fn)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr == "add_task"
            and call.args
            and isinstance(call.args[0], ast.Name)
            and call.args[0].id == "_trigger_processing"
        ]
        assert len(dispatches) == 1, "expected exactly one transcode dispatch"

        read_from_body = [
            node.attr for arg in dispatches[0].args[1:]
            for node in ast.walk(arg)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "body"
        ]
        assert read_from_body == [], (
            "the transcode dispatch reads "
            + ", ".join(f"body.{a}" for a in read_from_body)
            + " — it must read the version's own ids, so that it stays correct "
              "even if the check above is ever weakened"
        )

    def test_the_key_completed_is_the_rows_own(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)

        w.complete()

        assert [k for op, k in w.store.calls
                if op == "complete_multipart_upload"] == [KEY]


# ── 3. the state machine ────────────────────────────────────────────────

class TestTheStateMachine:
    @pytest.mark.parametrize("status", [ProcessingStatus.processing,
                                        ProcessingStatus.ready])
    def test_a_retry_after_success_is_an_idempotent_200(self, mock_db, status):
        """The desktop client retries /complete indefinitely by design, so
        this is the common case, not an edge one. Before §236 the retry
        reached S3 for an upload that no longer existed and 500'd an upload
        that had SUCCEEDED."""
        w = World(mock_db, status=status).seed_object(DECLARED)

        resp = w.complete(parts=_client_list([1, 2, 3]))

        assert resp.status == status.value
        assert resp.asset_id == w.version.asset_id
        assert resp.version_id == w.version.id
        # NOTHING happened a second time.
        assert w.dispatched == []
        assert w.store.calls == []
        assert w.db.commit.call_count == 0
        assert w.version.processing_status == status

    def test_a_second_complete_dispatches_nothing(self, mock_db):
        """Two calls in sequence, counting dispatches — the assertion the
        mutation 'drop the state check' has to fail."""
        first = World(mock_db).seed_parts(SIZES)
        first.complete()
        assert len(first.dispatched) == 1

        second = World(mock_db, status=ProcessingStatus.processing)
        second.store = first.store
        second.complete()
        assert second.dispatched == []

    def test_a_failed_version_is_a_409(self, mock_db):
        """§215's sweeper writes `failed` for an abandoned upload, and so
        does a cancel. An object happening to sit at the key does not
        override somebody's decision that this version is broken."""
        w = World(mock_db, status=ProcessingStatus.failed).seed_object(DECLARED)

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "upload_failed"
        assert w.store.calls == []
        assert w.dispatched == []
        assert w.version.processing_status == ProcessingStatus.failed

    def test_the_version_lookup_takes_a_row_lock(self, mock_db):
        """The check and the transition have to be one critical section.
        The real proof is the concurrency test against Postgres
        (test_upload_complete_concurrency.py); this is the cheap guard that
        the lock is still asked for at all."""
        w = World(mock_db).seed_parts(SIZES)

        w.complete()

        assert mock_db.with_for_update.called

    def test_a_completion_recorded_nowhere_is_recognised_and_finished(self, mock_db):
        """`CompleteMultipartUpload` succeeded and the process died before
        the commit: the upload id is consumed and the row still says
        `uploading`. One HEAD of the version's OWN key settles it."""
        w = World(mock_db).seed_object(DECLARED)   # object present, no upload

        resp = w.complete(parts=_client_list([1, 2, 3]))

        assert resp.status == "processing"
        assert w.version.processing_status == ProcessingStatus.processing
        assert w.dispatched == [(w.version.asset_id, w.version.id)]
        # It did NOT try to complete a second time.
        assert w.store.count("complete_multipart_upload") == 0

    def test_an_object_of_the_wrong_size_is_not_a_completion(self, mock_db):
        """Size is the check, not mere existence: a half-assembled object
        at the key must not be mistaken for the file."""
        w = World(mock_db).seed_object(DECLARED // 3)

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 404
        assert _detail_of(caught)["code"] == "no_such_upload"
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.dispatched == []

    def test_a_gone_upload_with_no_object_is_a_no_such_upload(self, mock_db):
        w = World(mock_db)   # no upload, no object

        with pytest.raises(HTTPException) as caught:
            w.complete()

        assert caught.value.status_code == 404
        assert _detail_of(caught)["code"] == "no_such_upload"

    def test_a_head_that_cannot_be_answered_does_not_throw_the_upload_away(
        self, mock_db
    ):
        """A timed-out HEAD is not evidence that a 100 GB object is absent,
        and both clients turn a 404 here into a fresh upload."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db)
        with patch.object(
            upload_router, "head_object_size",
            side_effect=EndpointConnectionError(endpoint_url="http://s3.invalid"),
        ):
            with pytest.raises(HTTPException) as caught:
                w.complete()

        assert caught.value.status_code == 502
        assert _detail_of(caught)["code"] == "storage_unavailable"
        assert w.version.processing_status == ProcessingStatus.uploading

    def test_the_queued_marker_is_cleared_on_the_transition(self, mock_db):
        """§219 — `processing` means queued, and NULL here is what keeps the
        stuck-processing sweeper off a file that is merely waiting."""
        w = World(mock_db).seed_parts(SIZES)

        w.complete()

        assert w.version.processing_started_at is None

    def test_the_crc_is_still_asked_for(self, mock_db):
        """§217 — and with the reconciled size, after the commit."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        w.complete()

        crc = [c.args[1:] for c in w.background.add_task.call_args_list
               if c.args and c.args[0] is upload_router._trigger_crc]
        assert crc == [(KEY, DECLARED)]


# ── 4. abort only ends an upload that is in progress ────────────────────

class TestAbortOnlyEndsAnUploadInProgress:
    def test_aborting_an_upload_in_progress_frees_it_and_fails_the_row(
        self, mock_db
    ):
        w = World(mock_db).seed_parts(SIZES)

        assert w.abort() is None
        assert w.store.open_uploads() == []
        assert w.version.processing_status == ProcessingStatus.failed
        assert w.db.commit.call_count == 1

    @pytest.mark.parametrize("status", [ProcessingStatus.processing,
                                        ProcessingStatus.ready])
    def test_a_finished_version_is_a_409_and_nothing_is_touched(
        self, mock_db, status
    ):
        """The reproduced bug: a `ready` version was flipped to `failed`
        and an S3 abort was fired at whatever key the body named — and
        `failed` is the status §114's reaper deletes the object for."""
        w = World(mock_db, status=status).seed_object(DECLARED)

        with pytest.raises(HTTPException) as caught:
            w.abort()

        assert caught.value.status_code == 409
        assert _detail_of(caught)["code"] == "upload_not_abortable"
        assert w.version.processing_status == status
        assert w.store.count("abort_multipart_upload") == 0
        assert w.db.commit.call_count == 0

    def test_aborting_an_already_failed_version_is_an_idempotent_204(
        self, mock_db
    ):
        w = World(mock_db, status=ProcessingStatus.failed)

        assert w.abort() is None
        assert w.version.processing_status == ProcessingStatus.failed
        assert w.store.count("abort_multipart_upload") == 0
        assert w.db.commit.call_count == 0

    def test_a_key_that_is_not_this_versions_is_refused(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)

        with pytest.raises(HTTPException) as caught:
            w.abort(key="raw/someone/elses/original.mov")

        assert caught.value.status_code == 404
        assert caught.value.detail == "Upload not found"
        assert w.store.count("abort_multipart_upload") == 0
        assert w.version.processing_status == ProcessingStatus.uploading

    def test_the_key_aborted_is_the_rows_own(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)

        w.abort()

        assert [k for op, k in w.store.calls
                if op == "abort_multipart_upload"] == [KEY]

    def test_an_upload_already_gone_at_the_store_still_resolves_the_row(
        self, mock_db
    ):
        """Nothing to free, but the row is the thing that says `uploading`
        — and §215's ghost pass exists because those get left behind."""
        w = World(mock_db)   # no open upload at the store

        assert w.abort() is None
        assert w.version.processing_status == ProcessingStatus.failed

    def test_a_storage_failure_leaves_the_row_alone(self, mock_db):
        """The parts are still in the bucket. Reporting success would hide
        that; failing the row would hide it behind a terminal status."""
        from apps.api.routers import upload as upload_router

        w = World(mock_db).seed_parts(SIZES)
        err = ClientError({"Error": {"Code": "AccessDenied", "Message": "x"}},
                          "AbortMultipartUpload")
        with patch.object(upload_router, "abort_multipart_upload", side_effect=err):
            with pytest.raises(HTTPException) as caught:
                w.abort()

        assert caught.value.status_code == 502
        assert w.version.processing_status == ProcessingStatus.uploading
        assert w.db.commit.call_count == 0

    def test_an_unknown_version_is_a_404(self, mock_db):
        from apps.api.routers import upload as upload_router
        from apps.api.schemas.upload import AbortUploadRequest

        mock_db.query.return_value.filter.return_value.first.side_effect = [None]
        body = AbortUploadRequest(s3_key=KEY, upload_id=UPLOAD_ID,
                                  version_id=uuid.uuid4())
        with pytest.raises(HTTPException) as caught:
            upload_router.abort_upload(body, db=mock_db,
                                       current_user=MagicMock())
        assert caught.value.status_code == 404

    def test_another_users_version_is_a_403(self, mock_db):
        w = World(mock_db).seed_parts(SIZES)
        w.user.id = uuid.uuid4()

        with pytest.raises(HTTPException) as caught:
            w.abort()

        assert caught.value.status_code == 403
        assert w.store.count("abort_multipart_upload") == 0


# ── the detail shape, over HTTP ─────────────────────────────────────────

class TestTheErrorsReachTheWire:
    """`lib/api.ts` reads `detail.code` off the JSON body, and the desktop
    app reads `err.code`. A dict that does not survive serialisation is a
    client branch that silently never fires."""

    def _post(self, client, mock_db, test_user, path, body, world_kwargs=None,
              seed=None, store=None):
        from apps.api.middleware.auth import get_current_user
        from apps.api.main import app

        w = World(mock_db, owner=test_user.id, **(world_kwargs or {}))
        if store is not None:
            w.store = store
        if seed:
            w.seed_parts(seed)
        app.dependency_overrides[get_current_user] = lambda: test_user
        try:
            with patch("apps.api.services.s3_service.get_s3_client",
                       return_value=w.store):
                return client.post(path, json={
                    "s3_key": KEY, "upload_id": UPLOAD_ID,
                    "asset_id": str(w.version.asset_id),
                    "version_id": str(w.version.id),
                    **body,
                })
        finally:
            app.dependency_overrides.pop(get_current_user, None)

    def test_parts_incomplete_arrives_as_a_code_and_a_message(
        self, client, mock_db, test_user
    ):
        resp = self._post(client, mock_db, test_user, "/upload/complete",
                          {"parts": []}, seed={1: PART, 3: 7 * MIB})

        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert detail["code"] == "parts_incomplete"
        assert detail["missing"] == [2]
        assert isinstance(detail["message"], str) and detail["message"]

    def test_upload_failed_arrives_as_a_code(self, client, mock_db, test_user):
        resp = self._post(client, mock_db, test_user, "/upload/complete",
                          {"parts": []},
                          world_kwargs={"status": ProcessingStatus.failed})

        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "upload_failed"

    def test_an_idempotent_retry_arrives_as_a_200(self, client, mock_db, test_user):
        store = FakeMultipartStore()
        store.objects[KEY] = DECLARED
        resp = self._post(client, mock_db, test_user, "/upload/complete",
                          {"parts": []},
                          world_kwargs={"status": ProcessingStatus.processing},
                          store=store)

        assert resp.status_code == 200
        assert resp.json()["status"] == "processing"

    def test_not_abortable_arrives_as_a_code(self, client, mock_db, test_user):
        resp = self._post(client, mock_db, test_user, "/upload/abort", {},
                          world_kwargs={"status": ProcessingStatus.ready})

        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "upload_not_abortable"
