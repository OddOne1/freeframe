"""
Notification preferences actually gate what is sent (CLAUDE.md §108).

The settings page has offered per-category controls and an email frequency
since it shipped; nothing on the API side ever read them back, so every
configured email fired regardless of what the user chose. The tests below are
mostly about what does NOT happen, and about the one case that matters more
than any of them: a user who has never touched the settings page must keep
receiving exactly what they did before.
"""
import pytest

from apps.api.services.notification_prefs import (
    category_setting,
    email_frequency,
    is_digest_frequency,
    is_known_category,
    should_create_notification,
    should_send_email,
    CATEGORIES,
)


class FakeUser:
    def __init__(self, preferences=None):
        self.preferences = preferences


def user_with(category=None, value=None, frequency=None):
    notifications = {}
    if category:
        notifications[category] = value
    if frequency:
        notifications["email_frequency"] = frequency
    return FakeUser({"notifications": notifications})


class TestDefaults:
    def test_untouched_user_gets_everything(self):
        # THE regression this change could cause, and the worst one: a user
        # who never opened the settings page has no stored preferences at
        # all, and must not be silently muted by the gate being added.
        for blank in (FakeUser(None), FakeUser({}), FakeUser({"notifications": {}})):
            for cat in CATEGORIES:
                assert should_create_notification(blank, cat) is True
                assert should_send_email(blank, cat) is True

    def test_garbage_preferences_do_not_mute(self):
        # preferences is free-form JSON; a non-dict must not read as "off".
        for junk in (FakeUser("nope"), FakeUser({"notifications": "nope"}),
                     FakeUser({"notifications": {"mentions": "banana"}})):
            assert should_create_notification(junk, "mentions") is True
            assert should_send_email(junk, "mentions") is True

    def test_unknown_setting_value_falls_back_to_all_on(self):
        assert category_setting(user_with("mentions", "sometimes"), "mentions") == "all_on"


class TestThreeStates:
    def test_all_on_sends_both(self):
        u = user_with("mentions", "all_on")
        assert should_create_notification(u, "mentions") is True
        assert should_send_email(u, "mentions") is True

    def test_in_app_keeps_the_bell_and_drops_the_email(self):
        # The whole point of the middle option.
        u = user_with("mentions", "in_app")
        assert should_create_notification(u, "mentions") is True
        assert should_send_email(u, "mentions") is False

    def test_all_off_drops_both(self):
        # "All Off" suppressing the in-app row too is the plain reading of
        # the label, and the only one that leaves "In-App Only" a distinct
        # option rather than a synonym.
        u = user_with("mentions", "all_off")
        assert should_create_notification(u, "mentions") is False
        assert should_send_email(u, "mentions") is False

    def test_categories_are_independent(self):
        u = FakeUser({"notifications": {"mentions": "all_off", "status_updates": "all_on"}})
        assert should_create_notification(u, "mentions") is False
        assert should_send_email(u, "status_updates") is True


class TestEmailFrequency:
    def test_never_suppresses_every_email_but_keeps_the_bell(self):
        u = user_with("mentions", "all_on", frequency="never")
        assert should_send_email(u, "mentions") is False
        assert should_create_notification(u, "mentions") is True

    @pytest.mark.parametrize("freq", ["15min", "hourly", "daily"])
    def test_digest_values_still_send_rather_than_vanish(self, freq):
        # There is no digest system. Treating these as "never" would give the
        # user silence while they wait for a daily summary that is never
        # built — the same broken promise this module exists to fix, pointing
        # the other way. Flagged as unimplemented instead.
        u = user_with("mentions", "all_on", frequency=freq)
        assert should_send_email(u, "mentions") is True
        assert is_digest_frequency(u) is True

    def test_instant_is_not_a_digest(self):
        assert is_digest_frequency(user_with(frequency="instant")) is False
        assert email_frequency(FakeUser({})) == "instant"

    def test_frequency_never_does_not_override_an_off_category(self):
        u = user_with("mentions", "all_off", frequency="instant")
        assert should_send_email(u, "mentions") is False


class TestUnknownCategories:
    def test_a_type_with_no_control_is_not_gated(self):
        # `due_soon` reminders have no switch in the settings page. Gating
        # them on a category that does not describe them would suppress
        # notifications by a setting the user never made.
        u = user_with("mentions", "all_off")
        assert should_create_notification(u, "due_soon") is True
        assert should_create_notification(u, None) is True
        assert is_known_category("due_soon") is False

    def test_the_six_ui_categories_are_the_known_set(self):
        # Pinned against the settings page: adding a seventh control there
        # without adding it here would leave it silently inert, which is the
        # exact bug being fixed.
        assert CATEGORIES == {
            "general_comments", "comment_replies", "mentions",
            "other_uploads", "status_updates", "assigned_to_you",
        }

    def test_no_user_never_emails(self):
        # A recipient row that could not be loaded is not a licence to mail
        # an address we do not have.
        assert should_send_email(None, "mentions") is False
        assert should_create_notification(None, "mentions") is True
