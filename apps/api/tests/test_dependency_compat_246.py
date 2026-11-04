"""§246 — the security dependency bumps must not lock anyone out, in either direction.

`cryptography`, `bcrypt`, `python-multipart` and `requests` were bumped, and
`starlette` / `botocore` were pinned. `Pillow` / `pillow-avif-plugin` were
looked at and deliberately left on 10.4.0 / 1.6.0, but the image proofs stay
here so the Pillow 13 branch inherits them unchanged. Every one
of those touches data that outlives a deploy: Fernet ciphertexts of stored mail
credentials, share-link passwords and TOTP secrets; bcrypt hashes of every
password and backup code; images users uploaded months ago. A bump that cannot
read what the old version wrote is a lockout, not a refactor — and the first
anyone would hear of it is a user who can no longer log in.

So, like §245, the proof is GOLDEN VALUES made by the OLD versions before
anything changed:

    How they were made: a scratch script (not committed) run in the
    `ff245-pytest:local` image — Python 3.11.15, which on 2026-11-04 had
    exactly the versions in prod-pip-freeze.txt — on main e3b3863, before
    requirements.txt was touched. Versions: cryptography 43.0.1, bcrypt
    4.2.0, pyotp 2.9.0, Pillow 10.4.0, pillow-avif-plugin 1.6.0,
    python-multipart 0.0.12. It set JWT_SECRET = GOLDEN_KEY below and called
    the app's OWN functions — `secrets_service.encrypt_secret` (mail
    credential), `totp_service.encrypt_secret` (TOTP secret),
    `crypto_service.encrypt_password` (share-link password),
    `auth_service.hash_password` (four passwords), `pyotp.TOTP(...).at(...)`
    (the code) — and Pillow's own encoders for the four poster formats. Each
    value was checked to round-trip with those old versions before it was
    copied here.

Do NOT regenerate these with the current versions: a value minted by the new
code proves nothing about data written by the old one. The reverse direction
(values minted by the new versions read by the old pins) was checked once by
hand for the §246 report, in a throwaway venv that is not part of the repo.
"""

import base64
import io
import re
import uuid
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from apps.api.config import settings
from apps.api.services import auth_service, crypto_service, secrets_service, totp_service

API = Path(__file__).resolve().parents[1]

# ── Golden values (see the module docstring for how they were made) ─────────

GOLDEN_KEY = "golden-246-fixed-test-key-not-a-real-secret"

MAIL_PASSWORD = "smtp-app-password-246!"
TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
SHARE_PASSWORD = "share-link-pw-246"

PW_PLAIN = "correct horse battery staple"
PW_72 = "A" * 36 + "b" * 36  # exactly 72 bytes
PW_NON_ASCII = "Pässwört-Ünïcødé-🎬-246"
# 40 characters, 80 bytes. `hash_password` cuts at 72 CHARACTERS, so this
# reaches bcrypt as 80 bytes and bcrypt 4.x silently uses the first 72. bcrypt
# 5.x raises ValueError on it instead — see test_bcrypt_still_truncates_*.
PW_OVER_72_BYTES = "ä" * 40

TOTP_TIMESTAMP = 1_793_000_000

