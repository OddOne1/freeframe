"""The streamed-zip endpoint, driven through the real app (§217).

A real `TestClient`, the real router, the real range parser, the real token
and a FAKE S3 — because the only thing that cannot be real here is the
bucket. Everything asserted is behaviour a client can observe: a status
code, a header, the bytes of the body, and whether an upstream connection
was closed.

Against a REAL Postgres, like test_zip_export_flow.py, because the
permission re-check on every request is SQL — a share link's enabled flag,
its expiry, its download variants, a project membership — and a mocked
session reports whatever the test tells it to.

    docker run -d --name ff-pg -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass \
      -e POSTGRES_DB=freeframe_test -p 55432:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:55432/freeframe_test \
      pytest apps/api/tests/test_zip_stream_endpoint.py
"""
import io
import os
import uuid
import zipfile
import zlib
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


# ── a fake bucket that records what was opened and closed ──────────────────

class _FakeBody:
    """A boto3 StreamingBody stand-in that knows whether it was closed.

    `closed` is the whole point: §217 requires that a client disconnect
    stops the upstream read, and the only way to prove that is to watch the
    handle. A leaked body is a socket held for the life of the worker.
    """

    def __init__(self, data: bytes):
        self._buf = io.BytesIO(data)
        self.closed = False
        self.reads = 0

    def read(self, size=-1):
        if self.closed:
            raise ValueError("read from a closed body")
        self.reads += 1
        return self._buf.read(size)

    def close(self):
        self.closed = True


class _FakeS3:
    def __init__(self, objects: dict):
        self.objects = dict(objects)
        self.bodies: list[_FakeBody] = []
        self.heads: list[str] = []
        self.gets: list[tuple] = []

    # boto3's exception namespace, enough for the code under test.
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def head_object(self, Bucket=None, Key=None):
        self.heads.append(Key)
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey(Key)
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket=None, Key=None, Range=None):
        self.gets.append((Key, Range))
        if Key not in self.objects:
            raise self.exceptions.NoSuchKey(Key)
        blob = self.objects[Key]
        if Range:
            first, last = Range.split("=", 1)[1].split("-")
            lo, hi = int(first), int(last)
            chunk = blob[lo : hi + 1]
            body = _FakeBody(chunk)
            self.bodies.append(body)
            return {
                "Body": body,
                "ContentLength": len(chunk),
                "ContentRange": f"bytes {lo}-{hi}/{len(blob)}",
            }
        body = _FakeBody(blob)
        self.bodies.append(body)
        return {"Body": body, "ContentLength": len(blob)}


# ── the world ──────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(autocommit=False, autoflush=False, bind=create_engine(PG_URL))


@pytest.fixture
def db(sessionmaker_):
    s = sessionmaker_()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def client(db):
    """The real app, with the real router, on the test's own session."""
    from fastapi.testclient import TestClient

    from apps.api.database import get_db
    from apps.api.main import app

    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


BLOBS = {
    "raw/one.mov": b"the first original" * 11,
    "raw/two.mov": bytes(range(256)) * 5,
    "raw/three.jpg": b"\xff\xd8\xff" + b"jpegish" * 23,
}


def _manifest(keys=None, *, created=None):
    from apps.api.services.zip_stream import dos_timestamp

    keys = keys or list(BLOBS)
    t, d = dos_timestamp(created or datetime(2026, 2, 3, 4, 5, 6, tzinfo=timezone.utc))
    out = []
    for i, key in enumerate(keys):
        blob = BLOBS[key]
        out.append(
            {
                "asset_id": str(uuid.uuid4()),
                "version_id": str(uuid.uuid4()),
                "asset_name": key.rsplit("/", 1)[1],
                "path": key.rsplit("/", 1)[1] if i else f"Sub/{key.rsplit('/', 1)[1]}",
                "variant": "raw",
                "fallback_reason": None,
                "applied_lut_id": None,
                "s3_key": key,
                "needs_render": False,
                "mtime": [t, d],
                "declared_size": len(blob),
                "size": len(blob),
                "crc32": zlib.crc32(blob) & 0xFFFFFFFF,
            }
        )
    return out


