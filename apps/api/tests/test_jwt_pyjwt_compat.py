"""python-jose was replaced by PyJWT without changing a single token (§245).

The property that matters is not "PyJWT can read what PyJWT wrote" — that
would pass with any secret, any claim layout and any algorithm. It is that
every token alive at deploy time keeps working, and that a token minted
after the deploy is still accepted if the deploy is rolled back. So the
tokens below were NOT produced by this code. They were minted BEFORE the
swap, at base 31d1131, with python-jose 3.5.0 installed, by the real
minters (create_access_token, create_refresh_token, create_2fa_pending_token
with and without `via=`, create_hls_token, create_download_token), with the
modules' `datetime.now` frozen at 2099-01-01 UTC so they stay valid (and at
2020-01-01 UTC for the EXPIRED_* ones). The LEGACY_*, WRONG_TYPE, HS384/HS512
and NUMERIC_SUB tokens were built with `jose.jwt.encode` directly, because
no current minter produces those shapes. Secret: GOLDEN_SECRET below, which
is also conftest's JWT_SECRET.

The reverse direction (new code's tokens decoding under python-jose) was
checked by hand in a throwaway venv; python-jose is deliberately not a test
dependency. See claude-code-report-245.md.

What jose did with each of these at base, recorded by running the old code:
every golden token below is accepted or rejected here exactly as it was
then. The one difference is an improvement: jose raised AttributeError (a
500) on a None or non-string token; PyJWT raises DecodeError, which every
decode site already turns into None / 401.
"""

import ast
import base64
import json
import uuid
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from apps.api.config import settings
from apps.api.middleware.auth import get_current_user
from apps.api.middleware.global_rate_limit import GlobalRateLimitMiddleware
from apps.api.routers.hls_proxy import _verify_hls_token, create_hls_token
from apps.api.services import auth_service
from apps.api.services.auth_service import (
    VIA_MAGIC_CODE,
    VIA_PASSWORD,
    create_2fa_pending_token,
    create_access_token,
    create_refresh_token,
    decode_2fa_pending_claims,
    decode_token,
    pending_token_via,
)
from apps.api.services.zip_download import create_download_token, verify_download_token

GOLDEN_SECRET = "test-jwt-secret-key-for-tests-only"
USER = "5b0f8d0e-2c7a-4d43-9a43-0f4f1b9a7c11"
EXPORT = "9d3c2a41-6f1e-4b8a-8f0d-2b7e5c4a1d22"
PFX = "projects/p1/assets/a1/hls"

