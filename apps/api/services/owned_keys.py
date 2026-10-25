"""Which storage keys a column may name — by the prefix the server issued it under.

Several columns hold an object key that a client hands back (or used to hand
back) after an upload: a project's logo, the instance's logos and favicon, a
user's avatar. Every response that shows one turns it into a download link,
and in this codebase that link is minted by
`routers/hls_proxy.py::proxy_url_for`, which does NOT sign one object — it
splits the key into prefix + filename and signs a token "scoped to everything
under an S3 prefix". The proxy then serves any object under that prefix for
the token's whole lifetime.

That is what makes an unvalidated key column a read primitive rather than a
cosmetic bug (§235). An editor of any project could PUT
`logo_s3_key = "raw/<other project>/x.png"` and read back a 24-hour token for
everything under `raw/<other project>`; a one-segment key like `raw/x.png`
scopes the token at `raw`, i.e. the whole tree. So a column is only trusted
when it names an object the server itself issued FOR THAT SLOT:

    <issued prefix><one path segment>

Anything else — a full URL, another project's or user's prefix, extra path
segments, a `.`/`..` segment, a leading slash, a percent-encoded variant of
any of those — is treated as nothing: never accepted on a write, never signed
on a read, never served.

The key FORMATS live here and nowhere else. The upload routes build their keys
with the `new_*_key` helpers below and the checks use the matching `is_*`
predicate, so the issuing code and the validator cannot drift —
tests/test_owned_keys.py asserts that every issued key passes its own
validator. `alembic/versions/null_unowned_brand_keys.py` clears the rows that
predate the rule and imports these same predicates rather than restating them
in SQL, for the same reason.

Stdlib only, deliberately: this module is imported by routers, by schemas and
by a migration (which runs with `apps/api` on sys.path and no `apps.api`
package), so it must not pull in config, the database or boto3.
"""

import re
import uuid
from typing import Optional
from urllib.parse import unquote, unquote_plus

# A segment that is empty, or that re-enters the path, is not a filename.
_FORBIDDEN_SEGMENTS = frozenset(("", ".", ".."))

#: How many times a candidate is percent-decoded before being checked. One
#: pass catches `%2e%2e`, the second catches `%252e%252e` — a value that
#: survives one layer of decoding somewhere downstream and then re-enters the
#: path. Both the raw and every decoded form must pass, so a key is accepted
#: only if it contains no encoding games at all.
_DECODE_PASSES = 2


def _candidates(key: str) -> tuple[str, ...]:
    """The raw string plus its percent-decoded forms, deduplicated."""
    out = [key]
    current = key
    for _ in range(_DECODE_PASSES):
        decoded = unquote(current)
        if decoded == current:
            break
        out.append(decoded)
        current = decoded
    # `+` is a space only in form encoding, but a key that reads differently
    # under that rule is not a key this server issued either.
    plus = unquote_plus(key)
    if plus not in out:
        out.append(plus)
    return tuple(out)


def _is_plain_segment(name: str) -> bool:
    if name in _FORBIDDEN_SEGMENTS:
        return False
    if "/" in name or "\\" in name:
        return False
    # No control characters: a filename carrying a newline or a NUL is not one
    # this server issued, and it has no business reaching an S3 GET.
    return not any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name)


def is_owned_key(prefix: str, key: Optional[str]) -> bool:
    """True only for `prefix` followed by one plain path segment.

    Checked against the raw string AND its decoded forms (see `_candidates`),
    so `branding/<id>/logo/%2e%2e%2fsecret` is rejected on the decoded pass
    even though the raw string looks like a single segment.
    """
    if not prefix or not isinstance(key, str) or not key:
        return False
    for candidate in _candidates(key):
        if not candidate.startswith(prefix):
            return False
        if not _is_plain_segment(candidate[len(prefix):]):
            return False
    return True


# ── Project branding ─────────────────────────────────────────────────────────
# Issued by POST /projects/{project_id}/branding/logo-upload, stored in
# project_brandings.logo_s3_key.

def project_logo_prefix(project_id: uuid.UUID | str) -> str:
    return f"branding/{project_id}/logo/"


def new_project_logo_key(project_id: uuid.UUID | str) -> str:
    """The key the logo upload route issues. The only format that column trusts."""
    return f"{project_logo_prefix(project_id)}{uuid.uuid4()}.webp"


def is_owned_project_logo_key(
    project_id: uuid.UUID | str | None, key: Optional[str]
) -> bool:
    if not project_id:
        return False
    return is_owned_key(project_logo_prefix(project_id), key)


# Issued by POST /projects/{project_id}/watermark/image-upload. No column
# stores it today (apply_watermark_to_asset passes image_key=None), so nothing
# validates it on a write — the builder and predicate exist so that the format
# stays in one place if a column ever does.

def watermark_image_prefix(project_id: uuid.UUID | str) -> str:
    return f"branding/{project_id}/watermark/"


def new_watermark_image_key(project_id: uuid.UUID | str) -> str:
    return f"{watermark_image_prefix(project_id)}{uuid.uuid4()}.png"


def is_owned_watermark_image_key(
    project_id: uuid.UUID | str | None, key: Optional[str]
) -> bool:
    if not project_id:
        return False
    return is_owned_key(watermark_image_prefix(project_id), key)