GOLDEN = {
    'mail_credential_ct': (
        'gAAAAABq635jyRD1gta8mcBatjbTP-Ccm_CyY7OpSv38Rc39t91OlpsH2z-PTtxm4PzV_mKo'
        'MQh19MlqWOEVqKTxuJXxAFRt89SlBj71W27ySn4D8XFQAjU='
    ),
    'totp_secret_ct': (
        'gAAAAABq635jrzNGV2in1EZfWMySQgWE5BFl-gUDFQDAUugGuzTTpaFKVkseUQCxbSk28ULn'
        'noB_nVmS2ut2a2qLf9sKlQNoLeRkXgApPcWYjdWD3-hcmnPqs_T_dPK1Q7ey8fN-yyuG'
    ),
    'share_password_ct': (
        'gAAAAABq635jgsMZxXv3rUBgyGIwIfmWAeqQ6pdEetbI2r8zTR9ySdDJG_H6yIx8zAKi8Ywl'
        'EGGHJCra-nCUxK4bUHTM3IlWm_0Q4S98LZQ4MwUaMVF-Irk='
    ),
    'hash_plain': '$2b$12$c1wnDLSyXjm4J3U9xndGmeP./dJHSMbGUJDCUTX8HYwDMGmHLMRVS',
    'hash_72': '$2b$12$FUAHVDRPUpYQhgbFBjNzyOWA6/CPasMYxJZuwfBiWUQyHftl3inLu',
    'hash_non_ascii': '$2b$12$rrIBCACM0dZ5ZdCEG855PuPKg38s9QXk2cKxcNdLrolPQ6zi5gvzO',
    'hash_over_72_bytes': '$2b$12$cOIB4aLMcPtiu/krP.Ky2.OINXeIK4gajllqR.0Zj5HFNXPRIgSCy',
    'hash_backup_code': '$2b$12$vZq9r11U1BsIrVWhfXuykOAknky3USp/qvfz3eAY1RBo.Dj9dttIm',
    'totp_code': '050445',
    # 40x30, four flat quadrants; JPEG q95, PNG, lossless WebP, AVIF q90.
    "images": {
        'JPEG': (
            '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUG'
            'BgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYH'
            'CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAAR'
            'CAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA'
            'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK'
            'FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWG'
            'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl'
            '5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA'
            'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk'
            'NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE'
            'hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk'
            '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4/orM/wCEz8H/APQ2aZ/4Hx/40f8ACZ+D'
            '/wDobNM/8D4/8a/GP9UeLP8AoX1//BVT/wCRP9c/9aOGf+g6j/4Nh/8AJHt/7LH/ADHf+3X/'
            'ANrV65Xm37Cngrxl8X/+Ep/4VN4S1PxR/Z32H+0P+EdsJL37N5n2jy/M8lW2btj4zjOxsdDX'
            '0F/wzD+0r/0bz45/8JK8/wDjVfknE+SZ1h88rU6uGqRkuW6cJJ/DHo0f4LfTRw2JzX6S+e4r'
            'BQdWlL6racE5RdsHh07SjdOzTTs9GmtzhqK7n/hmH9pX/o3nxz/4SV5/8aorwP7KzT/nxP8A'
            '8Bl/kfy5/Yuc/wDQNU/8Al/kfj1RRRX/AE4n9sn7Ff8ABpr/AM19/wC5V/8AcxX7FV+Ov/Bp'
            'r/zX3/uVf/cxX7FV/mn9ID/k7mZf9wf/AFHpH2GVf7hD5/mwooor8bPQP//Z'
        ),
        'PNG': (
            'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAARElEQVR4nO3VsQ0AIAwDwYQZ'
            'PAyDM46HYQIa0yDx7l8npUlbqnRzxWmNPL0bMDAwMDDwcS05ju38pf53amBgYGDg9+ENcXsE'
            '++GSKucAAAAASUVORK5CYII='
        ),
        'WEBP': (
            'UklGRkoAAABXRUJQVlA4TD0AAAAvJ0AHAB8gJCCM8T8ZZo5CthGgYZ0/z4sgFEBkgsh/hRPC'
            '/Me/BkoIagKmYTCJSUx25OeO6P8EmMMuQrELAA=='
        ),
        'AVIF': (
            'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAA'
            'AAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEA'
            'AQAAAAEAAAETAAAAdAAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAA'
            'AABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAKAAAAB4AAAAQcGl4aQAAAAADCAgIAAAA'
            'DGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAA'
            'fG1kYXQSAAoJGBUn60QENBoQMmVEgf39qkAggg+QACDxKAC0+CE9v722c9EcFT09/0PspoPD'
            'yqz/K1pqaH4zB0rt/vOIFUUBE/8YufVHSMsF5sjXs7wN/1V/EXXlt9x/1AZDV06CXZFlOW7v'
            'ecpIc9+wl9imuicDPQ=='
        ),
    },
}


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def golden_key(monkeypatch):
    """settings.jwt_secret = the key the golden ciphertexts were made under.

    secrets_service caches its Fernet module-wide, so the cache is dropped on
    the way in AND out — otherwise this key would leak into every later test,
    or an earlier test's key into this one.
    """
    monkeypatch.setattr(settings, "jwt_secret", GOLDEN_KEY)
    monkeypatch.setattr(secrets_service, "_fernet", None)
    yield
    secrets_service._fernet = None


