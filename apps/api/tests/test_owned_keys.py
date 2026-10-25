"""Only keys the server issued may be signed (§235).

`routers/hls_proxy.py::proxy_url_for` does not sign one object. It splits a
key into prefix + filename and mints a token "scoped to everything under an
S3 prefix", which the proxy then honours for every object under that prefix
for 24 hours. Three columns used to accept any string a client sent and were
then handed to that function:

  * `project_brandings.logo_s3_key` — writable by an editor of ANY project.
    `{"logo_s3_key": "raw/x/y.png"}` came back as a token scoped to `raw/x`;
    `{"logo_s3_key": "raw/y.png"}` scoped one to `raw`, the whole tree.
  * `site_settings.logo_*_s3_key` / `favicon_s3_key` — superadmin-only to
    write, but GET /site-settings is UNAUTHENTICATED and signs them, and
    GET /site-settings/logo-image serves the light logo's bytes with no token
    and no expiry.
  * `users.avatar_url` — PATCH /users/{id} copied any string into it, and it
    is rendered as an <img src> for every other user who sees the account.

The rule now lives in `services/owned_keys.py` and is applied on the write,
on the read, and once over the existing rows by
`alembic/versions/null_unowned_brand_keys.py`.

The first half of this file is the rule itself and runs anywhere. The second
half is the four endpoints and the migration against a real migrated
Postgres, because "the column did not change" and "the migration kept the
good row" are not things the mocked session can express:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_owned_keys.py
"""

import importlib.util
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from apps.api.services.owned_keys import (
    SITE_BRAND_IMAGE_COLUMNS,
    SITE_LOGO_SIDES,
    is_issued_avatar_url,
    is_owned_avatar_key,
    is_owned_project_logo_key,
    is_owned_site_brand_image_key,
    is_owned_watermark_image_key,
    issued_avatar_url,
    new_avatar_key,
    new_project_logo_key,
    new_site_favicon_key,
    new_site_logo_key,
    new_watermark_image_key,
)

PROJECT = uuid.UUID("11111111-1111-1111-1111-111111111111")
OTHER_PROJECT = uuid.UUID("22222222-2222-2222-2222-222222222222")
USER = uuid.UUID("33333333-3333-3333-3333-333333333333")


# ─── the rule ────────────────────────────────────────────────────────────────


class TestWhatAProjectLogoKeyMayBe:
    def test_the_one_issued_shape_is_accepted(self):
        assert is_owned_project_logo_key(
            PROJECT, f"branding/{PROJECT}/logo/{uuid.uuid4()}.webp"
        )

    def test_a_string_project_id_reads_the_same_as_a_uuid(self):
        key = new_project_logo_key(PROJECT)
        assert is_owned_project_logo_key(str(PROJECT), key)

    @pytest.mark.parametrize(
        "key",
        [
            # The read primitive this task exists to close: another project's
            # media prefix, and a one-segment key whose prefix is a whole tree.
            "raw/x/y.mov",
            "raw/y.mov",
            f"raw/{OTHER_PROJECT}/original.mov",
            # Another project's logo prefix — the same column, the wrong owner.
            f"branding/{OTHER_PROJECT}/logo/x.webp",
            # Traversal, raw and encoded. `..` resolves above the prefix, and
            # an encoded `/` smuggles a second segment past a naive length
            # check.
            f"branding/{PROJECT}/logo/../../../raw/x.mov",
            f"branding/{PROJECT}/logo/..",
            f"branding/{PROJECT}/logo/.",
            f"branding/{PROJECT}/logo/%2e%2e%2fsecret.mov",
            f"branding/{PROJECT}/logo/%2E%2E%2F%2E%2E%2Fraw%2Fx.mov",
            f"branding/{PROJECT}/logo/%252e%252e%252fraw%252fx.mov",
            f"branding/{PROJECT}/logo/sub%2Fx.webp",
            f"branding/{PROJECT}/logo/x%5C..%5Cy.webp",
            # Extra segments: the token would be scoped to the sub-directory,
            # but the column is still naming an object nothing issued.
            f"branding/{PROJECT}/logo/nested/x.webp",
            # A prefix, not a key — `posixpath.split` would scope the token to
            # `branding/{PROJECT}` and the filename would be empty.
            f"branding/{PROJECT}/logo/",
            f"branding/{PROJECT}/logo",
            # Absolute URLs and absolute paths.
            f"https://evil.example/branding/{PROJECT}/logo/x.webp",
            f"//evil.example/branding/{PROJECT}/logo/x.webp",
            f"/branding/{PROJECT}/logo/x.webp",
            # Control characters.
            f"branding/{PROJECT}/logo/x\n.webp",
            f"branding/{PROJECT}/logo/x\x00.webp",
            # Nothing at all.
            "",
            " ",
        ],
    )
    def test_everything_else_is_refused(self, key):
        assert not is_owned_project_logo_key(PROJECT, key)

    @pytest.mark.parametrize("key", [None, 7, b"branding/x/logo/y.webp", object()])
    def test_a_non_string_is_refused(self, key):
        assert not is_owned_project_logo_key(PROJECT, key)

    def test_no_project_means_no_owned_key(self):
        """A missing project id must not degrade into a prefix of "branding//"
        that something could then be named under."""
        assert not is_owned_project_logo_key(None, "branding//logo/x.webp")

    def test_the_prefix_alone_is_not_a_match(self):
        """The check is "prefix + one segment", not `startswith`. A loosened
        validator that only tested the prefix would accept this."""
        assert not is_owned_project_logo_key(
            PROJECT, f"branding/{PROJECT}/logo/a/b/c/../../../../../raw/x.mov"
        )


