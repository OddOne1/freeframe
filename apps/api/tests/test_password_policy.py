"""The password policy, rule by rule (§200).

Every path that sets a password now goes through
`services/password_policy.validate_password`. Before it, the only rule
anywhere was a `password.length < 8` check written twice in the browser — not
a rule, a suggestion to anyone not using that browser.

Each rule is asserted through its OWN rejection, not through a generic "was
refused", because the message is what the person acts on: "add a digit" and
"this is one of the most common passwords in the world" are different
instructions, and a test that only checks for failure would pass while both
of them said the same unhelpful thing.

**The passphrase case is the one to read.** A four-word, 30-character
passphrase with no special character IS rejected here, and that is Mathias'
explicit decision (2026-09-20), not an oversight: the four class rules apply
at every length. The tests below pin it deliberately — including the fact that
the SAME passphrase passes once a special character is added, which is what
proves the rejection is the class rule and not a strength problem, and the
fact that its SPACES do not count as that special character, which is what
made the rule real rather than nominal.
"""

import pytest

from apps.api.services.password_policy import (
    MIN_PASSWORD_LENGTH,
    MIN_STRENGTH_SCORE,
    PasswordPolicyError,
    describe_policy,
    strength_hints,
    validate_password,
)


def _reason(password: str, **kwargs) -> str:
    with pytest.raises(PasswordPolicyError) as exc:
        validate_password(password, **kwargs)
    return exc.value.reason


class TestEachRuleRejectsWithItsOwnMessage:
    def test_too_short(self):
        # Eleven characters, and otherwise perfect — so length is the only
        # thing it can be failing on.
        reason = _reason("Ab3$xKm9!Qw")
        assert str(MIN_PASSWORD_LENGTH) in reason
        assert "characters" in reason

    @pytest.mark.parametrize(
        "password,missing",
        [
            ("abcdefgh3$xk", "an upper-case letter"),
            ("ABCDEFGH3$XK", "a lower-case letter"),
            ("AbcdefghJ$xk", "a digit"),
            ("Abcdefgh3Xkq", "a special character"),
        ],
    )
    def test_each_missing_class_is_named(self, password, missing):
        reason = _reason(password)
        assert missing in reason

    def test_all_four_are_named_at_once(self):
        """One round-trip per rule is how people end up at `Password1!`."""
        reason = _reason("aaaaaaaaaaaa")
        for missing in (
            "an upper-case letter",
            "a digit",
            "a special character",
        ):
            assert missing in reason

    def test_a_common_password_is_named_as_such(self):
        """The blocklist is checked FIRST, which is what makes it reachable.

        Behind the length and class rules it was dead code: only 10 of the
        10,001 entries are twelve characters or longer, and none of those has
        all four character classes, so every password that got that far had
        already been refused by an earlier rule. Checking it first also gives
        the better message — "letmein" is told what is actually wrong with it
        rather than "use at least 12 characters", which invites "letmein12345".
        """
        reason = _reason("letmein")
        assert "commonly used" in reason

    def test_the_blocklist_is_case_insensitive(self):
        """"Password" and "PASSWORD" are the same guess."""
        assert "commonly used" in _reason("Password")
        assert "commonly used" in _reason("PASSWORD")

    @pytest.mark.parametrize(
        "kwargs,token",
        [
            ({"email": "mathias@yon.studio"}, "mathias"),
            ({"backup_email": "privatbox@gmx.at"}, "privatbox"),
            ({"name": "Mathias Sonnleitner"}, "sonnleitner"),
            ({"org_name": "YON Studio"}, "studio"),
        ],
    )
    def test_personal_tokens_are_refused_and_quoted(self, kwargs, token):
        password = f"Xq7#{token}Zw2!"
        reason = _reason(password, **kwargs)
        assert token in reason
        assert "already knows it" in reason

    def test_sommer2026_scores_below_the_bar(self):
        """The case the four class rules cannot see.

        `Sommer2026!` has upper, lower, a digit and a special character, is in
        no blocklist and contains nobody's name — and it is a word plus the
        current year plus the punctuation mark everyone reaches for. Four
        classes are a floor, not evidence.

        It takes LOCALE_WORDS to see that: zxcvbn's dictionaries are English,
        so it scores `Summer2026!` at 2 on its own and `Sommer2026!` at 3,
        one point apart purely because of which language the user thinks in.
        """
        assert strength_hints("Sommer2026!")["score"] < MIN_STRENGTH_SCORE

    def test_a_long_enough_word_plus_year_is_refused_by_strength_alone(self):
        """`Sommer2026!` is 11 characters, so length catches it first.

        This is the same pattern at 13 characters, where every earlier rule
        passes and the score is the only thing left to refuse it — which is
        what proves rule 5 is carrying its own weight rather than riding on
        rule 2.
        """
        reason = _reason("Passwort2026!")
        assert "too easy to guess" in reason
        assert strength_hints("Passwort2026!")["score"] < MIN_STRENGTH_SCORE

    def test_the_boundary_is_known_and_deliberate(self):
        """Padding it to twelve characters reaches score 3 and IS accepted.

        Pinned rather than hidden. Score 3 is zxcvbn's own "safely
        unguessable" (10^8-10^10 guesses) and is what MIN_STRENGTH_SCORE
        takes; raising the bar to 4 would refuse a great many passwords
        people would actually keep. If this test ever starts failing because
        the threshold moved, that was a decision someone made — check it was
        made on purpose.
        """
        validate_password("Sommer2026!!")