@pytest.fixture
def frozen_totp_clock():
    """pyotp reads `datetime.datetime.now()` in TOTP.verify; freeze it at the
    golden timestamp so verify_totp_code — our function, not pyotp's — can be
    exercised exactly as the login route calls it."""
    import datetime as real_datetime

    import pyotp.totp

    class Frozen(real_datetime.datetime):
        offset = 0

        @classmethod
        def now(cls, tz=None):
            # An instance of THIS class: pyotp's `at()` checks
            # isinstance(for_time, datetime.datetime) against the patched name.
            return cls.fromtimestamp(TOTP_TIMESTAMP + cls.offset, tz)

    with patch.object(pyotp.totp, "datetime", SimpleNamespace(datetime=Frozen)):
        yield Frozen


# ── Fernet: old ciphertexts still decrypt ───────────────────────────────────

class TestGoldenFernet:
    def test_stored_mail_credential_decrypts(self, golden_key):
        assert secrets_service.decrypt_secret(GOLDEN["mail_credential_ct"]) == MAIL_PASSWORD

    def test_stored_totp_secret_decrypts(self, golden_key):
        assert totp_service.decrypt_secret(GOLDEN["totp_secret_ct"]) == TOTP_SECRET

    def test_stored_share_link_password_decrypts(self, golden_key):
        assert crypto_service.decrypt_password(GOLDEN["share_password_ct"]) == SHARE_PASSWORD

    def test_a_wrong_key_still_degrades_to_none_not_a_crash(self, monkeypatch):
        """The documented jwt_secret-rotation behaviour must survive the bump:
        None (fall back / re-enrol), never an exception on every login."""
        monkeypatch.setattr(settings, "jwt_secret", "some-other-key")
        monkeypatch.setattr(secrets_service, "_fernet", None)
        try:
            assert secrets_service.decrypt_secret(GOLDEN["mail_credential_ct"]) is None
            assert totp_service.decrypt_secret(GOLDEN["totp_secret_ct"]) is None
        finally:
            secrets_service._fernet = None

    @pytest.mark.parametrize("key", ["mail_credential_ct", "totp_secret_ct", "share_password_ct"])
    def test_new_tokens_have_the_same_wire_format(self, golden_key, key):
        """A rollback reads what the new version wrote only if the format is
        the same: Fernet version byte 0x80, and the same token layout. (The
        old-version decrypt of new tokens was checked by hand — see docstring.)"""
        fresh = {
            "mail_credential_ct": lambda: secrets_service.encrypt_secret(MAIL_PASSWORD),
            "totp_secret_ct": lambda: totp_service.encrypt_secret(TOTP_SECRET),
            "share_password_ct": lambda: crypto_service.encrypt_password(SHARE_PASSWORD),
        }[key]()
        old_raw = base64.urlsafe_b64decode(GOLDEN[key])
        new_raw = base64.urlsafe_b64decode(fresh)
        assert new_raw[0] == old_raw[0] == 0x80
        assert len(new_raw) == len(old_raw)
        assert fresh != GOLDEN[key]  # random IV + timestamp, not a constant


# ── bcrypt: old hashes still verify ─────────────────────────────────────────

_GOLDEN_PASSWORDS = [
    ("hash_plain", PW_PLAIN),
    ("hash_72", PW_72),
    ("hash_non_ascii", PW_NON_ASCII),
    ("hash_over_72_bytes", PW_OVER_72_BYTES),
]


