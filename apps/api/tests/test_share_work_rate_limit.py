"""Share endpoints that queue server work are metered per IP and per link.

Export start, zip options and zip start go through
`middleware/rate_limit.share_work_rate_limit`, which is the comment write's
two-bucket check (`_meter_share_token_and_ip`) with its own budgets
(config.py defaults, all overridable by environment variable):

    export start   20 / 60s per IP, 240 / 60s per link
    zip options    20 / 60s per IP, 180 / 60s per link
    zip start      20 / 60s per IP, 180 / 60s per link

The polls, the stream, the thumbnail and the listing are deliberately NOT
metered — a viewer polls an export every few seconds.

Same harness as test_share_comment_rate_limit.py (imported, not copied): a
Redis whose clock the test owns, the global limiter and setup guard silenced,
and an "unknown link" so every request that gets past the limiter answers
404 — which also proves the limiter runs BEFORE the link is validated.
"""

import uuid
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from apps.api.middleware.rate_limit import share_token_bucket, share_work_rate_limit

# The fake Redis, its clock, and the autouse fixture that silences the
# global limiter and the setup guard — shared with the comment limiter's
# tests so both files exercise the one counter the same way.
from .test_share_comment_rate_limit import (  # noqa: F401
    _only_this_limiter_is_in_play,
    clock,
    fake_redis,
)

TOKEN = "t" * 32
OTHER_TOKEN = "u" * 32
IP = "203.0.113.9"
OTHER_IP = "198.51.100.7"
ASSET = str(uuid.uuid4())


@pytest.fixture
def unknown_link():
    """Every token is invalid: the route answers 404 unless the limiter bites."""
    with patch(
        "apps.api.routers.share.validate_share_link_with_session",
        side_effect=HTTPException(status_code=404, detail="Share link not found"),
    ):
        yield


def _export_start(client, token=TOKEN, ip=IP):
    return client.post(
        f"/share/{token}/export/{ASSET}",
        params={"variant": "proxy_720p"},
        headers={"x-real-ip": ip},
    )


def _zip_options(client, token=TOKEN, ip=IP):
    return client.post(
        f"/share/{token}/zip/options",
        json={"items": [{"asset_id": ASSET}]},
        headers={"x-real-ip": ip},
    )


def _zip_start(client, token=TOKEN, ip=IP):
    return client.post(
        f"/share/{token}/zip",
        json={"items": [{"asset_id": ASSET}], "variant": "raw"},
        headers={"x-real-ip": ip},
    )


PER_IP = 20

#: (kind, request, per-link budget) for the three metered endpoints.
METERED = [
    pytest.param("export", _export_start, 240, id="export-start"),
    pytest.param("zip_options", _zip_options, 180, id="zip-options"),
    pytest.param("zip_start", _zip_start, 180, id="zip-start"),
]


def _ip(n: int) -> str:
    """The n-th distinct visitor address, in 10.0.0.0/8 so there is room."""
    return f"10.{n // 65536 % 256}.{n // 256 % 256}.{n % 256}"


class TestPerIp:
    @pytest.mark.parametrize("kind,send,per_link", METERED)
    def test_the_21st_request_from_one_address_is_429_with_retry_after(
        self, client, mock_db, fake_redis, unknown_link, kind, send, per_link
    ):
        for _ in range(PER_IP):
            assert send(client, ip=IP).status_code == 404
        throttled = send(client, ip=IP)
        assert throttled.status_code == 429
        assert int(throttled.headers["Retry-After"]) >= 1

    @pytest.mark.parametrize("kind,send,per_link", METERED)
    def test_another_address_has_its_own_counter(
        self, client, mock_db, fake_redis, unknown_link, kind, send, per_link
    ):
        for _ in range(PER_IP + 1):
            send(client, ip=IP)
        assert send(client, ip=IP).status_code == 429
        assert send(client, ip=OTHER_IP).status_code == 404

    def test_the_address_budget_spans_links(self, client, mock_db, fake_redis, unknown_link):
        """20 starts from one address, each on a different link, spend that
        address's budget — a new link does not reset it."""
        for _ in range(PER_IP):
            assert _export_start(client, token=uuid.uuid4().hex, ip=IP).status_code == 404
        assert _export_start(client, token=uuid.uuid4().hex, ip=IP).status_code == 429

    def test_it_reopens_when_the_window_passes(
        self, client, mock_db, fake_redis, clock, unknown_link
    ):
        for _ in range(PER_IP + 1):
            _export_start(client)
        assert _export_start(client).status_code == 429
        clock.advance(61)
        assert _export_start(client).status_code == 404