class TestWhatASiteBrandImageKeyMayBe:
    @pytest.mark.parametrize("side", SITE_LOGO_SIDES)
    def test_each_logo_slot_accepts_its_own_issued_key(self, side):
        column = f"logo_{side}_s3_key"
        assert is_owned_site_brand_image_key(column, new_site_logo_key(side))

    @pytest.mark.parametrize("side", SITE_LOGO_SIDES)
    def test_a_slot_refuses_another_slots_key(self, side):
        others = [s for s in SITE_LOGO_SIDES if s != side]
        for other in others:
            assert not is_owned_site_brand_image_key(
                f"logo_{side}_s3_key", new_site_logo_key(other)
            )

    def test_the_favicon_slot_accepts_its_own_issued_key(self):
        assert is_owned_site_brand_image_key("favicon_s3_key", new_site_favicon_key())

    @pytest.mark.parametrize(
        "key",
        [
            "raw/x/y.mov",
            "site-settings/logo-light/x.webp",  # a logo is not a favicon
            "site-settings/x.png",              # right directory, wrong name
            "site-settings/favicon-x.png/../../raw/y.mov",
            "site-settings/favicon-%2e%2e%2fraw%2fx.png",
            "https://evil.example/site-settings/favicon-x.png",
            "",
        ],
    )
    def test_the_favicon_slot_refuses_everything_else(self, key):
        assert not is_owned_site_brand_image_key("favicon_s3_key", key)

    def test_a_column_this_module_does_not_rule_on_is_refused(self):
        """Fail closed: an unknown column name is not a licence to sign."""
        assert not is_owned_site_brand_image_key(
            "theme_colors", "site-settings/logo-light/x.webp"
        )
        assert not is_owned_site_brand_image_key("", "site-settings/x.png")

    def test_the_four_columns_are_the_four_the_router_protects(self):
        from apps.api.routers.site_settings import BRAND_IMAGE_FIELDS

        assert tuple(BRAND_IMAGE_FIELDS) == tuple(SITE_BRAND_IMAGE_COLUMNS)
        assert set(SITE_BRAND_IMAGE_COLUMNS) == {
            "logo_dark_s3_key",
            "logo_light_s3_key",
            "logo_login_s3_key",
            "favicon_s3_key",
        }


class TestWhatAnAvatarMayBe:
    def test_an_issued_object_key_is_owned_by_its_own_user(self):
        assert is_owned_avatar_key(USER, new_avatar_key(USER))
        assert not is_owned_avatar_key(uuid.uuid4(), new_avatar_key(USER))

    def test_the_column_holds_a_proxy_url_and_that_is_what_is_validated(self):
        """What `upload_avatar` stores is NOT the object key — it is the
        finished proxy URL minted for it. A validator that tested for an
        `avatars/<id>/` prefix here would reject every real avatar."""
        from apps.api.routers.hls_proxy import proxy_url_for

        stored = proxy_url_for(new_avatar_key(USER), expires_hours=24 * 365 * 5)
        assert not stored.startswith("avatars/")
        assert is_issued_avatar_url(stored)
        assert issued_avatar_url(stored) == stored

    @pytest.mark.parametrize(
        "value",
        [
            "https://evil.example/tracker.png?u=victim",
            "http://192.168.1.34:30320/freeframe/raw/x.png",
            "javascript:alert(1)",
            "data:image/svg+xml;base64,AAAA",
            "avatars/other-user/x.webp",
            "/stream/hls/x.webp",                      # no token
            "/stream/hls/x.webp?token=notajwt",
            "/stream/hls/../raw/x.mov?token=a.b.c",
            "/stream/hls/x.webp?token=a.b.c&download=evil.sh",
            "//evil.example/stream/hls/x.webp?token=a.b.c",
            "",
            None,
        ],
    )
    def test_anything_else_reads_as_no_avatar(self, value):
        assert not is_issued_avatar_url(value)
        assert issued_avatar_url(value) is None