# ── Instance branding ────────────────────────────────────────────────────────
# Issued by POST /site-settings/logo-upload?side=dark|light|login and POST
# /site-settings/favicon-upload. Each column accepts only its own slot: a
# light-logo key in the favicon column is as unowned as `raw/x.mov`, because
# nothing in the server would ever have put it there.

#: site_settings column -> the `side` its upload route takes.
SITE_LOGO_COLUMNS = {
    "logo_dark_s3_key": "dark",
    "logo_light_s3_key": "light",
    "logo_login_s3_key": "login",
}
SITE_LOGO_SIDES = tuple(SITE_LOGO_COLUMNS.values())
FAVICON_COLUMN = "favicon_s3_key"

#: Every column this module can rule on, in the order site_settings lists them.
SITE_BRAND_IMAGE_COLUMNS = tuple(SITE_LOGO_COLUMNS) + (FAVICON_COLUMN,)


def site_logo_prefix(side: str) -> str:
    return f"site-settings/logo-{side}/"


def new_site_logo_key(side: str) -> str:
    return f"{site_logo_prefix(side)}{uuid.uuid4()}.webp"


def is_owned_site_logo_key(side: str, key: Optional[str]) -> bool:
    if side not in SITE_LOGO_SIDES:
        return False
    return is_owned_key(site_logo_prefix(side), key)


#: The favicon is the one slot whose issued key has no directory of its own:
#: `site-settings/favicon-<uuid>.png`, a single segment under the shared
#: `site-settings/` prefix. `is_owned_key` against that prefix alone would
#: also accept any other name directly under `site-settings/`, so the segment
#: carries the slot: it has to be named the way the route names it.
#:
#: Deliberately the NAME SHAPE and not the uuid itself. A `<uuid>` regex would
#: be tighter without being safer — the prefix a favicon token is scoped to is
#: `site-settings`, which holds nothing but these four brand images either way
#: — and it would reject any key an operator had ever written by hand,
#: irreversibly, in the migration that clears unowned values.
FAVICON_PREFIX = "site-settings/"
_FAVICON_NAME_RE = re.compile(r"^favicon-.+\.png$")


def new_site_favicon_key() -> str:
    return f"{FAVICON_PREFIX}favicon-{uuid.uuid4()}.png"


def is_owned_site_favicon_key(key: Optional[str]) -> bool:
    if not is_owned_key(FAVICON_PREFIX, key):
        return False
    return bool(_FAVICON_NAME_RE.match(key[len(FAVICON_PREFIX):]))


def is_owned_site_brand_image_key(column: str, key: Optional[str]) -> bool:
    """The one entry point for site_settings' four brand-image columns."""
    if column == FAVICON_COLUMN:
        return is_owned_site_favicon_key(key)
    side = SITE_LOGO_COLUMNS.get(column)
    if side is None:
        return False
    return is_owned_site_logo_key(side, key)


# ── Avatars ──────────────────────────────────────────────────────────────────
# Two shapes, and the difference matters.
#
# POST /users/me/avatar uploads to `avatars/{user_id}/<uuid>.webp` — that is
# the OBJECT KEY, and `is_owned_avatar_key` rules on it. But the column does
# not hold it: the route stores `proxy_url_for(key, expires_hours=~5y)`, i.e.
# the finished proxy URL `/stream/hls/<filename>?token=<jwt>`, because
# `users.avatar_url` is handed to the browser verbatim with no resolution step
# at read time (routers/users.py::upload_avatar).
#
# So the value to validate on a user row is a URL, and `is_issued_avatar_url`
# rules on that. It checks the SHAPE the route emits, not the token's
# signature: a signature check would need the JWT secret, and rotating that
# secret would then silently erase every avatar on the instance (and, in the
# migration, irreversibly). An unowned value is still refused, because a value
# of any other shape is one nothing in this server ever wrote.

def avatar_prefix(user_id: uuid.UUID | str) -> str:
    return f"avatars/{user_id}/"


def new_avatar_key(user_id: uuid.UUID | str) -> str:
    """The object key the avatar upload route writes to S3."""
    return f"{avatar_prefix(user_id)}{uuid.uuid4()}.webp"


def is_owned_avatar_key(user_id: uuid.UUID | str | None, key: Optional[str]) -> bool:
    if not user_id:
        return False
    return is_owned_key(avatar_prefix(user_id), key)


#: `/stream/hls/<one segment>?token=<three base64url parts>` — what
#: `proxy_url_for` returns, and the only shape `users.avatar_url` ever held
#: (the pre-§235 PATCH route is the only way anything else got in). A trailing
#: `&download=` is not part of it: no avatar is ever minted with one.
_ISSUED_AVATAR_URL_RE = re.compile(
    r"^/stream/hls/[A-Za-z0-9._~-]+"
    r"\?token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$"
)


def is_issued_avatar_url(value: Optional[str]) -> bool:
    """True only for a proxy URL this server minted for an avatar."""
    if not isinstance(value, str) or not value:
        return False
    return all(bool(_ISSUED_AVATAR_URL_RE.match(c)) for c in _candidates(value))


def issued_avatar_url(value: Optional[str]) -> Optional[str]:
    """The stored avatar URL, or None when the column holds something else.

    Used by every response shape that carries `avatar_url`, so a row written
    before §235 closed the PATCH route cannot put a client-chosen string in
    front of other users.
    """
    return value if is_issued_avatar_url(value) else None
