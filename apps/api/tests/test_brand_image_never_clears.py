"""A configured logo or favicon is never cleared back to the default (§178).

NULL in these four columns means "show the bundled FreeFrame logo". The
requirement is that an organisation which has ever set its own brand image
is never shown that default again — so once the column holds a key, nothing
puts it back to NULL: not a Remove click, not "Reset to defaults", not a
hand-written PATCH from a stale browser tab.

The half that is easy to break while fixing the other half is the
fresh-install case, which has its own section at the bottom: an instance
that has never been branded MUST still show the default. This rule protects
a value that exists; it does not invent one.

These drive the real route through the real FastAPI stack, with the DB
mocked the way the rest of this suite does it, because the behaviour under
test lives in the request handler — a unit test of the model would assert
nothing about what a PATCH does.
"""
import uuid
from unittest.mock import MagicMock

import pytest

from apps.api.models.user import UserGlobalRole

DARK_KEY = "site-settings/logo-dark/abc.webp"
LIGHT_KEY = "site-settings/logo-light/def.webp"
LOGIN_KEY = "site-settings/logo-login/ghi.webp"
FAVICON_KEY = "site-settings/favicon-jkl.png"

BRAND_FIELDS = (
    "logo_dark_s3_key",
    "logo_light_s3_key",
    "logo_login_s3_key",
    "favicon_s3_key",
)


def _settings_row(**overrides):
    """A SiteSettings row. Plain object, not a MagicMock: the code under
    test both reads and writes attributes, and a MagicMock would report
    every column as truthy whether or not anything ever set it."""

    class Row:
        pass

    row = Row()
    row.org_name = "Acme Studio"
    row.logo_dark_s3_key = None
    row.logo_light_s3_key = None
    row.logo_login_s3_key = None
    row.favicon_s3_key = None
    row.theme_colors = None
    row.total_storage_limit_bytes = None
    for k, v in overrides.items():
        setattr(row, k, v)
    return row


@pytest.fixture
def configured(mock_db):
    """An org that has set all four brand images."""
    row = _settings_row(
        logo_dark_s3_key=DARK_KEY,
        logo_light_s3_key=LIGHT_KEY,
        logo_login_s3_key=LOGIN_KEY,
        favicon_s3_key=FAVICON_KEY,
    )
    mock_db.query.return_value.first.return_value = row
    return row


@pytest.fixture
def fresh(mock_db):
    """An install that has never been branded — every key NULL."""
    row = _settings_row()
    mock_db.query.return_value.first.return_value = row
    return row


@pytest.fixture
def superadmin(test_user):
    test_user.role = UserGlobalRole.superadmin
    return test_user


# ── the rule ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("field,key", list(zip(BRAND_FIELDS, (DARK_KEY, LIGHT_KEY, LOGIN_KEY, FAVICON_KEY))))
def test_a_configured_brand_image_survives_a_null_patch(
    client, auth_headers, superadmin, configured, field, key
):
    """This is the "Remove" click, at the layer that has to hold the line.
    Whatever the UI offers or stops offering, the API is what a stale tab,
    a replayed request or the next redesign will hit."""
    resp = client.patch("/site-settings", json={field: None}, headers=auth_headers)

    assert resp.status_code == 200
    assert getattr(configured, field) == key, "the column was cleared"


def test_the_response_shows_the_logo_still_there(
    client, auth_headers, superadmin, configured
):
    """Ignored, not silently accepted: the caller is told the truth in the
    same response, rather than getting a 200 that looks like a success."""
    resp = client.patch(
        "/site-settings", json={"logo_dark_s3_key": None}, headers=auth_headers
    )

    assert resp.json()["logo_dark_url"] is not None


def test_clearing_every_brand_field_at_once_clears_none_of_them(
    client, auth_headers, superadmin, configured
):
    """The legacy "Reset to defaults" payload, which sent all four."""
    resp = client.patch(
        "/site-settings",
        json={f: None for f in BRAND_FIELDS},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["logo_dark_url"] is not None
    assert body["logo_light_url"] is not None
    assert body["logo_login_url"] is not None
    assert body["favicon_url"] is not None


def test_the_rest_of_a_reset_payload_still_applies(
    client, auth_headers, superadmin, configured
):
    """Ignoring the brand fields must not take the whole request down with
    them — an old client's reset payload carries a name and a palette that
    SHOULD be reset, and a 400 would silently lose those."""
    configured.theme_colors = {"dark": {"accent": "#ff0000"}}

    resp = client.patch(
        "/site-settings",
        json={
            "org_name": "FreeFrame",
            "theme_colors": None,
            **{f: None for f in BRAND_FIELDS},
        },
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert configured.org_name == "FreeFrame"
    assert configured.theme_colors is None
    assert configured.logo_dark_s3_key == DARK_KEY


def test_replacing_a_logo_with_a_new_key_still_works(
    client, auth_headers, superadmin, configured
):
    """The rule is about NULL specifically. Going from one key to another is
    what "Replace" does, and it must stay completely unaffected — a guard
    that froze the column outright would make the logo unchangeable."""
    resp = client.patch(
        "/site-settings",
        json={"logo_dark_s3_key": "site-settings/logo-dark/new.webp"},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert configured.logo_dark_s3_key == "site-settings/logo-dark/new.webp"


def test_unrelated_fields_are_untouched_by_the_guard(
    client, auth_headers, superadmin, configured
):
    """Only the four brand-image columns are protected. A storage limit of
    NULL means "no cap" and must still be settable."""
    configured.total_storage_limit_bytes = 500

    resp = client.patch(
        "/site-settings",
        json={"total_storage_limit_bytes": None},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert configured.total_storage_limit_bytes is None


# ── the fresh install, which must NOT be broken by any of the above ─────────

def test_a_never_branded_install_still_reports_no_logo(
    client, auth_headers, superadmin, fresh
):
    """The default is still reachable where it should be. A guard written as
    "these columns can never be NULL" would have made this impossible."""
    resp = client.get("/site-settings")

    body = resp.json()
    assert body["logo_dark_url"] is None
    assert body["logo_light_url"] is None
    assert body["logo_login_url"] is None
    assert body["favicon_url"] is None


def test_a_null_patch_on_a_never_branded_install_is_not_an_error(
    client, auth_headers, superadmin, fresh
):
    """Nothing to protect, so nothing happens — and it must not 4xx: this is
    exactly what a fresh instance's own reset sends."""
    resp = client.patch(
        "/site-settings",
        json={f: None for f in BRAND_FIELDS},
        headers=auth_headers,
    )

    assert resp.status_code == 200
    assert all(getattr(fresh, f) is None for f in BRAND_FIELDS)


def test_a_fresh_install_can_still_set_its_first_logo(
    client, auth_headers, superadmin, fresh
):
    resp = client.patch(
        "/site-settings", json={"logo_dark_s3_key": DARK_KEY}, headers=auth_headers
    )

    assert resp.status_code == 200
    assert fresh.logo_dark_s3_key == DARK_KEY


def test_the_guarded_field_list_matches_the_columns_that_exist():
    """A typo'd name in BRAND_IMAGE_FIELDS would guard nothing and the tests
    above would all still pass, because a field that is never matched is
    just a field that is set normally."""
    from apps.api.models.site_settings import SiteSettings
    from apps.api.routers.site_settings import BRAND_IMAGE_FIELDS

    columns = set(SiteSettings.__table__.c.keys())
    assert set(BRAND_IMAGE_FIELDS) <= columns
    assert set(BRAND_IMAGE_FIELDS) == set(BRAND_FIELDS)