class TestEveryIssuedKeyPassesItsOwnValidator:
    """A — the issuing code and the validator cannot drift apart, because the
    issuing code BUILDS the key with the same module that rules on it. These
    are the assertions that hold that claim up."""

    def test_the_logo_upload_route_issues_a_key_it_would_accept(self):
        for _ in range(50):
            key = new_project_logo_key(PROJECT)
            assert is_owned_project_logo_key(PROJECT, key)

    def test_the_watermark_upload_route_issues_a_key_it_would_accept(self):
        assert is_owned_watermark_image_key(PROJECT, new_watermark_image_key(PROJECT))

    @pytest.mark.parametrize("side", SITE_LOGO_SIDES)
    def test_the_site_logo_route_issues_a_key_it_would_accept(self, side):
        assert is_owned_site_brand_image_key(
            f"logo_{side}_s3_key", new_site_logo_key(side)
        )

    def test_the_favicon_route_issues_a_key_it_would_accept(self):
        assert is_owned_site_brand_image_key("favicon_s3_key", new_site_favicon_key())

    def test_the_avatar_route_issues_a_url_it_would_accept(self):
        from apps.api.routers.hls_proxy import proxy_url_for

        for _ in range(50):
            key = new_avatar_key(USER)
            assert is_owned_avatar_key(USER, key)
            assert is_issued_avatar_url(
                proxy_url_for(key, expires_hours=24 * 365 * 5)
            )

    def test_the_routes_build_their_keys_through_this_module(self):
        """Not a style check: an inline f-string in a route is exactly how the
        issued format drifts away from the validated one."""
        import inspect

        from apps.api.routers import branding, site_settings, users

        for module, needle in (
            (branding, "new_project_logo_key("),
            (branding, "new_watermark_image_key("),
            (site_settings, "new_site_logo_key("),
            (site_settings, "new_site_favicon_key("),
            (users, "new_avatar_key("),
        ):
            source = inspect.getsource(module)
            assert needle in source, f"{module.__name__} no longer calls {needle}"
            assert 'f"branding/' not in source
            assert 'f"site-settings/' not in source
            assert 'f"avatars/' not in source


# ─── the read side, without a database ───────────────────────────────────────


def _branding_row(project_id, key):
    row = MagicMock()
    row.id = uuid.uuid4()
    row.project_id = project_id
    row.logo_s3_key = key
    # `BrandingResponse.model_validate` reads every field off the row, and an
    # unset MagicMock attribute is a truthy object that fails its own type —
    # the same reason conftest's `_make_user` sets each field explicitly.
    row.logo_url = None
    row.primary_color = None
    row.secondary_color = None
    row.custom_title = None
    row.custom_footer = None
    row.viewer_layout = "grid"
    row.featured_field = None
    return row


class TestTheResponseSignsOnlyOwnedKeys:
    def test_an_owned_key_is_signed(self):
        from apps.api.routers.branding import _branding_to_response

        key = new_project_logo_key(PROJECT)
        resp = _branding_to_response(_branding_row(PROJECT, key))
        assert resp.logo_url and resp.logo_url.startswith("/stream/hls/")

    @pytest.mark.parametrize(
        "key",
        [
            "raw/x/y.mov",
            f"branding/{OTHER_PROJECT}/logo/x.webp",
            f"branding/{PROJECT}/logo/%2e%2e%2fraw%2fx.mov",
        ],
    )
    def test_an_unowned_key_yields_no_url_and_is_logged(self, key, caplog):
        from apps.api.routers.branding import _branding_to_response

        with caplog.at_level("WARNING"):
            resp = _branding_to_response(_branding_row(PROJECT, key))

        assert resp.logo_url is None
        assert str(PROJECT) in caplog.text
        # The refused value never reaches a log line that a response could
        # then echo, and never the response itself.
        assert key not in caplog.text

    def test_a_site_settings_column_is_signed_only_for_its_own_slot(self):
        from apps.api.routers.site_settings import _signed_brand_image_url

        row = MagicMock()
        row.logo_light_s3_key = new_site_logo_key("light")
        row.logo_dark_s3_key = "raw/x/y.mov"
        row.favicon_s3_key = new_site_logo_key("light")  # right tree, wrong slot

        assert _signed_brand_image_url(row, "logo_light_s3_key").startswith("/stream/hls/")
        assert _signed_brand_image_url(row, "logo_dark_s3_key") is None
        assert _signed_brand_image_url(row, "favicon_s3_key") is None

    def test_a_signed_logo_token_is_scoped_to_the_logo_directory(self):
        """What the check is actually worth: the token minted for a legitimate
        key reaches that project's logo directory and nothing above it."""
        from jose import jwt

        from apps.api.config import settings
        from apps.api.routers.branding import _branding_to_response

        key = new_project_logo_key(PROJECT)
        resp = _branding_to_response(_branding_row(PROJECT, key))
        token = resp.logo_url.split("token=", 1)[1]
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert payload["pfx"] == f"branding/{PROJECT}/logo"