@pytest.fixture
def world(db):
    """A share link with downloads on, and a ready streamed export under it."""
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.share import DownloadVariant, ShareLink, SharePermission
    from apps.api.models.user import User
    from apps.api.models.zip_export import ZipExport, ZipExportStatus
    from apps.api.services import zip_stream as zs
    from apps.api.services import zip_export_service as zx

    owner = User(id=uuid.uuid4(), email=f"zs-{uuid.uuid4().hex[:8]}@e.com",
                 first_name="Z", last_name="S", password_hash="x")
    db.add(owner); db.flush()
    proj = Project(id=uuid.uuid4(), name="Streamed", created_by=owner.id)
    db.add(proj); db.flush()
    root = Folder(id=uuid.uuid4(), name="Root", project_id=proj.id, created_by=owner.id)
    db.add(root); db.flush()
    link = ShareLink(id=uuid.uuid4(), token=f"zs{uuid.uuid4().hex[:10]}", folder_id=root.id,
                     created_by=owner.id, permission=SharePermission.view,
                     allowed_download_variants=[v.value for v in DownloadVariant])
    db.add(link); db.flush()

    manifest = _manifest()
    entries = zx.streamable_entries(manifest)
    layout = zs.layout(entries)
    export = ZipExport(
        id=uuid.uuid4(), cache_key=uuid.uuid4().hex, share_link_id=link.id,
        project_id=proj.id, created_by=owner.id,
        s3_key=zx.zip_object_key(str(proj.id), "link", str(link.id), str(uuid.uuid4())),
        status=ZipExportStatus.ready, is_streamed=True,
        file_count=len(manifest), files_done=len(manifest), manifest=manifest,
        archive_size=layout.total_size, etag=zs.archive_etag(entries),
        total_bytes=layout.total_size,
        expires_at=datetime.now(timezone.utc) + timedelta(days=30),
    )
    db.add(export); db.commit()
    return dict(
        db=db, owner=owner, proj=proj, root=root, link=link, export=export,
        layout=layout, manifest=manifest,
    )


def _url(export, *, share_session=None, name="bundle.zip"):
    from apps.api.services import zip_download

    return zip_download.download_url_for(
        export, filename=name, share_session=share_session
    )


def _whole_archive(world) -> bytes:
    """The reference bytes, built by the pure layout module, not the route."""
    from apps.api.services import zip_stream as zs

    layout = world["layout"]
    out = bytearray()
    for seg, lo, hi in zs.byte_range(layout, 0, layout.total_size - 1):
        if seg.is_data:
            out += BLOBS[seg.s3_key][lo : hi + 1]
        else:
            out += zs.render(layout, seg)[lo : hi + 1]
    return bytes(out)


def _fake(objects=None):
    fake = _FakeS3(objects if objects is not None else BLOBS)
    return fake, patch(
        "apps.api.services.s3_service.get_s3_client", return_value=fake
    )


# ── the happy paths ────────────────────────────────────────────────────────

def test_a_full_download_is_a_valid_archive(world, client):
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]))

    assert resp.status_code == 200
    assert resp.headers["accept-ranges"] == "bytes"
    assert int(resp.headers["content-length"]) == world["layout"].total_size
    assert resp.headers["etag"] == f'"{world["export"].etag}"'
    assert "bundle.zip" in resp.headers["content-disposition"]
    assert resp.content == _whole_archive(world)

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        assert zf.testzip() is None
        for entry in world["manifest"]:
            assert zf.read(entry["path"]) == BLOBS[entry["s3_key"]]