class TestPerLink:
    @pytest.mark.parametrize("kind,send,per_link", METERED)
    def test_the_request_past_the_link_budget_is_429(
        self, client, mock_db, fake_redis, unknown_link, kind, send, per_link
    ):
        """Every request from a different address, so the per-IP bucket
        never fills and only the link's own counter can trip."""
        for n in range(per_link):
            assert send(client, token=TOKEN, ip=_ip(n)).status_code == 404
        throttled = send(client, token=TOKEN, ip=_ip(per_link))
        assert throttled.status_code == 429
        assert "Retry-After" in throttled.headers

    @pytest.mark.parametrize("kind,send,per_link", METERED)
    def test_another_link_has_its_own_counter(
        self, client, mock_db, fake_redis, unknown_link, kind, send, per_link
    ):
        for n in range(per_link + 1):
            send(client, token=TOKEN, ip=_ip(n))
        assert send(client, token=TOKEN, ip=_ip(per_link + 1)).status_code == 429
        assert send(client, token=OTHER_TOKEN, ip=_ip(per_link + 2)).status_code == 404


class TestWiring:
    def test_redis_down_fails_open_like_the_other_limiters(self, client, mock_db, unknown_link):
        with patch(
            "apps.api.services.redis_service.get_redis",
            side_effect=RuntimeError("redis is down"),
        ):
            for _ in range(PER_IP * 2):
                assert _export_start(client).status_code == 404

    @pytest.mark.parametrize("kind,send,per_link", METERED)
    def test_each_endpoint_has_its_own_redis_buckets(
        self, client, mock_db, fake_redis, unknown_link, kind, send, per_link
    ):
        """Its own action names — an export flood does not spend the zip
        budget — and the token is hashed, never stored as a key."""
        from apps.api.services.redis_service import RATE_LIMIT_PREFIX

        send(client)
        keys = list(fake_redis.values)
        assert f"{RATE_LIMIT_PREFIX}share_{kind}_token:{share_token_bucket(TOKEN)}" in keys
        assert f"{RATE_LIMIT_PREFIX}share_{kind}_ip:{IP}" in keys
        assert not any(TOKEN in key for key in keys)

    def test_the_three_budgets_are_independent(self, client, mock_db, fake_redis, unknown_link):
        for _ in range(PER_IP + 1):
            _export_start(client)
        assert _export_start(client).status_code == 429
        assert _zip_start(client).status_code == 404
        assert _zip_options(client).status_code == 404

    def test_an_unknown_kind_is_refused_at_import_time(self):
        with pytest.raises(ValueError):
            share_work_rate_limit("stream")


class TestNotMetered:
    """A viewer polls an export or a zip every few seconds, and the player
    asks for streams and thumbnails constantly. None of these may 429."""

    @pytest.mark.parametrize("method,path,params", [
        pytest.param("GET", f"/share/{TOKEN}/export/{ASSET}/{uuid.uuid4()}",
                     {"version_id": str(uuid.uuid4()), "variant": "proxy_720p"}, id="export-poll"),
        pytest.param("GET", f"/share/{TOKEN}/zip/{uuid.uuid4()}", {}, id="zip-poll"),
        pytest.param("GET", f"/share/{TOKEN}/stream/{ASSET}", {}, id="stream"),
        pytest.param("GET", f"/share/{TOKEN}/thumbnail/{ASSET}", {}, id="thumbnail"),
        pytest.param("GET", f"/share/{TOKEN}/assets", {}, id="listing"),
    ])
    def test_never_429(self, client, mock_db, fake_redis, unknown_link, method, path, params):
        for _ in range(PER_IP * 3):
            resp = client.request(method, path, params=params, headers={"x-real-ip": IP})
            assert resp.status_code == 404, resp.text
        assert not any("share_" in key for key in fake_redis.values)