class TestTheAvatarResponseShapes:
    @pytest.mark.parametrize(
        "schema_path,extra",
        [
            ("apps.api.schemas.auth:ContactUserResponse", {}),
            ("apps.api.schemas.comment:AuthorInfo", {}),
        ],
    )
    def test_an_unowned_avatar_is_not_handed_out(self, schema_path, extra):
        module_name, class_name = schema_path.split(":")
        import importlib

        schema = getattr(importlib.import_module(module_name), class_name)
        payload = {
            "id": USER,
            "name": "Someone",
            "email": "someone@example.com",
            "avatar_url": "https://evil.example/tracker.png",
            **extra,
        }
        built = schema(**{k: v for k, v in payload.items() if k in schema.model_fields})
        assert built.avatar_url is None

    def test_a_real_avatar_still_comes_through(self):
        from apps.api.routers.hls_proxy import proxy_url_for
        from apps.api.schemas.comment import AuthorInfo

        stored = proxy_url_for(new_avatar_key(USER), expires_hours=24 * 365 * 5)
        assert AuthorInfo(id=USER, name="Someone", avatar_url=stored).avatar_url == stored


# ─── the write side, without a database ──────────────────────────────────────


class TestUpsertBrandingRefusesUnownedKeys:
    """Called directly rather than over HTTP: the mocked session cannot answer
    `require_project_role`, and what is under test is the field handling."""

    def _call(self, body_kwargs, row):
        from apps.api.routers import branding as branding_router
        from apps.api.schemas.branding import BrandingUpdate

        db = MagicMock()
        user = MagicMock()
        user.id = uuid.uuid4()
        with patch.object(branding_router, "require_project_role"), patch.object(
            branding_router, "_get_or_create_branding", return_value=row
        ):
            return branding_router.upsert_branding(
                project_id=PROJECT,
                body=BrandingUpdate(**body_kwargs),
                db=db,
                current_user=user,
            )

    def test_an_owned_key_is_stored(self):
        row = _branding_row(PROJECT, None)
        key = new_project_logo_key(PROJECT)
        self._call({"logo_s3_key": key}, row)
        assert row.logo_s3_key == key

    @pytest.mark.parametrize(
        "key",
        [
            "raw/x/y.mov",
            f"branding/{OTHER_PROJECT}/logo/x.webp",
            f"branding/{PROJECT}/logo/../../raw/x.mov",
            f"branding/{PROJECT}/logo/%2e%2e%2fraw%2fx.mov",
            f"branding/{PROJECT}/logo/nested/x.webp",
            f"https://evil.example/branding/{PROJECT}/logo/x.webp",
        ],
    )
    def test_an_unowned_key_is_a_400_and_writes_nothing(self, key):
        from fastapi import HTTPException

        row = _branding_row(PROJECT, None)
        with pytest.raises(HTTPException) as exc:
            self._call({"logo_s3_key": key}, row)
        assert exc.value.status_code == 400
        assert row.logo_s3_key is None
        # One generic message for every shape — a caller probing for readable
        # object paths must not be able to tell them apart.
        from apps.api.routers.branding import INVALID_LOGO_KEY

        assert exc.value.detail == INVALID_LOGO_KEY

    def test_an_unowned_key_does_not_take_the_rest_of_the_payload_with_it(self):
        """The refusal happens before anything is written, so a PATCH that
        carries a colour alongside a bad key changes neither."""
        from fastapi import HTTPException

        row = _branding_row(PROJECT, None)
        row.primary_color = "#000000"
        with pytest.raises(HTTPException):
            self._call({"logo_s3_key": "raw/x/y.mov", "primary_color": "#FF5733"}, row)
        assert row.primary_color == "#000000"

    @pytest.mark.parametrize("cleared", [None, "", "   "])
    def test_an_empty_value_clears(self, cleared):
        row = _branding_row(PROJECT, new_project_logo_key(PROJECT))
        self._call({"logo_s3_key": cleared}, row)
        assert row.logo_s3_key is None

    def test_a_payload_without_the_field_leaves_the_logo_alone(self):
        key = new_project_logo_key(PROJECT)
        row = _branding_row(PROJECT, key)
        self._call({"custom_title": "Hello"}, row)
        assert row.logo_s3_key == key
        assert row.custom_title == "Hello"


