"""Tests for HLS streaming proxy."""
import pytest
from unittest.mock import MagicMock, patch
from jose import jwt


class TestCreateHlsToken:
    """Tests for HLS token generation."""

    def test_creates_valid_jwt(self):
        from apps.api.routers.hls_proxy import create_hls_token
        from apps.api.config import settings

        token = create_hls_token("hls/project-1/version-1")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

        assert payload["sub"] == "hls"
        assert payload["pfx"] == "hls/project-1/version-1"
        assert "exp" in payload


class TestVerifyHlsToken:
    """Tests for HLS token verification."""

    def test_valid_token(self):
        from apps.api.routers.hls_proxy import create_hls_token, _verify_hls_token

        token = create_hls_token("hls/proj/ver")
        prefix = _verify_hls_token(token)
        assert prefix == "hls/proj/ver"

    def test_invalid_token_raises(self):
        from apps.api.routers.hls_proxy import _verify_hls_token

        with pytest.raises(Exception) as exc_info:
            _verify_hls_token("garbage-token")
        assert exc_info.value.status_code == 401

    def test_wrong_sub_raises(self):
        from apps.api.routers.hls_proxy import _verify_hls_token
        from apps.api.config import settings

        token = jwt.encode(
            {"sub": "not-hls", "pfx": "some/path"},
            settings.jwt_secret,
            algorithm=settings.jwt_algorithm,
        )
        with pytest.raises(Exception) as exc_info:
            _verify_hls_token(token)
        assert exc_info.value.status_code == 403


class TestRewriteManifest:
    """Tests for m3u8 manifest URL rewriting."""

    def test_rewrites_ts_to_proxy_url(self):
        """Segments now go through the same media proxy (same token/prefix)
        instead of a direct presigned S3 URL — the bucket never needs to be
        publicly reachable."""
        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.000,\nsegment0.ts\n#EXT-X-ENDLIST"
        result = _rewrite_manifest(content, "hls/proj/ver", "720p/index.m3u8", "tok123")

        # NOT "720p/segment0.ts": per RFC 8216 §4.1 a client resolves this
        # reference against the level playlist's own URL, so prefixing the
        # manifest's directory here produced a double-nested 404 and broke
        # all playback — see _rewrite_manifest's docstring. This assertion
        # tracked the old, broken behaviour and was left red when that was
        # fixed; do not "restore" the prefix.
        assert "segment0.ts?token=tok123" in result
        assert "720p/segment0.ts" not in result
        assert "s3.example.com" not in result

    def test_rewrites_m3u8_to_proxy_url(self):
        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8"
        result = _rewrite_manifest(content, "hls/proj/ver", "master.m3u8", "tok123")

        assert "720p/index.m3u8?token=tok123" in result

    def test_preserves_comments_and_tags(self):
        from apps.api.routers.hls_proxy import _rewrite_manifest

        content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST"
        result = _rewrite_manifest(content, "hls/proj/ver", "index.m3u8", "tok123")

        assert result == content


class TestHlsProxyEndpoint:
    """Tests for object proxying and directory traversal prevention."""

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_proxies_non_manifest_objects(self, mock_get_client):
        """Non-.m3u8 objects (segments, thumbnails, images, ...) are now
        streamed through this container instead of being rejected — that's
        the whole point of the media proxy replacing direct S3 access."""
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token
        from fastapi.responses import StreamingResponse

        mock_body = MagicMock()
        mock_body.read.side_effect = [b"fake-jpeg-bytes", b""]
        mock_client = MagicMock()
        mock_client.get_object.return_value = {"Body": mock_body}
        mock_get_client.return_value = mock_client

        from apps.api.config import settings

        token = create_hls_token("hls/proj/ver")
        response = hls_proxy("thumbnail.jpg", token=token, download=None, range_header=None)

        assert isinstance(response, StreamingResponse)
        assert response.media_type == "image/jpeg"
        assert response.headers["Cache-Control"] == "max-age=86400"
        mock_client.get_object.assert_called_once_with(
            Bucket=settings.s3_bucket,
            Key="hls/proj/ver/thumbnail.jpg",
        )

    def test_rejects_directory_traversal(self):
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token

        token = create_hls_token("hls/proj/ver")
        with pytest.raises(Exception) as exc_info:
            hls_proxy("../../etc/passwd.m3u8", token=token)
        assert exc_info.value.status_code == 400

    def test_rejects_absolute_path(self):
        from apps.api.routers.hls_proxy import hls_proxy, create_hls_token

        token = create_hls_token("hls/proj/ver")
        with pytest.raises(Exception) as exc_info:
            hls_proxy("/etc/passwd.m3u8", token=token)
        assert exc_info.value.status_code == 400