class TestTheLongPassphraseRule:
    """Mathias' explicit decision, pinned so it is not "fixed" later.

    A long passphrase without a special character is refused. Anyone reading
    this and thinking the class rule should be waived above some length is
    re-opening a decision that was already made — ask before changing it.
    """

    #: 30 characters, upper, lower and a digit — everything but a special
    #: character, so the class rule is the ONLY thing it can be failing on.
    #:
    #: The trailing "7" matters: without it the phrase is missing a digit too,
    #: and the rejection would no longer be a statement about the special
    #: character specifically.
    PASSPHRASE = "Correct Battery Horse Staple 7"

    def test_it_is_long_and_strong_and_still_refused(self):
        assert len(self.PASSPHRASE) >= 24
        # Strong by score — which is exactly why the rejection has to come
        # from the class rule and nothing else.
        assert strength_hints(self.PASSPHRASE)["score"] >= MIN_STRENGTH_SCORE
        reason = _reason(self.PASSPHRASE)
        assert "a special character" in reason
        # And it says so explicitly, because a user who has just typed 30
        # characters deserves to be told this is the rule rather than
        # suspecting a bug.
        assert "including long passphrases" in reason

    def test_spaces_do_not_count_as_the_special_character(self):
        """The line the whole rule turns on.

        `not c.isalnum()` alone counts the spaces in a passphrase as special
        characters, so every spaced passphrase would satisfy the class rule
        for free and this decision would be silently unenforced. Measured,
        not assumed: the phrase above WAS accepted before the check also
        excluded whitespace.
        """
        assert " " in self.PASSPHRASE
        assert "a special character" in _reason(self.PASSPHRASE)

    def test_only_the_class_rule_stands_between_it_and_acceptance(self):
        """Add one character and the same passphrase is accepted.

        This is what makes the test above a statement about the class rule
        rather than about this particular phrase.
        """
        validate_password(self.PASSPHRASE + "!")


class TestWhatIsAccepted:
    @pytest.mark.parametrize(
        "password",
        [
            "Tf4#qRn8!vZw",
            "Correct Battery Horse Staple 7!",
            "zR9$mWq2&hLt",
        ],
    )
    def test_a_good_password_passes(self, password):
        validate_password(
            password,
            email="mathias@yon.studio",
            backup_email="privatbox@gmx.at",
            name="Mathias Sonnleitner",
            org_name="YON Studio",
        )

    def test_a_short_personal_token_does_not_block_everything(self):
        """A two-letter surname must not forbid those letters everywhere.

        Without the length floor in `personal_tokens`, a user called "Li"
        could not use a password containing "li" in any position — which
        rejects an enormous number of good passwords for no security gain.
        """
        validate_password("Vq7#kLimb3$w", name="Li")


class TestThePolicyDescribesItself:
    def test_describe_policy_matches_the_constants(self):
        """The screen states these numbers; they must be these numbers.

        `GET /auth/password-policy` serves this dict so the browser does not
        carry a second copy of the rules that can drift from the enforced
        ones.
        """
        described = describe_policy()
        assert described["min_length"] == MIN_PASSWORD_LENGTH
        assert described["min_strength_score"] == MIN_STRENGTH_SCORE
        assert all(
            described[key]
            for key in (
                "requires_upper",
                "requires_lower",
                "requires_digit",
                "requires_special",
            )
        )