class TestGoldenBcrypt:
    @pytest.mark.parametrize("key,password", _GOLDEN_PASSWORDS, ids=[k for k, _ in _GOLDEN_PASSWORDS])
    def test_golden_hash_verifies(self, key, password):
        assert auth_service.verify_password(password, GOLDEN[key])

    @pytest.mark.parametrize("key,password", _GOLDEN_PASSWORDS, ids=[k for k, _ in _GOLDEN_PASSWORDS])
    def test_golden_hash_rejects_a_wrong_password(self, key, password):
        wrong = "x" + password[1:] if len(password.encode()) <= 72 else "nope"
        assert not auth_service.verify_password(wrong, GOLDEN[key])

    def test_bcrypt_still_truncates_at_72_bytes_rather_than_raising(self):
        """The reason bcrypt stays on 4.x (§246).

        `hash_password` truncates at 72 CHARACTERS, not bytes, so a non-ASCII
        password can reach bcrypt longer than 72 bytes — and there is no
        maximum length anywhere in password_policy.py. bcrypt 4.x silently
        uses the first 72 bytes (so the first 36 'ä' already match this
        hash); 5.x raises ValueError, which would make `hash_password` 500 on
        such a password and `verify_password` return False for the user who
        set it. Moving to 5.x needs a byte-safe truncation first.
        """
        assert auth_service.verify_password("ä" * 36, GOLDEN["hash_over_72_bytes"])
        fresh = auth_service.hash_password(PW_OVER_72_BYTES)  # must not raise
        assert auth_service.verify_password(PW_OVER_72_BYTES, fresh)

    def test_new_hashes_keep_prefix_and_cost(self):
        """$2b$, cost 12 — what the old version wrote and can verify."""
        fresh = auth_service.hash_password(PW_PLAIN)
        assert fresh[:7] == GOLDEN["hash_plain"][:7] == "$2b$12$"
        assert len(fresh) == len(GOLDEN["hash_plain"]) == 60

    def test_a_backup_code_hashed_by_the_old_version_is_spent_once(self):
        """Backup codes go through the same hash_password, after
        normalize_backup_code (upper-case, no dash). A golden hash of the
        normalised form must be consumed exactly once."""
        code = "ab3f-9k7q"
        old_hash = GOLDEN["hash_backup_code"]
        matched, remaining = totp_service.consume_backup_code([old_hash, GOLDEN["hash_plain"]], code)
        assert matched is True and remaining == [GOLDEN["hash_plain"]]
        matched, _ = totp_service.consume_backup_code(remaining, code)
        assert matched is False


# ── TOTP: the golden code still validates ───────────────────────────────────

class TestGoldenTotp:
    def test_golden_code_validates_through_our_verify(self, golden_key, frozen_totp_clock):
        secret = totp_service.decrypt_secret(GOLDEN["totp_secret_ct"])
        assert totp_service.verify_totp_code(secret, GOLDEN["totp_code"])

    def test_golden_code_is_rejected_two_minutes_later(self, golden_key, frozen_totp_clock):
        frozen_totp_clock.offset = 120
        secret = totp_service.decrypt_secret(GOLDEN["totp_secret_ct"])
        assert not totp_service.verify_totp_code(secret, GOLDEN["totp_code"])

    def test_derived_totp_key_is_unchanged(self, golden_key):
        """HKDF(...).derive is the one hazmat primitive we use; same input,
        same key, or every enrolled 2FA user is locked out."""
        assert totp_service._fernet().decrypt(GOLDEN["totp_secret_ct"].encode()) == TOTP_SECRET.encode()


# ── python-multipart: real multipart POSTs through the app ──────────────────

#: Bytes that a sloppy parser would trip over: CRLFs, something that looks
#: like a boundary, NULs and high bytes.
_TRICKY_BYTES = (
    b"RIFF\x00\x00\x00\x00WEBP"
    + b"\r\n--not-the-boundary\r\nContent-Disposition: form-data\r\n\r\n"
    + bytes(range(256)) * 8
    + b"\r\n\r\n--"
)


@pytest.fixture
def upload_user(test_user):
    """conftest's MagicMock user, with the two name fields UserResponse
    validates as strings (left as MagicMocks they 500 the response — the
    same cause as the known base failure test_auth.py::test_get_me)."""
    test_user.first_name = "Test"
    test_user.last_name = "User"
    return test_user