class TestUpdateUserIgnoresAvatarUrl:
    def _call(self, body_kwargs, user):
        from apps.api.routers.users import update_user
        from apps.api.schemas.auth import UpdateProfileRequest

        db = MagicMock()
        db.query.return_value = db
        db.filter.return_value = db
        db.first.return_value = user
        return update_user(
            user_id=user.id,
            body=UpdateProfileRequest(**body_kwargs),
            db=db,
            current_user=user,
        )

    def _user(self, avatar):
        from apps.api.models.user import UserGlobalRole, UserStatus

        user = MagicMock()
        user.id = USER
        user.avatar_url = avatar
        user.role = UserGlobalRole.user
        user.status = UserStatus.active
        user.deleted_at = None
        return user

    def test_an_avatar_url_in_the_body_is_dropped(self):
        user = self._user(None)
        self._call({"avatar_url": "https://evil.example/tracker.png"}, user)
        assert user.avatar_url is None

    def test_it_cannot_overwrite_a_real_avatar_either(self):
        from apps.api.routers.hls_proxy import proxy_url_for

        stored = proxy_url_for(new_avatar_key(USER), expires_hours=24 * 365 * 5)
        user = self._user(stored)
        self._call({"avatar_url": "https://evil.example/tracker.png"}, user)
        assert user.avatar_url == stored

    def test_the_name_fields_still_apply(self):
        user = self._user(None)
        self._call({"first_name": "New", "last_name": "Name"}, user)
        assert user.first_name == "New"
        assert user.last_name == "Name"


class TestSiteSettingsRefusesUnownedKeys:
    """PATCH /site-settings is superadmin-only, so this goes through the real
    route with a superadmin stub — the gate itself has its own coverage in
    test_brand_image_never_clears.py."""

    def _patch(self, client, mock_db, payload, row):
        from apps.api.models.user import UserGlobalRole
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        admin = MagicMock()
        admin.id = uuid.uuid4()
        admin.role = UserGlobalRole.superadmin
        app.dependency_overrides[get_current_user] = lambda: admin
        mock_db.first.return_value = row
        try:
            return client.patch("/site-settings", json=payload)
        finally:
            app.dependency_overrides.pop(get_current_user, None)

    def _row(self):
        row = MagicMock()
        for column in SITE_BRAND_IMAGE_COLUMNS:
            setattr(row, column, None)
        row.org_name = "FreeFrame"
        row.theme_colors = None
        row.total_storage_limit_bytes = None
        row.timezone = "UTC"
        row.require_2fa = False
        return row

    @pytest.mark.parametrize("column", SITE_BRAND_IMAGE_COLUMNS)
    def test_an_unowned_key_is_a_400(self, client, mock_db, column):
        row = self._row()
        resp = self._patch(client, mock_db, {column: "raw/x/y.mov"}, row)
        assert resp.status_code == 400
        assert getattr(row, column) is None

    def test_a_logo_key_in_the_favicon_column_is_a_400(self, client, mock_db):
        row = self._row()
        resp = self._patch(
            client, mock_db, {"favicon_s3_key": new_site_logo_key("light")}, row
        )
        assert resp.status_code == 400
        assert row.favicon_s3_key is None

    @pytest.mark.parametrize("side", SITE_LOGO_SIDES)
    def test_an_issued_key_is_accepted(self, client, mock_db, side):
        row = self._row()
        key = new_site_logo_key(side)
        resp = self._patch(client, mock_db, {f"logo_{side}_s3_key": key}, row)
        assert resp.status_code == 200
        assert getattr(row, f"logo_{side}_s3_key") == key

    def test_a_bad_key_takes_nothing_else_with_it(self, client, mock_db):
        row = self._row()
        resp = self._patch(
            client, mock_db, {"org_name": "Renamed", "favicon_s3_key": "raw/x.png"}, row
        )
        assert resp.status_code == 400
        assert row.org_name == "FreeFrame"


class TestTheUnauthenticatedLogoImageRoute:
    """GET /site-settings/logo-image takes no token and never expires, so an
    unowned key there is a permanent public read of one bucket object."""

    def _get(self, client, mock_db, key):
        row = MagicMock()
        row.logo_light_s3_key = key
        mock_db.first.return_value = row
        return client.get("/site-settings/logo-image")

    def test_an_unowned_key_is_not_served(self, client, mock_db):
        assert self._get(client, mock_db, "raw/x/y.mov").status_code == 404

    def test_an_issued_key_is_served(self, client, mock_db):
        body = b"\x89PNG\r\n\x1a\nrest"
        s3 = MagicMock()
        s3.get_object.return_value = {"Body": MagicMock(read=lambda: body)}
        with patch("apps.api.services.s3_service.get_s3_client", return_value=s3):
            resp = self._get(client, mock_db, new_site_logo_key("light"))
        assert resp.status_code == 200
        assert resp.content == body


# ─── against a real database ─────────────────────────────────────────────────

PG_URL = os.environ.get("TEST_DATABASE_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; "
           "'the column did not change' is not something the mocked session "
           "can express",
)

