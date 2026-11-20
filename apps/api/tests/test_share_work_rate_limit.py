"""Share endpoints that queue server work are metered per link and per IP.

Export start, zip options and zip start used to have nothing in front of
them but the global 300-writes-a-minute middleware. They now go through
`middleware/rate_limit.share_work_rate_limit`, which is the comment write's
two-bucket check (`_meter_share_token_and_ip`) with its own budgets:

    export start   5 / 60s per link, 20 / 60s per IP
    zip options   10 / 60s per link, 40 / 60s per IP
    zip start      5 / 60s per link, 20 / 60s per IP

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


#: (kind, request, per-link budget) for the three metered endpoints.
METERED = [
    pytest.param("export", _export_start, 5, id="export-start"),
    pytest.param("zip_options", _zip_options, 10, id="zip-options"),
    pytest.param("zip_start", _zip_start, 5, id="zip-start"),
]


class TestExportStart:
    def test_the_sixth_start_within_the_window_is_429_with_retry_after(
        self, client, mock_db, fake_redis, unknown_link
    ):
        for _ in range(5):
            assert _export_start(client).status_code == 404
        throttled = _export_start(client)
        assert throttled.status_code == 429
        assert int(throttled.headers["Retry-After"]) >= 1

    def test_another_link_from_the_same_address_has_its_own_counter(
        self, client, mock_db, fake_redis, unknown_link
    ):
        for _ in range(6):
            _export_start(client, token=TOKEN)
        assert _export_start(client, token=TOKEN).status_code == 429
        assert _export_start(client, token=OTHER_TOKEN).status_code == 404

    def test_an_address_has_its_own_counter_across_links(
        self, client, mock_db, fake_redis, unknown_link
    ):
        """20 starts from one address, each on a different link, spend that
        address's budget and nobody else's."""
        for _ in range(20):
            assert _export_start(client, token=uuid.uuid4().hex, ip=IP).status_code == 404
        assert _export_start(client, token=uuid.uuid4().hex, ip=IP).status_code == 429
        assert _export_start(client, token=uuid.uuid4().hex, ip=OTHER_IP).status_code == 404

    def test_it_reopens_when_the_window_passes(
        self, client, mock_db, fake_redis, clock, unknown_link
    ):
        for _ in range(6):
            _export_start(client)
        assert _export_start(client).status_code == 429
        clock.advance(61)
        assert _export_start(client).status_code == 404

    def test_redis_down_fails_open_like_the_other_limiters(self, client, mock_db, unknown_link):
        with patch(
            "apps.api.services.redis_service.get_redis",
            side_effect=RuntimeError("redis is down"),
        ):
            for _ in range(20):
                assert _export_start(client).status_code == 404


class TestWiredIntoAllThree:
    @pytest.mark.parametrize("kind,send,budget", METERED)
    def test_budget_then_429(self, client, mock_db, fake_redis, unknown_link, kind, send, budget):
        for _ in range(budget):
            assert send(client).status_code == 404
        throttled = send(client)
        assert throttled.status_code == 429
        assert "Retry-After" in throttled.headers

    @pytest.mark.parametrize("kind,send,budget", METERED)
    def test_each_endpoint_has_its_own_redis_buckets(
        self, client, mock_db, fake_redis, unknown_link, kind, send, budget
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
        for _ in range(6):
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
        for _ in range(40):
            resp = client.request(method, path, params=params, headers={"x-real-ip": IP})
            assert resp.status_code == 404, resp.text
        assert not any("share_" in key for key in fake_redis.values)