class TestMultipart:
    def test_fastapi_and_starlette_find_a_working_multipart(self):
        """fastapi 0.115.0 and starlette 0.38.6 both import the OLD name
        `multipart` (and `multipart.multipart.parse_options_header`). Since
        python-multipart 0.0.13 that is a compatibility shim over
        `python_multipart`; if it ever disappears, every upload route fails
        at import time."""
        import starlette.formparsers as formparsers
        from fastapi.dependencies.utils import ensure_multipart_is_installed

        ensure_multipart_is_installed()
        assert formparsers.multipart is not None
        assert formparsers.parse_options_header is not None

    def test_avatar_upload_receives_the_exact_bytes(self, client, upload_user):
        """A real file-upload route (`POST /users/me/avatar`), through
        TestClient, through starlette's MultiPartParser."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        stored = {}

        def _put(key, body, **kw):
            stored["key"], stored["body"], stored["kw"] = key, body, kw

        app.dependency_overrides[get_current_user] = lambda: upload_user
        with patch("apps.api.routers.users.s3_service.put_object", side_effect=_put):
            r = client.post(
                "/users/me/avatar",
                files={"file": ("avatar.webp", _TRICKY_BYTES, "image/webp")},
            )
        assert r.status_code == 200, r.text
        assert stored["body"] == _TRICKY_BYTES
        assert stored["kw"]["content_type"] == "image/webp"

    def test_a_missing_file_field_is_a_422_not_a_500(self, client, upload_user):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        app.dependency_overrides[get_current_user] = lambda: upload_user
        with patch("apps.api.routers.users.s3_service.put_object"):
            r = client.post("/users/me/avatar", files={"other": ("x.bin", b"x", "application/octet-stream")})
        assert r.status_code == 422

    def test_plain_form_fields_parse(self):
        """The app has no `Form(...)` route today (auth is JSON), so the plain
        form path is proven on a minimal FastAPI app using the same installed
        fastapi/starlette/python-multipart: urlencoded, and multipart with a
        field next to a file."""
        from fastapi import FastAPI, File, Form, UploadFile
        from fastapi.testclient import TestClient

        mini = FastAPI()

        @mini.post("/login-form")
        def login_form(username: str = Form(...), password: str = Form(...)):
            return {"u": username, "p": password}

        @mini.post("/field-and-file")
        async def field_and_file(note: str = Form(...), file: UploadFile = File(...)):
            return {"note": note, "len": len(await file.read()), "name": file.filename}

        c = TestClient(mini)
        r = c.post("/login-form", data={"username": "a@b.at", "password": "pä&ss=wörd"})
        assert r.status_code == 200 and r.json() == {"u": "a@b.at", "p": "pä&ss=wörd"}

        r = c.post(
            "/field-and-file",
            data={"note": "line1\r\nline2"},
            files={"file": ("lut.cube", _TRICKY_BYTES, "application/octet-stream")},
        )
        assert r.status_code == 200
        assert r.json() == {"note": "line1\r\nline2", "len": len(_TRICKY_BYTES), "name": "lut.cube"}


# ── Pillow: every poster format still decodes ───────────────────────────────

Image = pytest.importorskip("PIL.Image")

#: Centre of each quadrant of the 40x30 golden image, and the colour painted there.
_QUADRANTS = [((10, 7), (220, 20, 20)), ((30, 7), (20, 200, 20)),
              ((10, 22), (20, 20, 220)), ((30, 22), (240, 240, 240))]

_POSTER_FORMATS = [("JPEG", "image/jpeg", "jpg"), ("PNG", "image/png", "png"),
                   ("WEBP", "image/webp", "webp"), ("AVIF", "image/avif", "avif")]


def _close(a, b, tol):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


class TestImages:
    @pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP", "AVIF"])
    def test_golden_image_from_the_old_encoder_decodes(self, fmt):
        """Files encoded by Pillow 10.4.0 / pillow-avif-plugin 1.6.0 — i.e.
        posters already in the bucket — open with the new decoder and give
        the same pixels (lossless formats exactly, lossy ones within a small
        tolerance)."""
        import apps.api.routers.projects  # noqa: F401  (registers the AVIF plugin)

        with Image.open(io.BytesIO(base64.b64decode(GOLDEN["images"][fmt]))) as im:
            im.load()
            assert im.format == fmt
            assert im.size == (40, 30)
            rgb = im.convert("RGB")
            tol = 0 if fmt in ("PNG", "WEBP") else 16
            for xy, colour in _QUADRANTS:
                assert _close(rgb.getpixel(xy), colour, tol), (fmt, xy, rgb.getpixel(xy))

    def test_avif_is_decoded_by_the_pinned_plugin(self):
        """On the pinned Pillow 10.4.0 the plugin is the ONLY AVIF codec. From
        Pillow 11.3.0 the wheels decode AVIF themselves, so a missing plugin
        would no longer break AVIF outright — it would silently swap the
        decoder for a different libavif build. Either way, requirements.txt
        pins the plugin and projects.py imports it; this keeps the plugin the
        decoder in use, on purpose rather than by accident."""
        from apps.api.routers import projects

        assert projects.pillow_avif is not None, "pillow-avif-plugin did not import"
        Image.init()
        handler = Image.OPEN["AVIF"][0]
        assert handler.__module__ == "pillow_avif.AvifImagePlugin", handler.__module__

    @pytest.mark.parametrize("fmt,content_type,ext", _POSTER_FORMATS, ids=[f for f, _, _ in _POSTER_FORMATS])
    def test_poster_upload_route_thumbnails_every_format(self, client, upload_user, fmt, content_type, ext):
        """The real `POST /projects/{id}/poster` route, multipart and all: the
        original is stored byte-for-byte and a decoded 800px JPEG thumbnail is
        stored next to it. A decoder that fails here does not 500 — the route
        stores no thumbnail — so the assertion is on the thumbnail itself."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user
        from apps.api.models.project import ProjectType

        src = Image.new("RGB", (1000, 750), (30, 120, 200))
        buf = io.BytesIO()
        src.save(buf, format=fmt)
        payload = buf.getvalue()

        project = SimpleNamespace(
            id=uuid.uuid4(), name="P", description=None, project_type=ProjectType.team,
            created_at=datetime.now(timezone.utc), poster_s3_key=None, poster_thumb_s3_key=None,
        )
        stored = {}

        def _put(key, body, content_type=None, **kw):
            stored[key] = (body, content_type)

        app.dependency_overrides[get_current_user] = lambda: upload_user
        with patch("apps.api.routers.projects._get_project", return_value=project), \
             patch("apps.api.routers.projects._require_project_owner"), \
             patch("apps.api.routers.projects.delete_object"), \
             patch("apps.api.routers.projects.put_object", side_effect=_put):
            r = client.post(f"/projects/{project.id}/poster",
                            files={"file": (f"poster.{ext}", payload, content_type)})

        assert r.status_code == 200, r.text
        original_key = f"posters/{project.id}/poster.{ext}"
        thumb_key = f"posters/{project.id}/poster_thumb.jpg"
        assert stored[original_key] == (payload, content_type)
        assert thumb_key in stored, f"{fmt} produced no thumbnail: the decoder failed"
        thumb_bytes, thumb_type = stored[thumb_key]
        assert thumb_type == "image/jpeg"
        with Image.open(io.BytesIO(thumb_bytes)) as thumb:
            assert thumb.format == "JPEG"
            assert thumb.size == (800, 600)
            assert _close(thumb.convert("RGB").getpixel((400, 300)), (30, 120, 200), 16)


