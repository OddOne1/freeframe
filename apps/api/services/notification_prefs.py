"""
Notification preferences — the gate between a user's settings and what we
actually send them (CLAUDE.md §108).

The settings page has offered per-category controls and an email frequency
since it shipped, persisted into `user.preferences.notifications` via
PATCH /auth/me/preferences. Nothing on this side ever read them back: every
configured email fired regardless. Users who had turned a category off were
still receiving it, which is worse than not having the control at all —
the setting was not merely inert, it was a false statement.

Three values per category, matching the select in
settings/notifications/page.tsx exactly:

    all_on   in-app notification AND email
    in_app   in-app notification only
    all_off  neither

"All Off" suppressing the in-app row as well is the plain reading of the
label, and the only one consistent with "In-App Only" existing as its own
separate option.
"""

from __future__ import annotations

from typing import Any, Optional

# The six categories the settings page offers. Anything not in here has no
# control in the UI, so it is NOT gated — see is_known_category().
CATEGORIES = frozenset({
    "general_comments",
    "comment_replies",
    "mentions",
    "other_uploads",
    "status_updates",
    "assigned_to_you",
})

ALL_ON = "all_on"
IN_APP = "in_app"
ALL_OFF = "all_off"

# Frequencies that mean "send it now". `never` means no email at all.
#
# 15min / hourly / daily are DIGEST values and there is no digest system:
# no queue, no scheduled flush, no batching. They are treated as instant
# rather than as never, deliberately — a user who asked for a daily digest
# and silently receives nothing has the same broken-trust problem this
# module exists to fix, only in the other direction. Getting the mail
# immediately is a smaller wrong than never learning the thing happened.
# See the build report: implementing digests is its own piece of work.
_DIGEST = frozenset({"15min", "hourly", "daily"})
NEVER = "never"


def _notification_prefs(user: Any) -> dict:
    prefs = getattr(user, "preferences", None) or {}
    if not isinstance(prefs, dict):
        return {}
    section = prefs.get("notifications")
    return section if isinstance(section, dict) else {}


def is_known_category(category: Optional[str]) -> bool:
    return category in CATEGORIES


def category_setting(user: Any, category: str) -> str:
    """This user's setting for one category, defaulting to all_on.

    Defaulting to all_on is what keeps this change from silently muting
    everyone: a user who has never opened the settings page has no stored
    preferences at all, and must keep receiving exactly what they did
    before.
    """
    value = _notification_prefs(user).get(category)
    return value if value in (ALL_ON, IN_APP, ALL_OFF) else ALL_ON


def email_frequency(user: Any) -> str:
    value = _notification_prefs(user).get("email_frequency")
    return value if isinstance(value, str) and value else "instant"


def should_create_notification(user: Any, category: Optional[str]) -> bool:
    """Whether the in-app notification row should be written.

    An unknown category is not gated: types with no control in the UI
    (`due_soon`, for one) must not be silently suppressed by a setting
    that does not describe them.
    """
    if user is None or not is_known_category(category):
        return True
    return category_setting(user, category) != ALL_OFF


def should_send_email(user: Any, category: Optional[str]) -> bool:
    """Whether the email should go out, on top of the in-app row."""
    if user is None:
        return False
    if email_frequency(user) == NEVER:
        return False
    if not is_known_category(category):
        return True
    return category_setting(user, category) == ALL_ON


def is_digest_frequency(user: Any) -> bool:
    """True when the user asked for batching we do not implement yet."""
    return email_frequency(user) in _DIGEST