# ── golden tokens (python-jose 3.5.0, base 31d1131) ─────────────────────────
ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYWNjZXNzIiwidHYiOjMsImV4cCI6NDA3MDkwOTcwMH0.Jmu8sRxVWWSffIb29dJlc9SkkXsHCaKCG1bQ5I1Emoc"
REFRESH = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoicmVmcmVzaCIsInR2IjozLCJleHAiOjQwNzE1MTM2MDB9.Qu46-8e9brLlvuq3KpSCU7Fwh0Pq2Kd9hbv4dH0YLOg"
PENDING_PASSWORD = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiMmZhX3BlbmRpbmciLCJ2aWEiOiJwYXNzd29yZCIsImV4cCI6NDA3MDkwOTQwMH0.DGIuyuTVcBeTA351J0bhkBt_HwpplE92SAdOyO6mI3U"
PENDING_MAGIC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiMmZhX3BlbmRpbmciLCJ2aWEiOiJtYWdpY19jb2RlIiwiZXhwIjo0MDcwOTA5NDAwfQ.rOKGsxFiLlN5HuKTyEJ1NVGQ_fEzJSodyH5P0Ji3sko"
HLS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJobHMiLCJwZngiOiJwcm9qZWN0cy9wMS9hc3NldHMvYTEvaGxzIiwiZXhwIjo0MDcwOTk1MjAwfQ.a83uy4qFgHSvdAke4W5TSJinvPVt2A4aJKNmceZ6sFg"
DOWNLOAD = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ6aXBkbCIsImV4cF9pZCI6IjlkM2MyYTQxLTZmMWUtNGI4YS04ZjBkLTJiN2U1YzRhMWQyMiIsImV4cCI6NDA3MDk5NTIwMH0.PRmdlmMRYkSX3YEaGQqLc_vVucCx00BPc7l4QnRp2uY"
EXPIRED_ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYWNjZXNzIiwidHYiOjMsImV4cCI6MTU3NzgzNzcwMH0.Wp7x_zF3mP0YNv9ClFsRA1yhtAzLsipQDq4YAeayOOM"
EXPIRED_PENDING = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiMmZhX3BlbmRpbmciLCJ2aWEiOiJwYXNzd29yZCIsImV4cCI6MTU3NzgzNzQwMH0.8SwX821DxWEezqyig6J7CnyZPN0IdYUTm38vV5PCMzo"
EXPIRED_HLS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJobHMiLCJwZngiOiJwcm9qZWN0cy9wMS9hc3NldHMvYTEvaGxzIiwiZXhwIjoxNTc3OTIzMjAwfQ.dpS1fC0QU9m401H6E2jLrpXJrbPJVwKlkVe0JHkumsw"
EXPIRED_DOWNLOAD = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ6aXBkbCIsImV4cF9pZCI6IjlkM2MyYTQxLTZmMWUtNGI4YS04ZjBkLTJiN2U1YzRhMWQyMiIsImV4cCI6MTU3NzkyMzIwMH0.dgtBL5RDfdD2Xnx91vvCdfLWKg7V2beJUSGSE8WF0ms"
# Pre-§199: no `tv`. Pre-§199 pending: no `via`.
LEGACY_ACCESS_NO_TV = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYWNjZXNzIiwiZXhwIjo0MDcwOTk1MjAwfQ._FGXitdw3_lIbPHGu_bFsnRGwAuSgjBZRP5vS4lOCQA"
LEGACY_PENDING_NO_VIA = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiMmZhX3BlbmRpbmciLCJleHAiOjQwNzA5OTUyMDB9.K9TirpRF_M3DcjQ3lzh8OniXflP-JaRmkDIpRPLRfJg"
WRONG_TYPE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYm9ndXMiLCJ0diI6MywiZXhwIjo0MDcwOTk1MjAwfQ.Za0EWypwFu-tb9bIrTKTR9q1DxdAtvsCKJiu7C5PKps"
# Same secret, same claims, a different HMAC: algorithm confusion.
HS384_ACCESS = "eyJhbGciOiJIUzM4NCIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYWNjZXNzIiwidHYiOjMsImV4cCI6NDA3MDk5NTIwMH0.dzWZFu3JYD70xrjxlT7cL_WiBWMV8KAh-292cKzIjixikTRc24DT8qM60Fl1zEgU"
HS512_ACCESS = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1YjBmOGQwZS0yYzdhLTRkNDMtOWE0My0wZjRmMWI5YTdjMTEiLCJ0eXBlIjoiYWNjZXNzIiwidHYiOjMsImV4cCI6NDA3MDk5NTIwMH0.OdF2MQ7JjmczLtbmM52o26kmPWVrmbS109SwKfoeu5DifyBS7Kw89RkKRAa4_fbPjECVIYUrBLR82Yn-w4mV6w"
# jose ALSO rejected a non-string `sub` on decode, so PyJWT >= 2.10 doing the
# same changes nothing. No minter has ever produced one.
NUMERIC_SUB_ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEyMzQ1LCJ0eXBlIjoiYWNjZXNzIiwidHYiOjMsImV4cCI6NDA3MDk5NTIwMH0.yVUugEYE5Qil_H9_9ncNyqZrY-eWvWtP_uRqq-zG6VI"


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