# ── requirements.txt: exact pins ────────────────────────────────────────────

_MUST_BE_EXACT = ["starlette", "botocore", "cryptography", "python-multipart", "bcrypt", "Pillow"]


def _pins() -> dict:
    out = {}
    for line in (API / "requirements.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name = re.split(r"[<>=!~\[;\s]", line, maxsplit=1)[0]
        out[name.lower()] = line
    return out


@pytest.mark.parametrize("package", _MUST_BE_EXACT)
def test_requirements_pin_is_exact(package):
    """A `--no-cache` rebuild must not change these silently (§124 left
    starlette/botocore unpinned on purpose; §246 pins them for the opposite
    reason)."""
    line = _pins().get(package.lower())
    assert line is not None, f"{package} is not in requirements.txt"
    assert re.fullmatch(rf"{re.escape(package)}==\d+(\.\d+)*", line, re.IGNORECASE), (
        f"{package} must be an exact == pin, got: {line!r}"
    )


@pytest.mark.parametrize("package", _MUST_BE_EXACT)
def test_installed_version_matches_the_pin(package):
    """The suite ran against what the file says — not a leftover from an
    older image."""
    line = _pins().get(package.lower(), "")
    assert "==" in line, f"{package} is not pinned: {line!r}"
    assert version(package) == line.split("==", 1)[1]


def test_bcrypt_stays_on_4x():
    """See test_bcrypt_still_truncates_at_72_bytes_rather_than_raising."""
    assert _pins()["bcrypt"].split("==", 1)[1].startswith("4.")