API_DIR = Path(__file__).resolve().parents[1]
MIGRATION = API_DIR / "alembic" / "versions" / "null_unowned_brand_keys.py"


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def world(sessionmaker_):
    """Two projects, an editor of the FIRST one only, and a viewer.

    Named rows only, deleted on the way out: this database may be a scratch
    copy of a real one, so nothing here truncates a table.
    """
    from apps.api.models.branding import ProjectBranding
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    from apps.api.services.auth_service import hash_password

    session = sessionmaker_()
    # `middleware/setup_guard.py` reads the real database past any dependency
    # override and answers 503 to everything when no superadmin exists.
    if (
        session.query(User)
        .filter(User.role == UserGlobalRole.superadmin, User.deleted_at.is_(None))
        .first()
        is None
    ):
        session.add(
            User(
                email="setup-guard@ff235.test",
                first_name="Setup",
                last_name="Guard",
                status=UserStatus.active,
                role=UserGlobalRole.superadmin,
                email_verified=True,
            )
        )
        session.commit()

    def _user(label, role=UserGlobalRole.user):
        return User(
            email=f"{label}-{uuid.uuid4().hex[:10]}@ff235.test",
            first_name=label.title(),
            last_name="Tester",
            password_hash=hash_password("Tf4#qRn8!vZw"),
            status=UserStatus.active,
            role=role,
            email_verified=True,
            backup_email=f"{uuid.uuid4().hex[:10]}@backup235.test",
            backup_email_verified_at=datetime.now(timezone.utc),
        )

    editor, viewer, admin = _user("editor"), _user("viewer"), _user(
        "admin", UserGlobalRole.superadmin
    )
    session.add_all([editor, viewer, admin])
    session.commit()

    mine = Project(name=f"Mine-{uuid.uuid4().hex[:8]}", created_by=editor.id)
    theirs = Project(name=f"Theirs-{uuid.uuid4().hex[:8]}", created_by=admin.id)
    session.add_all([mine, theirs])
    session.commit()
    session.add_all([
        ProjectMember(project_id=mine.id, user_id=editor.id, role=ProjectRole.editor),
        ProjectMember(project_id=mine.id, user_id=viewer.id, role=ProjectRole.viewer),
        ProjectMember(project_id=theirs.id, user_id=admin.id, role=ProjectRole.owner),
    ])
    session.commit()

    bag = {
        "session": session,
        "editor": editor,
        "viewer": viewer,
        "admin": admin,
        "mine": mine,
        "theirs": theirs,
    }
    try:
        yield bag
    finally:
        session.rollback()
        for project in (mine, theirs):
            session.query(ProjectBranding).filter(
                ProjectBranding.project_id == project.id
            ).delete(synchronize_session=False)
            session.query(ProjectMember).filter(
                ProjectMember.project_id == project.id
            ).delete(synchronize_session=False)
            session.query(Project).filter(Project.id == project.id).delete(
                synchronize_session=False
            )
        session.query(User).filter(
            User.id.in_([editor.id, viewer.id, admin.id])
        ).delete(synchronize_session=False)
        session.commit()
        session.close()


@pytest.fixture
def real_client(world):
    """The real app on the real session, with `get_current_user` left alone so
    a real bearer token has to actually authenticate.

    S3 is a stub, but `generate_presigned_url` has to return a real string:
    the logo-upload route puts it in a response model, and a MagicMock there
    fails serialisation as a 500 that looks like a route error.
    """
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "http://s3.test/put?sig=stub"
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=s3
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        yield TestClient(app, raise_server_exceptions=False)
        app.dependency_overrides.clear()


def auth(user):
    from apps.api.services.auth_service import create_access_token

    return {
        "Authorization": "Bearer "
        + create_access_token(str(user.id), user.token_version or 0)
    }


def _stored_logo(session, project_id):
    from apps.api.models.branding import ProjectBranding

    session.expire_all()
    row = session.query(ProjectBranding).filter(
        ProjectBranding.project_id == project_id
    ).first()
    return row.logo_s3_key if row else None


