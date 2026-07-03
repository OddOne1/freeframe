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

        assert "720p/segment0.ts?token=tok123" in result
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
        response = hls_proxy("thumbnail.jpg", token=token, download=None)

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