def _client():
    """Drive the route through a real ASGI stack.

    Range behaviour can only be tested this way: calling `hls_proxy()`
    directly (as the tests above do) never exercises FastAPI's header
    binding, so it would not catch the alias being wrong — and a direct
    call leaves `range_header` as a `Header` object rather than a string.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from apps.api.routers.hls_proxy import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _s3_stub(body: bytes, *, total: int | None = None):
    """Mock S3 client whose get_object honours a Range kwarg like S3 does."""
    total = len(body) if total is None else total

    def get_object(**kwargs):
        payload = body
        if "Range" in kwargs:
            first, last = kwargs["Range"].removeprefix("bytes=").split("-")
            payload = body[int(first) : int(last) + 1]
        stream = MagicMock()
        chunks = [payload[i : i + 1024] for i in range(0, len(payload), 1024)] or [b""]
        stream.read.side_effect = chunks + [b""]
        return {"Body": stream, "ContentLength": len(payload)}

    client = MagicMock()
    client.get_object.side_effect = get_object
    client.head_object.return_value = {"ContentLength": total}
    return client


class TestHlsProxyRangeRequests:
    """§176 — Range/Content-Length support on the non-manifest branch."""

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_no_range_sets_content_length_and_accept_ranges(self, mock_get_client):
        """A plain request now advertises its size and that it is resumable.
        Before §176, ContentLength was fetched from S3 and dropped on the
        floor, so every response fell back to chunked transfer encoding."""
        from apps.api.routers.hls_proxy import create_hls_token

        client_stub = _s3_stub(b"x" * 5000)
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(f"/stream/hls/big.zip?token={token}")

        assert r.status_code == 200
        assert r.headers["content-length"] == "5000"
        assert r.headers["accept-ranges"] == "bytes"
        assert r.headers["content-type"] == "application/zip"
        assert len(r.content) == 5000
        client_stub.head_object.assert_not_called()
        assert "Range" not in client_stub.get_object.call_args.kwargs

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_mid_file_range_returns_206_with_only_those_bytes(self, mock_get_client):
        from apps.api.routers.hls_proxy import create_hls_token

        body = bytes(range(256)) * 40  # 10240 bytes, positionally distinct
        client_stub = _s3_stub(body)
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/big.zip?token={token}", headers={"Range": "bytes=1000-1499"}
        )

        assert r.status_code == 206
        assert r.headers["content-range"] == "bytes 1000-1499/10240"
        assert r.headers["content-length"] == "500"
        assert r.headers["accept-ranges"] == "bytes"
        assert r.content == body[1000:1500]
        assert client_stub.get_object.call_args.kwargs["Range"] == "bytes=1000-1499"

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_open_ended_range_runs_to_end_of_object(self, mock_get_client):
        """`bytes=N-` is what a resuming browser and curl --continue-at send:
        the client knows where it stopped, not where the file ends."""
        from apps.api.routers.hls_proxy import create_hls_token

        body = bytes(range(256)) * 40
        client_stub = _s3_stub(body)
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/big.zip?token={token}", headers={"Range": "bytes=10000-"}
        )

        assert r.status_code == 206
        assert r.headers["content-range"] == "bytes 10000-10239/10240"
        assert r.headers["content-length"] == "240"
        assert r.content == body[10000:]

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_suffix_range_returns_tail(self, mock_get_client):
        from apps.api.routers.hls_proxy import create_hls_token

        body = bytes(range(256)) * 40
        mock_get_client.return_value = _s3_stub(body)

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/big.zip?token={token}", headers={"Range": "bytes=-100"}
        )

        assert r.status_code == 206
        assert r.headers["content-range"] == "bytes 10140-10239/10240"
        assert r.content == body[-100:]

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_out_of_bounds_range_returns_416(self, mock_get_client):
        from apps.api.routers.hls_proxy import create_hls_token

        client_stub = _s3_stub(b"x" * 10000)
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/big.zip?token={token}", headers={"Range": "bytes=20000-20500"}
        )

        assert r.status_code == 416
        assert r.headers["content-range"] == "bytes */10000"
        client_stub.get_object.assert_not_called()

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_unparseable_range_falls_back_to_whole_file(self, mock_get_client):
        """RFC 9110 §14.2: an unparseable Range header is ignored. A
        multi-range request (out of scope here) therefore degrades to a
        plain 200 rather than failing the download outright."""
        from apps.api.routers.hls_proxy import create_hls_token

        client_stub = _s3_stub(b"q" * 4000)
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/big.zip?token={token}", headers={"Range": "bytes=0-9,20-29"}
        )

        assert r.status_code == 200
        assert "content-range" not in r.headers
        assert len(r.content) == 4000
        assert "Range" not in client_stub.get_object.call_args.kwargs

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_manifest_branch_ignores_range(self, mock_get_client):
        """Manifests stay a whole-file fetch — tiny text, never seeked."""
        from apps.api.routers.hls_proxy import create_hls_token

        stream = MagicMock()
        stream.read.return_value = b"#EXTM3U\nseg0.ts\n"
        client_stub = MagicMock()
        client_stub.get_object.return_value = {"Body": stream}
        mock_get_client.return_value = client_stub

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/index.m3u8?token={token}", headers={"Range": "bytes=0-5"}
        )

        assert r.status_code == 200
        assert "Range" not in client_stub.get_object.call_args.kwargs
        client_stub.head_object.assert_not_called()

    @patch("apps.api.routers.hls_proxy.get_s3_client")
    def test_range_preserves_download_disposition(self, mock_get_client):
        """A resumed download must still save under the right filename."""
        from apps.api.routers.hls_proxy import create_hls_token

        mock_get_client.return_value = _s3_stub(b"z" * 2000)

        token = create_hls_token("hls/proj/ver")
        r = _client().get(
            f"/stream/hls/e.zip?token={token}&download=Rope%20Challenge.zip",
            headers={"Range": "bytes=500-999"},
        )

        assert r.status_code == 206
        assert r.headers["content-disposition"] == 'attachment; filename="Rope Challenge.zip"'


class TestParseRangeHeader:
    """Unit-level coverage of the Range grammar itself."""

    @pytest.mark.parametrize(
        "header,total,expected",
        [
            ("bytes=0-99", 1000, (0, 99)),
            ("bytes=500-", 1000, (500, 999)),
            ("bytes=-200", 1000, (800, 999)),
            ("bytes=-5000", 1000, (0, 999)),      # suffix longer than the object
            ("bytes=0-9999", 1000, (0, 999)),     # end clamped to the last byte
            ("bytes=999-999", 1000, (999, 999)),  # single final byte
            ("  bytes=0-9  ", 1000, (0, 9)),
        ],
    )
    def test_satisfiable_ranges(self, header, total, expected):
        from apps.api.routers.hls_proxy import _parse_range_header

        assert _parse_range_header(header, total) == expected

    @pytest.mark.parametrize(
        "header,total",
        [
            ("bytes=1000-1100", 1000),  # start at/after EOF
            ("bytes=-0", 1000),         # zero-length suffix
            ("bytes=0-0", 0),           # empty object
        ],
    )
    def test_unsatisfiable_ranges(self, header, total):
        from apps.api.routers.hls_proxy import _parse_range_header, RANGE_UNSATISFIABLE

        assert _parse_range_header(header, total) == RANGE_UNSATISFIABLE

    @pytest.mark.parametrize(
        "header",
        [
            "bytes=0-99,200-299",  # multi-range, out of scope
            "items=0-99",          # non-byte unit
            "bytes=abc-def",
            "bytes=-",
            "garbage",
            "bytes=100-50",        # end before start
        ],
    )
    def test_ignored_headers_fall_back_to_whole_file(self, header):
        from apps.api.routers.hls_proxy import _parse_range_header

        assert _parse_range_header(header, 1000) is None