#: `alg: none`, no signature, otherwise ACCESS's claims.
ALG_NONE_ACCESS = (
    _b64({"alg": "none", "typ": "JWT"})
    + "."
    + _b64({"sub": USER, "type": "access", "tv": 3, "exp": 4070995200})
    + "."
)
#: ACCESS with its signature changed.
TAMPERED_ACCESS = ACCESS[:-4] + ("AAAA" if not ACCESS.endswith("AAAA") else "BBBB")
#: Right shape, right algorithm, wrong secret, someone else's `sub`.
FORGED_ACCESS = jwt.encode(
    {"sub": "victim", "type": "access", "tv": 0, "exp": 4070995200},
    "not-the-secret-but-long-enough-to-not-warn",
    algorithm="HS256",
)


@pytest.fixture(autouse=True)
def _golden_secret(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", GOLDEN_SECRET)
    monkeypatch.setattr(settings, "jwt_algorithm", "HS256")


def _status(fn):
    try:
        fn()
    except HTTPException as e:
        return e.status_code
    return 200


def _rate_limit_identity(token: str) -> str:
    mw = GlobalRateLimitMiddleware(app=MagicMock())
    request = MagicMock()
    request.headers = {"authorization": f"Bearer {token}"}
    request.client.host = "203.0.113.9"
    return mw._get_identity(request)


# ── 1. golden tokens still work ─────────────────────────────────────────────


class TestGoldenTokensAccepted:
    def test_access_token(self):
        assert decode_token(ACCESS) == {"sub": USER, "type": "access", "tv": 3, "exp": 4070909700}

    def test_refresh_token(self):
        assert decode_token(REFRESH) == {"sub": USER, "type": "refresh", "tv": 3, "exp": 4071513600}

    def test_access_token_from_before_tv_existed(self):
        payload = decode_token(LEGACY_ACCESS_NO_TV)
        assert payload["sub"] == USER
        assert auth_service.token_version_of(payload) == 0

    def test_pending_token_from_a_password_login(self):
        claims = decode_2fa_pending_claims(PENDING_PASSWORD)
        assert claims["sub"] == USER and claims["via"] == VIA_PASSWORD
        assert pending_token_via(PENDING_PASSWORD) == VIA_PASSWORD

    def test_pending_token_from_a_magic_code_login(self):
        assert decode_2fa_pending_claims(PENDING_MAGIC)["via"] == VIA_MAGIC_CODE
        assert pending_token_via(PENDING_MAGIC) == VIA_MAGIC_CODE

    def test_pending_token_from_before_via_existed(self):
        assert decode_2fa_pending_claims(LEGACY_PENDING_NO_VIA)["sub"] == USER
        assert pending_token_via(LEGACY_PENDING_NO_VIA) == VIA_PASSWORD

    def test_hls_proxy_token(self):
        assert _verify_hls_token(HLS) == PFX

    def test_zip_download_token(self):
        verify_download_token(DOWNLOAD, EXPORT)  # raises on failure

    def test_rate_limit_reads_the_user_from_a_golden_token(self):
        assert _rate_limit_identity(ACCESS) == f"user:{USER}"

    @pytest.mark.parametrize(
        "token,version",
        [(ACCESS, 3), (LEGACY_ACCESS_NO_TV, 0)],
        ids=["access", "legacy-no-tv"],
    )
    def test_a_session_alive_at_deploy_stays_signed_in(self, token, version, monkeypatch):
        """The whole point: get_current_user, end to end, on a jose token."""
        user = MagicMock()
        user.id = uuid.UUID(USER)
        user.token_version = version
        user.status = "active"
        monkeypatch.setattr(
            "apps.api.middleware.auth.get_user_by_id",
            lambda db, uid: user if uid == user.id else None,
        )
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        assert get_current_user(credentials=creds, db=MagicMock()) is user


# ── 2. what was rejected is still rejected ──────────────────────────────────


#: Every one of these was rejected by the old code at every decode site
#: (recorded by running it), except where noted: jose raised AttributeError
#: on None and on non-strings, which these sites now return as None / 401.
BAD_TOKENS = {
    "none": None,
    "empty": "",
    "not-a-jwt": "abc",
    "non-string": 123,
    "tampered-signature": TAMPERED_ACCESS,
    "forged-with-another-secret": FORGED_ACCESS,
    "alg-none": ALG_NONE_ACCESS,
    "alg-HS384": HS384_ACCESS,
    "alg-HS512": HS512_ACCESS,
    "expired": EXPIRED_ACCESS,
    "numeric-sub": NUMERIC_SUB_ACCESS,
}


@pytest.mark.parametrize("token", BAD_TOKENS.values(), ids=BAD_TOKENS.keys())
class TestBadTokensRejectedAtEverySite:
    def test_decode_token(self, token):
        assert decode_token(token) is None

    def test_decode_2fa_pending_claims(self, token):
        assert decode_2fa_pending_claims(token) is None

    def test_hls_proxy(self, token):
        assert _status(lambda: _verify_hls_token(token)) == 401

    def test_zip_download(self, token):
        assert _status(lambda: verify_download_token(token, EXPORT)) == 401

    def test_get_current_user(self, token):
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="x")
        creds.credentials = token  # bypass pydantic, as a raw header could not
        assert _status(lambda: get_current_user(credentials=creds, db=MagicMock())) == 401