@realdb
class TestTheColumnDoesNotTakeAnUnownedKey:
    def test_an_editor_cannot_name_another_projects_prefix(self, world, real_client):
        """THE assertion this file exists for, against real SQL."""
        session, editor, mine, theirs = (
            world["session"], world["editor"], world["mine"], world["theirs"]
        )
        resp = real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": f"branding/{theirs.id}/logo/{uuid.uuid4()}.webp"},
            headers=auth(editor),
        )
        assert resp.status_code == 400
        assert _stored_logo(session, mine.id) is None

    @pytest.mark.parametrize(
        "key_template",
        [
            "raw/x/y.mov",
            "raw/y.mov",
            "branding/{mine}/logo/../../raw/x.mov",
            "branding/{mine}/logo/%2e%2e%2fraw%2fx.mov",
            "branding/{mine}/logo/nested/x.webp",
            "branding/{mine}/logo/",
            "/branding/{mine}/logo/x.webp",
            "https://evil.example/branding/{mine}/logo/x.webp",
        ],
    )
    def test_nor_anything_else_it_was_not_issued(
        self, world, real_client, key_template
    ):
        session, editor, mine = world["session"], world["editor"], world["mine"]
        resp = real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": key_template.format(mine=mine.id)},
            headers=auth(editor),
        )
        assert resp.status_code == 400
        assert _stored_logo(session, mine.id) is None

    def test_its_own_issued_key_is_accepted_and_usable(self, world, real_client):
        """End to end: the upload route issues a key, the PUT accepts it, and
        the URL that comes back is one the proxy would honour for exactly that
        project's logo directory."""
        from jose import jwt

        from apps.api.config import settings

        session, editor, mine = world["session"], world["editor"], world["mine"]

        issued = real_client.post(
            f"/projects/{mine.id}/branding/logo-upload", headers=auth(editor)
        )
        assert issued.status_code == 201
        key = issued.json()["key"]

        resp = real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": key},
            headers=auth(editor),
        )
        assert resp.status_code == 200
        assert _stored_logo(session, mine.id) == key

        logo_url = resp.json()["logo_url"]
        assert logo_url.startswith("/stream/hls/")
        payload = jwt.decode(
            logo_url.split("token=", 1)[1],
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
        )
        assert payload["pfx"] == f"branding/{mine.id}/logo"

    def test_null_clears_it(self, world, real_client):
        session, editor, mine = world["session"], world["editor"], world["mine"]
        key = new_project_logo_key(mine.id)
        real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": key},
            headers=auth(editor),
        )
        assert _stored_logo(session, mine.id) == key

        resp = real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": None},
            headers=auth(editor),
        )
        assert resp.status_code == 200
        assert resp.json()["logo_url"] is None
        assert _stored_logo(session, mine.id) is None

    def test_a_viewer_cannot_write_at_all(self, world, real_client):
        session, viewer, mine = world["session"], world["viewer"], world["mine"]
        resp = real_client.put(
            f"/projects/{mine.id}/branding",
            json={"logo_s3_key": new_project_logo_key(mine.id)},
            headers=auth(viewer),
        )
        assert resp.status_code == 403
        assert _stored_logo(session, mine.id) is None

    def test_a_bad_row_that_predates_the_rule_returns_no_logo_url(
        self, world, real_client
    ):
        """Defence in depth: the row is written straight into the table, the
        way one written before §235 sits there today."""
        from apps.api.models.branding import ProjectBranding

        session, editor, mine = world["session"], world["editor"], world["mine"]
        session.add(ProjectBranding(project_id=mine.id, logo_s3_key="raw/x/y.mov"))
        session.commit()

        resp = real_client.get(f"/projects/{mine.id}/branding", headers=auth(editor))
        assert resp.status_code == 200
        assert resp.json()["logo_url"] is None
        # Still in the column — the response refuses to sign it, the
        # migration is what removes it.
        assert _stored_logo(session, mine.id) == "raw/x/y.mov"


@realdb
class TestTheAvatarColumnDoesNotTakeABodyValue:
    def test_a_patch_cannot_set_an_avatar_url(self, world, real_client):
        from apps.api.models.user import User

        session, editor = world["session"], world["editor"]
        resp = real_client.patch(
            f"/users/{editor.id}",
            json={"first_name": "Renamed", "avatar_url": "https://evil.example/t.png"},
            headers=auth(editor),
        )
        assert resp.status_code == 200
        assert resp.json()["avatar_url"] is None

        session.expire_all()
        row = session.query(User).filter(User.id == editor.id).first()
        assert row.avatar_url is None
        # The rest of the payload still applied.
        assert row.first_name == "Renamed"

    def test_nor_can_a_superadmin_set_one_on_somebody_else(self, world, real_client):
        from apps.api.models.user import User

        session, admin, editor = world["session"], world["admin"], world["editor"]
        resp = real_client.patch(
            f"/users/{editor.id}",
            json={"avatar_url": "https://evil.example/t.png"},
            headers=auth(admin),
        )
        assert resp.status_code == 200
        session.expire_all()
        row = session.query(User).filter(User.id == editor.id).first()
        assert row.avatar_url is None

    def test_a_real_avatar_is_still_shown(self, world, real_client):
        from apps.api.models.user import User
        from apps.api.routers.hls_proxy import proxy_url_for

        session, editor = world["session"], world["editor"]
        stored = proxy_url_for(new_avatar_key(editor.id), expires_hours=24 * 365 * 5)
        session.query(User).filter(User.id == editor.id).update(
            {"avatar_url": stored}, synchronize_session=False
        )
        session.commit()

        resp = real_client.get("/auth/me", headers=auth(editor))
        assert resp.status_code == 200
        assert resp.json()["avatar_url"] == stored

    def test_a_pre_existing_bad_value_is_not_handed_out(self, world, real_client):
        from apps.api.models.user import User

        session, editor = world["session"], world["editor"]
        session.query(User).filter(User.id == editor.id).update(
            {"avatar_url": "https://evil.example/tracker.png"},
            synchronize_session=False,
        )
        session.commit()

        resp = real_client.get("/auth/me", headers=auth(editor))
        assert resp.status_code == 200
        assert resp.json()["avatar_url"] is None