def test_a_range_request_serves_exactly_that_slice(world, client):
    whole = _whole_archive(world)
    total = len(whole)
    for start, end in [
        (0, 9),
        (10, 10),
        (total - 5, total - 1),
        (total // 3, total // 3 + 100),
        (0, total - 1),
    ]:
        fake, patched = _fake()
        with patched:
            resp = client.get(
                _url(world["export"]), headers={"Range": f"bytes={start}-{end}"}
            )
        assert resp.status_code == 206, (start, end)
        assert resp.headers["content-range"] == f"bytes {start}-{end}/{total}"
        assert int(resp.headers["content-length"]) == end - start + 1
        assert resp.content == whole[start : end + 1], (start, end)


def test_an_open_ended_and_a_suffix_range_both_work(world, client):
    """The two other RFC 9110 forms `hls_proxy._parse_range_header` supports.
    Reused rather than re-implemented — a second range parser is how an
    off-by-one gets into one code path and not the other."""
    whole = _whole_archive(world)
    total = len(whole)

    fake, patched = _fake()
    with patched:
        open_ended = client.get(_url(world["export"]), headers={"Range": "bytes=100-"})
    assert open_ended.status_code == 206
    assert open_ended.content == whole[100:]

    fake, patched = _fake()
    with patched:
        suffix = client.get(_url(world["export"]), headers={"Range": "bytes=-64"})
    assert suffix.status_code == 206
    assert suffix.content == whole[total - 64 :]


def test_a_download_reassembled_from_several_ranges_is_the_same_archive(world, client):
    """What a resume actually does, through the real endpoint."""
    whole = _whole_archive(world)
    total = len(whole)
    out = bytearray()
    # Derived from the real total, not typed out: the cuts have to land
    # inside headers, inside file data and inside the central directory, and
    # a hard-coded offset past the end would turn this into a test of the
    # 416 path by accident.
    cuts = sorted(
        {0, 37, total // 4, total // 2, (3 * total) // 4, total - 11, total}
    )
    assert len(cuts) >= 6
    for lo, hi in zip(cuts, cuts[1:]):
        if lo >= hi:
            continue
        fake, patched = _fake()
        with patched:
            resp = client.get(
                _url(world["export"]), headers={"Range": f"bytes={lo}-{hi - 1}"}
            )
        assert resp.status_code == 206
        out += resp.content
    assert bytes(out) == whole
    with zipfile.ZipFile(io.BytesIO(bytes(out))) as zf:
        assert zf.testzip() is None


def test_head_answers_with_the_headers_and_no_body_and_no_upstream_reads(world, client):
    fake, patched = _fake()
    with patched:
        resp = client.head(_url(world["export"]))
    assert resp.status_code == 200
    assert int(resp.headers["content-length"]) == world["layout"].total_size
    assert resp.headers["accept-ranges"] == "bytes"
    assert resp.content == b""
    # A HEAD that HEADed every member would make "can I resume?" cost as
    # much as the download's first chunk.
    assert fake.heads == [] and fake.gets == []


def test_head_honours_a_range_too(world, client):
    fake, patched = _fake()
    with patched:
        resp = client.head(_url(world["export"]), headers={"Range": "bytes=5-9"})
    assert resp.status_code == 206
    assert resp.headers["content-range"].endswith(f"/{world['layout'].total_size}")
    assert resp.headers["content-length"] == "5"


# ── the refusals ───────────────────────────────────────────────────────────

def test_a_range_past_the_end_is_416_with_the_total(world, client):
    total = world["layout"].total_size
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]), headers={"Range": f"bytes={total}-"})
    assert resp.status_code == 416
    assert resp.headers["content-range"] == f"bytes */{total}"
    assert resp.headers["accept-ranges"] == "bytes"


@pytest.mark.parametrize("header", ["bytes=0-99,200-299", "items=0-10", "nonsense"])
def test_an_unusable_range_header_is_ignored_not_rejected(world, client, header):
    """RFC 9110 §14.2, and the same behaviour as hls_proxy: a multi-range or
    malformed header degrades into a plain 200 rather than failing the
    download outright."""
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]), headers={"Range": header})
    assert resp.status_code == 200
    assert resp.content == _whole_archive(world)


def test_a_stale_if_range_gets_a_full_200_not_a_corrupt_206(world, client):
    """THE corruption case. A 206 against a manifest that has changed makes
    the client append new bytes to old ones, and the archive's central
    directory then describes neither."""
    whole = _whole_archive(world)
    fake, patched = _fake()
    with patched:
        resp = client.get(
            _url(world["export"]),
            headers={"Range": "bytes=100-199", "If-Range": '"not-the-etag"'},
        )
    assert resp.status_code == 200
    assert "content-range" not in resp.headers
    assert resp.content == whole


def test_a_matching_if_range_still_gets_its_206(world, client):
    fake, patched = _fake()
    with patched:
        resp = client.get(
            _url(world["export"]),
            headers={
                "Range": "bytes=100-199",
                "If-Range": f'"{world["export"].etag}"',
            },
        )
    assert resp.status_code == 206
    assert resp.content == _whole_archive(world)[100:200]