_UNVERIFIABLE = {k: v for k, v in BAD_TOKENS.items() if isinstance(v, str) and k != "expired"}


@pytest.mark.parametrize("token", _UNVERIFIABLE.values(), ids=_UNVERIFIABLE.keys())
def test_rate_limit_falls_back_to_ip_for_an_unverifiable_token(token):
    """Expiry is relaxed there; the signature and the algorithm are not. A
    forged `sub` must not choose whose bucket a request lands in."""
    assert _rate_limit_identity(token) == "ip:203.0.113.9"


def test_rate_limit_still_identifies_an_expired_but_genuine_token():
    """Unchanged from jose: `verify_exp: False` is deliberate there."""
    assert _rate_limit_identity(EXPIRED_ACCESS) == f"user:{USER}"


class TestExpiredGoldenTokens:
    def test_pending(self):
        assert decode_2fa_pending_claims(EXPIRED_PENDING) is None

    def test_hls(self):
        assert _status(lambda: _verify_hls_token(EXPIRED_HLS)) == 401

    def test_zip(self):
        assert _status(lambda: verify_download_token(EXPIRED_DOWNLOAD, EXPORT)) == 401


class TestWrongType:
    def test_decode_token_alone_does_not_check_type(self):
        """As before: the type check belongs to the caller."""
        assert decode_token(WRONG_TYPE)["type"] == "bogus"

    @pytest.mark.parametrize("token", [WRONG_TYPE, ACCESS, REFRESH], ids=["bogus", "access", "refresh"])
    def test_is_not_a_pending_token(self, token):
        assert decode_2fa_pending_claims(token) is None

    @pytest.mark.parametrize("token", [WRONG_TYPE, REFRESH, PENDING_PASSWORD], ids=["bogus", "refresh", "pending"])
    def test_is_not_a_session(self, token):
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
        assert _status(lambda: get_current_user(credentials=creds, db=MagicMock())) == 401

    def test_hls_rejects_other_subjects(self):
        assert _status(lambda: _verify_hls_token(DOWNLOAD)) == 403

    def test_zip_rejects_other_subjects(self):
        assert _status(lambda: verify_download_token(HLS, EXPORT)) == 403


# ── 3. the minters still produce what jose produced ─────────────────────────


MINTERS = {
    "access": lambda uid: create_access_token(uid, 3),
    "refresh": lambda uid: create_refresh_token(uid, 3),
    "pending-password": lambda uid: create_2fa_pending_token(uid),
    "pending-magic": lambda uid: create_2fa_pending_token(uid, via=VIA_MAGIC_CODE),
    "hls": lambda uid: create_hls_token(PFX),
    "download": lambda uid: create_download_token(uuid.UUID(EXPORT), expires_hours=1),
}