@realdb
class TestTheMigration:
    """D — run as the deploy runs it (`alembic upgrade head`), not by calling
    its helpers, so a revision that forgot one of the three tables fails here.
    The downgrade is a no-op, which is what makes stepping back and forward
    again safe to do in a test."""

    def _alembic(self, *args):
        assert shutil.which("alembic"), "alembic is not installed in this environment"
        env = dict(os.environ, DATABASE_URL=PG_URL)
        return subprocess.run(
            ["alembic", *args],
            cwd=str(API_DIR),
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
        )

    def test_there_is_exactly_one_head_and_it_is_this_revision(self):
        result = self._alembic("heads")
        assert result.returncode == 0, result.stderr
        heads = [line for line in result.stdout.splitlines() if line.strip()]
        assert len(heads) == 1, result.stdout
        assert heads[0].startswith("null_unowned_brand_keys")

    def test_the_revision_id_fits_the_version_column(self):
        spec = importlib.util.spec_from_file_location("ff235_migration", MIGRATION)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert len(module.revision) <= 32

    def test_it_nulls_the_bad_rows_and_keeps_the_good_ones(self, world):
        from apps.api.models.branding import ProjectBranding
        from apps.api.models.site_settings import SiteSettings
        from apps.api.models.user import User
        from apps.api.routers.hls_proxy import proxy_url_for

        session = world["session"]
        # Plain ids, not ORM instances: the assertions below run after a
        # commit and a re-read, and an instance that went stale in between
        # would fail on the refresh rather than on the value under test.
        editor_id, viewer_id = world["editor"].id, world["viewer"].id
        mine_id, theirs_id = world["mine"].id, world["theirs"].id

        good_logo = new_project_logo_key(mine_id)
        good_avatar = proxy_url_for(new_avatar_key(viewer_id), expires_hours=24)
        session.add_all([
            ProjectBranding(project_id=mine_id, logo_s3_key=good_logo),
            # Another project's prefix: the exploitable shape.
            ProjectBranding(
                project_id=theirs_id, logo_s3_key=f"branding/{mine_id}/logo/x.webp"
            ),
        ])
        session.query(User).filter(User.id == editor_id).update(
            {"avatar_url": "https://evil.example/tracker.png"},
            synchronize_session=False,
        )
        session.query(User).filter(User.id == viewer_id).update(
            {"avatar_url": good_avatar}, synchronize_session=False
        )
        session.commit()

        settings_id = session.query(SiteSettings.id).scalar()
        if settings_id is None:
            row = SiteSettings(org_name="FreeFrame")
            session.add(row)
            session.commit()
            settings_id = row.id
        before = dict(
            session.query(*[getattr(SiteSettings, c) for c in SITE_BRAND_IMAGE_COLUMNS])
            .filter(SiteSettings.id == settings_id)
            .one()
            ._mapping
        )
        good_site_logo = new_site_logo_key("light")
        session.query(SiteSettings).filter(SiteSettings.id == settings_id).update(
            # `raw/` is the worst shape there is: `posixpath.split` scopes a
            # token minted from it at `raw`, the whole media tree, and this
            # response is public.
            {"logo_light_s3_key": good_site_logo, "logo_dark_s3_key": "raw/"},
            synchronize_session=False,
        )
        session.commit()

        try:
            down = self._alembic("downgrade", "-1")
            assert down.returncode == 0, down.stderr
            up = self._alembic("upgrade", "head")
            assert up.returncode == 0, up.stderr

            session.expire_all()
            kept = session.query(ProjectBranding).filter(
                ProjectBranding.project_id == mine_id
            ).one()
            cleared = session.query(ProjectBranding).filter(
                ProjectBranding.project_id == theirs_id
            ).one()
            assert kept.logo_s3_key == good_logo
            assert cleared.logo_s3_key is None

            avatars = dict(
                session.query(User.id, User.avatar_url)
                .filter(User.id.in_([editor_id, viewer_id]))
                .all()
            )
            assert avatars[viewer_id] == good_avatar
            assert avatars[editor_id] is None

            site = session.query(SiteSettings).filter(
                SiteSettings.id == settings_id
            ).one()
            assert site.logo_light_s3_key == good_site_logo
            assert site.logo_dark_s3_key is None
        finally:
            # The site_settings row is a singleton this database shares with
            # every other test, so it goes back exactly as it was found.
            session.query(SiteSettings).filter(SiteSettings.id == settings_id).update(
                before, synchronize_session=False
            )
            session.commit()