def test_an_object_that_changed_size_fails_loudly_without_splicing(world, client):
    """§217 item 1. Serving the old layout over new bytes produces an archive
    that downloads cleanly and then fails extraction — after the user has
    waited for all of it."""
    changed = dict(BLOBS)
    key = world["manifest"][0]["s3_key"]
    changed[key] = BLOBS[key] + b"somebody re-uploaded this"

    fake, patched = _fake(changed)
    with patched:
        resp = client.get(_url(world["export"]))

    assert resp.status_code == 409
    assert "changed" in resp.json()["detail"].lower()
    # Not one byte of the mismatched object was read.
    assert fake.gets == []


def test_a_missing_object_also_fails_loudly(world, client):
    gone = {k: v for k, v in BLOBS.items() if k != world["manifest"][1]["s3_key"]}
    fake, patched = _fake(gone)
    with patched:
        resp = client.get(_url(world["export"]))
    assert resp.status_code == 409
    assert fake.gets == []


def test_an_export_that_is_still_preparing_cannot_be_streamed(world, client, db):
    from apps.api.models.zip_export import ZipExportStatus

    world["export"].status = ZipExportStatus.preparing
    db.commit()
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]))
    assert resp.status_code == 409


def test_a_pre_217_export_is_not_reachable_through_this_route(world, client, db):
    """Those rows have a real archive and are served through the media
    proxy. Reaching here means a URL was built by hand."""
    world["export"].is_streamed = False
    db.commit()
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]))
    assert resp.status_code == 404


# ── the token ──────────────────────────────────────────────────────────────

def test_no_token_is_refused(world, client):
    resp = client.get(f"/stream/zip/{world['export'].id}/download")
    assert resp.status_code == 422


def test_a_garbage_token_is_401_so_a_client_knows_to_renew(world, client):
    resp = client.get(f"/stream/zip/{world['export'].id}/download?token=nope")
    assert resp.status_code == 401


def test_an_expired_token_is_401(world, client):
    from apps.api.services import zip_download

    token = zip_download.create_download_token(world["export"].id, expires_hours=-1)
    resp = client.get(f"/stream/zip/{world['export'].id}/download?token={token}")
    assert resp.status_code == 401


def test_a_token_for_another_export_cannot_be_replayed(world, client):
    """The export id is taken from the PATH and compared, not trusted from
    the token — otherwise one legitimate link would be a key to every
    export."""
    from apps.api.services import zip_download

    other = zip_download.create_download_token(uuid.uuid4())
    resp = client.get(f"/stream/zip/{world['export'].id}/download?token={other}")
    assert resp.status_code == 403


def test_an_hls_prefix_token_is_not_accepted_here(world, client):
    """A token minted for one purpose must not be redeemable for another."""
    from apps.api.routers.hls_proxy import create_hls_token

    token = create_hls_token("raw/one.mov")
    resp = client.get(f"/stream/zip/{world['export'].id}/download?token={token}")
    assert resp.status_code == 403


# ── the permission re-check, on EVERY request ──────────────────────────────

def _range_requests(client, export, *, share_session=None):
    """Three successive Range requests, as a resumed download makes."""
    out = []
    for lo, hi in ((0, 99), (100, 199), (200, 299)):
        fake, patched = _fake()
        with patched:
            out.append(
                client.get(
                    _url(export, share_session=share_session),
                    headers={"Range": f"bytes={lo}-{hi}"},
                )
            )
    return out


def test_turning_downloads_off_mid_transfer_stops_the_next_range(world, client, db):
    """Not "stops the next token mint". The §143 rule is that a link whose
    downloads were switched off must not still hand back the archive, and a
    multi-hour transfer is exactly when that switch gets thrown."""
    first = _range_requests(client, world["export"])
    assert [r.status_code for r in first] == [206, 206, 206]

    world["link"].allowed_download_variants = []
    db.commit()

    after = _range_requests(client, world["export"])
    assert [r.status_code for r in after] == [403, 403, 403]


def test_disabling_the_link_mid_transfer_stops_the_next_range(world, client, db):
    world["link"].is_enabled = False
    db.commit()
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        403, 403, 403
    ]


def test_an_expired_link_stops_the_next_range(world, client, db):
    world["link"].expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db.commit()
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        410, 410, 410
    ]


def test_deleting_the_link_stops_the_next_range(world, client, db):
    world["link"].deleted_at = datetime.now(timezone.utc)
    db.commit()
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        404, 404, 404
    ]