@pytest.mark.parametrize("mint", MINTERS.values(), ids=MINTERS.keys())
# A UUID object and an int as well as a string: str() in the minter is what
# keeps `sub` a string, which PyJWT (like jose) requires on decode.
@pytest.mark.parametrize("uid", [USER, uuid.UUID(USER), 12345], ids=["str", "uuid", "int"])
def test_minter_output_is_a_jose_compatible_hs256_string(mint, uid):
    token = mint(uid)
    assert type(token) is str  # bytes would break the Bearer header and URLs
    assert jwt.get_unverified_header(token) == {"alg": "HS256", "typ": "JWT"}
    claims = jwt.decode(token, options={"verify_signature": False})
    assert type(claims["sub"]) is str
    assert type(claims["exp"]) is int
    assert decode_token(token) is not None


def test_minted_claims_are_unchanged():
    def claims(token):
        return set(jwt.decode(token, options={"verify_signature": False}))

    assert claims(create_access_token(USER, 3)) == {"sub", "type", "tv", "exp"}
    assert claims(create_refresh_token(USER, 3)) == {"sub", "type", "tv", "exp"}
    assert claims(create_2fa_pending_token(USER)) == {"sub", "type", "via", "exp"}
    assert claims(create_hls_token(PFX)) == {"sub", "pfx", "exp"}
    assert claims(create_download_token(EXPORT)) == {"sub", "exp_id", "exp"}


def test_no_leeway_on_expiry():
    """jose's default leeway was 0; PyJWT's is too."""
    now = datetime.now(timezone.utc)

    def tok(delta):
        return jwt.encode({"sub": USER, "type": "access", "exp": now + delta}, GOLDEN_SECRET, algorithm="HS256")

    assert decode_token(tok(timedelta(seconds=-2))) is None
    assert decode_token(tok(timedelta(seconds=60))) is not None


def test_no_short_key_warning_for_the_secrets_we_ship():
    """PyJWT >= 2.10 warns (it does not refuse) below 32 bytes for HS256.
    conftest's secret and .env.example's placeholder are both above it; a
    production secret from `openssl rand -hex 64` is 128 bytes."""
    example = (REPO / ".env.example").read_text()
    placeholder = next(
        line.split("=", 1)[1] for line in example.splitlines() if line.startswith("JWT_SECRET=")
    )
    for secret in (GOLDEN_SECRET, placeholder):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            jwt.decode(jwt.encode({"sub": "x"}, secret, algorithm="HS256"), secret, algorithms=["HS256"])


# ── 4. source: jose is gone, and every decode names its algorithm ───────────


API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]


def _production_sources():
    for root in (REPO / "apps", REPO / "packages"):
        for path in root.rglob("*.py"):
            parts = set(path.parts)
            if parts & {"tests", "node_modules", ".venv", "venv"}:
                continue
            yield path


def test_no_production_module_imports_jose():
    offenders = []
    for path in _production_sources():
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            if any(n == "jose" or n.startswith("jose.") for n in names):
                offenders.append(str(path.relative_to(REPO)))
    assert offenders == []


def test_every_jwt_decode_passes_an_explicit_algorithm_list():
    calls = []
    for path in _production_sources():
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "decode"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "jwt"
            ):
                kw = {k.arg for k in node.keywords}
                calls.append((str(path.relative_to(REPO)), node.lineno, "algorithms" in kw))
    # auth_service, global_rate_limit, hls_proxy, zip_download
    assert len(calls) == 4, calls
    assert all(ok for _, _, ok in calls), calls


def test_requirements_pin_pyjwt_and_not_jose():
    lines = [line.strip() for line in (API / "requirements.txt").read_text().splitlines()]
    reqs = [line for line in lines if line and not line.startswith("#")]
    assert "PyJWT==2.15.1" in reqs
    assert not any(line.lower().startswith("python-jose") for line in reqs)
    # Still declared after jose left (Fernet needs it). The exact version is
    # §246's to own: tests/test_dependency_compat_246.py.
    assert any(line.startswith("cryptography==") for line in reqs)