def test_a_password_protected_link_needs_its_session_on_every_range(world, client, db):
    """A URL built without a share session must not quietly bypass the
    password, and one built with a session that has since expired must stop
    working — so the session is verified per request, not baked in."""
    import bcrypt

    world["link"].password_hash = bcrypt.hashpw(b"hunter2", bcrypt.gensalt()).decode()
    db.commit()

    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        403, 403, 403
    ]

    session_id = uuid.uuid4().hex
    with patch(
        "apps.api.services.permissions.verify_share_session", return_value=True
    ):
        ok = _range_requests(client, world["export"], share_session=session_id)
    assert [r.status_code for r in ok] == [206, 206, 206]

    # The same URL, once the session is gone.
    with patch(
        "apps.api.services.permissions.verify_share_session", return_value=False
    ):
        gone = _range_requests(client, world["export"], share_session=session_id)
    assert [r.status_code for r in gone] == [403, 403, 403]


def test_the_in_app_export_is_refused_once_the_creator_loses_the_project(
    world, client, db
):
    """The in-app flow has no share link, so `created_by` is the
    authorisation subject — and whether that user can still reach the
    project is re-asked on every request."""
    from apps.api.models.project import ProjectMember, ProjectRole

    world["export"].share_link_id = None
    db.commit()

    # Not a member, project not public -> refused.
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        403, 403, 403
    ]

    db.add(ProjectMember(id=uuid.uuid4(), project_id=world["proj"].id,
                         user_id=world["owner"].id, role=ProjectRole.owner))
    db.commit()
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        206, 206, 206
    ]


def test_a_deactivated_account_cannot_keep_downloading(world, client, db):
    from apps.api.models.project import ProjectMember, ProjectRole
    from apps.api.models.user import UserStatus

    world["export"].share_link_id = None
    db.add(ProjectMember(id=uuid.uuid4(), project_id=world["proj"].id,
                         user_id=world["owner"].id, role=ProjectRole.owner))
    db.commit()
    assert _range_requests(client, world["export"])[0].status_code == 206

    world["owner"].status = UserStatus.deactivated
    db.commit()
    assert [r.status_code for r in _range_requests(client, world["export"])] == [
        403, 403, 403
    ]


# ── upstream hygiene ──────────────────────────────────────────────────────

def test_every_upstream_body_is_closed_when_the_response_finishes(world, client):
    fake, patched = _fake()
    with patched:
        resp = client.get(_url(world["export"]))
    assert resp.status_code == 200
    assert fake.bodies, "the test did not reach the fake bucket at all"
    assert all(b.closed for b in fake.bodies)


def test_a_client_disconnect_closes_the_upstream_read(world, client):
    """§217 item 3 — "prove it". Starlette closes an abandoned generator,
    which raises GeneratorExit at the yield; without the `finally` the boto3
    body and the socket under it stay open for the life of the worker. A
    download manager that opens eight ranges and abandons seven is the
    normal case, not the exception.

    Driven against the generator directly rather than through TestClient,
    because TestClient has no way to hang up mid-body — and the thing under
    test is what happens when the consumer stops asking.
    """
    from apps.api.routers.zip_stream import _body_stream

    fake, patched = _fake()
    layout = world["layout"]
    with patched:
        stream = _body_stream(layout, 0, layout.total_size - 1)
        # Pull just enough to be inside a data segment.
        pulled = 0
        for chunk in stream:
            pulled += len(chunk)
            if fake.bodies and fake.bodies[0].reads:
                break
        assert fake.bodies, "never reached a data segment"
        assert not fake.bodies[0].closed, "closed before the disconnect"
        stream.close()          # what Starlette does on disconnect

    assert all(b.closed for b in fake.bodies)


def test_only_the_objects_in_the_range_are_touched(world, client):
    """The cost of a Range request is O(files in the range), not O(files in
    the archive) — which is what makes a resume inside a 105 GB original a
    single HEAD and a single GET."""
    layout = world["layout"]
    first_data = next(s for s in layout.segments if s.is_data)

    fake, patched = _fake()
    with patched:
        resp = client.get(
            _url(world["export"]),
            headers={"Range": f"bytes={first_data.offset}-{first_data.offset + 4}"},
        )
    assert resp.status_code == 206
    assert fake.heads == [first_data.s3_key]
    assert [k for k, _r in fake.gets] == [first_data.s3_key]
    assert fake.gets[0][1] == "bytes=0-4"
