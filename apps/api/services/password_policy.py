"""One password policy, used by every path that sets a password (§200).

Before this there was no policy at all on the server: `/auth/set-password`,
`/auth/accept-invite`, `/auth/register` and the fresh-install setup route each
took whatever string arrived and hashed it. The only rule anywhere was a
`password.length < 8` check in the browser, in two separate components — which
is not a rule, it is a suggestion to anyone not using that browser.

So this module is deliberately the ONLY place the rules live, and every one of
those call sites now goes through `validate_password`. A second copy of "what
counts as an acceptable password" is the shape this codebase keeps getting
bitten by (§190 found one byte-formatting rule written four times, each wrong
the same way), and here the cost of drift is not a mislabelled megabyte.

The rules, in the order they are checked — the order IS the design, because the
first failure is the message the user reads, and it should be the most concrete
thing that is wrong:

  1. not in the committed list of the most common passwords in the world
  2. at least 12 characters
  3. at least one upper case, one lower case, one digit, one special character
  4. does not contain the local part of either address, the person's name, or
     this instance's name
  5. a zxcvbn strength score of at least MIN_STRENGTH_SCORE

Rule 1 is first because behind the length and class rules it is unreachable —
see `validate_password` for the count that established that.

**Rules 3 and 5 are both required on purpose, and they disagree by design.**

A four-word passphrase of 24 characters — the kind of thing a strength meter
loves, and rightly — is REJECTED here if it has no special character, because
rule 3 applies at every length with no exemption. That is Mathias' explicit
decision (2026-09-20), made knowing it costs some genuinely strong passwords.
It is not an oversight to be tidied up later: anyone reading this and thinking
"a long passphrase should skip the class rule" is re-opening a decision that
was already made, and should ask before changing it.

The score exists for the opposite failure, the one the class rule cannot see:
`Sommer2026!` satisfies all four classes, is in no blocklist, contains nobody's
name, and is a word plus the current year plus the punctuation mark everyone
reaches for. It scores 2 of 4 here (see LOCALE_WORDS for why it takes a
deliberate nudge to score it the way `Summer2026!` already scored). Four
classes are a floor, not evidence.

**The boundary is real and worth knowing.** `Sommer2026!!` — the same password
padded to twelve characters with a second `!` — reaches score 3 and IS
accepted. Score 3 is zxcvbn's own "safely unguessable" (10^8-10^10 guesses)
and is what this policy takes; raising the bar to 4 would refuse a great many
passwords people would actually keep, and the twelve-character minimum plus
the four classes is the floor underneath it.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

from zxcvbn import zxcvbn

#: Twelve, not eight. Eight was the browser-side number and it was never
#: enforced anywhere that mattered.
MIN_PASSWORD_LENGTH = 12

#: zxcvbn scores 0-4. 3 is "safely unguessable" in its own terms — 10^8 to
#: 10^10 guesses — and is the level at which `Sommer2026!` (score 1) and
#: `Summer2026!` (score 1) fail while something genuinely unpredictable of
#: the same length passes.
MIN_STRENGTH_SCORE = 3

#: The frequency-ordered blocklist, committed as a data file. See its own
#: header for provenance. A path constant rather than an inline read so a
#: test can point at a small fixture without monkeypatching the loader.
COMMON_PASSWORDS_PATH = Path(__file__).resolve().parent.parent / "data" / "common_passwords.txt"

#: Words zxcvbn does not know, on an instance whose users do not think in
#: English (§200).
#:
#: This is a measured fix, not a guess. zxcvbn ships English frequency
#: dictionaries, so it scores `Summer2026!` at 2 — correctly recognising
#: word-plus-year — and `Sommer2026!` at 3, because the German word is not in
#: any list it holds. Same password, same pattern, same user; one point apart
#: purely because of which language they happen to think in. Feeding these
#: through `user_inputs` puts them in front of the same matcher that already
#: catches the English half, and `Sommer2026!` drops to 2 where it belongs.
#:
#: Deliberately SHORT, and deliberately not a German word list. A large
#: dictionary here would slow every keystroke on the client's twin and would
#: start refusing ordinary passphrase words; what is wanted is the handful of
#: words a person actually reaches for when a form demands a password —
#: seasons, months, and the words that mean "password". The instance's own
#: name is added per-call from site settings, not here.
#:
#: Not a blocklist: these are not forbidden substrings. They lower the SCORE
#: when a password is mostly made of them, which is the honest thing to do
#: about a word that is common rather than secret.
LOCALE_WORDS = (
    "sommer", "winter", "herbst", "fruehling", "frühling",
    "jaenner", "jänner", "januar", "februar", "maerz", "märz", "april",
    "mai", "juni", "juli", "august", "september", "oktober", "november",
    "dezember",
    "passwort", "kennwort", "geheim", "willkommen", "servus", "schatz",
    "liebe", "sonne", "hallo", "danke",
    "wien", "oesterreich", "österreich", "austria",
    "freeframe",
)

#: Only tokens of at least this length are treated as "contained in the
#: password" for rule 4. Without a floor, a user whose last name is "Li" or
#: whose instance is called "AB" could not use a password containing those
#: two letters in sequence anywhere — which rejects an enormous number of
#: perfectly good passwords for no security gain.
MIN_CONTAINED_TOKEN_LENGTH = 3


class PasswordPolicyError(ValueError):
    """A password was refused, with the reason to show the person.

    Carries a plain sentence rather than a code: there is exactly one
    consumer (an HTTP 400 whose detail the browser renders verbatim), and a
    code would mean the same sentences written again in TypeScript, where
    they would drift from these.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@lru_cache(maxsize=1)
def _common_passwords() -> frozenset[str]:
    """The blocklist, lowercased, read once per process.

    Cached because this is on the path of every password set, and a 76KB
    file re-read per call is pure waste. `lru_cache` rather than a module
    global so a test can call `.cache_clear()` after pointing the path
    somewhere else.

    A missing file is NOT silently tolerated. The alternative — return an
    empty set and carry on — is a policy that quietly stops enforcing one of
    its five rules because of a packaging mistake, and nothing would ever
    report it. The Dockerfile copies `apps/api` wholesale, so the file
    travels with the code; if it ever does not, this fails loudly at the
    first password set rather than at the first breach.
    """
    with COMMON_PASSWORDS_PATH.open(encoding="utf-8") as fh:
        return frozenset(
            line.strip().lower()
            for line in fh
            if line.strip() and not line.startswith("#")
        )


def _local_part(address: Optional[str]) -> Optional[str]:
    if not address or "@" not in address:
        return None
    local = address.split("@", 1)[0].strip().lower()
    return local or None


def _name_tokens(name: Optional[str]) -> list[str]:
    """Word-ish pieces of a name, long enough to be worth checking.

    Split on anything non-alphanumeric so "Mary-Jane" and "O'Brien" yield
    their parts, which is what somebody building a password out of their own
    name would actually use.
    """
    if not name:
        return []
    return [
        part.lower()
        for part in re.split(r"[^0-9A-Za-z]+", name)
        if len(part) >= MIN_CONTAINED_TOKEN_LENGTH
    ]


def personal_tokens(
    *,
    email: Optional[str] = None,
    backup_email: Optional[str] = None,
    name: Optional[str] = None,
    org_name: Optional[str] = None,
) -> list[str]:
    """Everything about this person the password must not contain.

    Shared with `strength_hints` below so the advisory score is computed
    against the same inputs the rejection is, rather than a shorter list
    that would make the meter more optimistic than the server.
    """
    tokens: list[str] = []
    for address in (email, backup_email):
        local = _local_part(address)
        if local and len(local) >= MIN_CONTAINED_TOKEN_LENGTH:
            tokens.append(local)
    tokens.extend(_name_tokens(name))
    tokens.extend(_name_tokens(org_name))
    # Deduplicated, order preserved: the first match is the one reported, and
    # reporting "your email address" twice helps nobody.
    seen: set[str] = set()
    unique: list[str] = []
    for token in tokens:
        if token not in seen:
            seen.add(token)
            unique.append(token)
    return unique


def _strength_reason(result: dict) -> str:
    """zxcvbn's own explanation, turned into one sentence.

    Its `warning` is the concrete finding ("This is a top-100 common
    password", "Names and surnames by themselves are easy to guess") and is
    what makes the rejection actionable; the first suggestion is the fallback
    when there is no warning, which happens for passwords that are merely
    short on entropy rather than recognisably patterned.
    """
    feedback = result.get("feedback") or {}
    warning = (feedback.get("warning") or "").strip()
    if warning:
        return warning.rstrip(".")
    suggestions = feedback.get("suggestions") or []
    if suggestions:
        return str(suggestions[0]).rstrip(".")
    return "It is too easy to guess"


def strength_hints(
    password: str,
    *,
    email: Optional[str] = None,
    backup_email: Optional[str] = None,
    name: Optional[str] = None,
    org_name: Optional[str] = None,
) -> dict:
    """Score and reason, without deciding anything.

    Exists so a caller can report the score alongside a rejection, and so the
    score is computed in exactly one way. The browser runs its own copy of
    zxcvbn for the live meter (`lib/password-policy.ts`) — a different
    implementation of the same algorithm, so the two can differ by a point at
    the boundary. That is tolerable precisely because the meter is advisory
    and this module decides.
    """
    result = zxcvbn(
        # zxcvbn is O(n^2)-ish in the length of the input and a pasted blob
        # should not be able to stall a worker. 128 is far past anything the
        # rules below can distinguish anyway.
        password[:128],
        user_inputs=list(LOCALE_WORDS)
        + personal_tokens(
            email=email, backup_email=backup_email, name=name, org_name=org_name
        ),
    )
    return {"score": int(result.get("score", 0)), "reason": _strength_reason(result)}


def validate_password(
    password: str,
    *,
    email: Optional[str] = None,
    backup_email: Optional[str] = None,
    name: Optional[str] = None,
    org_name: Optional[str] = None,
) -> None:
    """Accept the password, or raise PasswordPolicyError with the reason.

    Every argument but `password` is optional and every caller should pass
    what it has. They are not decoration: rule 4 is the only one that can
    catch `mathias2026!YonStudio` on Mathias' own instance, and it can only
    do that if it is told who is typing and where.

    No rotation, no expiry, deliberately — both push people towards
    `Sommer2026!` and then `Herbst2026!`, which is the exact failure rule 5
    exists to catch.
    """
    # The blocklist goes FIRST, ahead of length and the character classes,
    # and that ordering was corrected after measuring rather than assumed.
    #
    # Behind them it is dead code: exactly 10 of the 10,001 entries are twelve
    # characters or longer and not one of those has all four character
    # classes, so a password that reached this check had already been refused
    # by an earlier rule every single time. A rule that can never fire is not
    # a rule.
    #
    # It is also the better message. Somebody who typed `password` is told
    # what is actually wrong with it — it is one of the most guessed strings
    # in the world — rather than "use at least 12 characters", which invites
    # `password1234`.
    if password.lower() in _common_passwords():
        raise PasswordPolicyError(
            "This is one of the most commonly used passwords in the world. "
            "Choose something else."
        )

    # Then length: of the remaining rules it is the one a person is most
    # likely to be failing, and "too short" is more useful than "no digit"
    # about a four-character password that is also too short.
    if len(password) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"Use at least {MIN_PASSWORD_LENGTH} characters."
        )

    missing: list[str] = []
    if not any(c.isupper() for c in password):
        missing.append("an upper-case letter")
    if not any(c.islower() for c in password):
        missing.append("a lower-case letter")
    if not any(c.isdigit() for c in password):
        missing.append("a digit")
    # "Special" is the complement of alphanumeric rather than a fixed
    # punctuation set, so a non-Latin script or a typographic character
    # counts. A fixed set would reject a password that is objectively harder
    # to guess than one containing `!`.
    #
    # WHITESPACE IS EXCLUDED, and that is the whole reason the passphrase rule
    # bites. `not c.isalnum()` alone counts the spaces in "Correct Battery
    # Horse Staple 7" as special characters, so every spaced passphrase would
    # satisfy this rule for free — and the decision this policy exists to
    # implement is precisely that a passphrase does NOT get an exemption.
    # Found by measurement: that passphrase was accepted before this line said
    # `and not c.isspace()`.
    if not any(not c.isalnum() and not c.isspace() for c in password):
        missing.append("a special character")
    if missing:
        # Stated in full, not one at a time: a user fixing four rules one
        # round-trip each is how people end up at `Password1!`.
        raise PasswordPolicyError(
            "Add " + ", ".join(missing) + ". All four are required at every "
            "length, including long passphrases."
        )

    lowered = password.lower()
    for token in personal_tokens(
        email=email, backup_email=backup_email, name=name, org_name=org_name
    ):
        if token in lowered:
            raise PasswordPolicyError(
                f"Your password must not contain “{token}” — anyone "
                "targeting you already knows it."
            )

    hints = strength_hints(
        password,
        email=email,
        backup_email=backup_email,
        name=name,
        org_name=org_name,
    )
    if hints["score"] < MIN_STRENGTH_SCORE:
        raise PasswordPolicyError(
            f"This password is too easy to guess. {hints['reason']}."
        )


def describe_policy() -> dict:
    """The rules as data, for a client that wants to state them up front.

    Kept here rather than written out again in the browser so the screen and
    the server cannot disagree about what is required.
    """
    return {
        "min_length": MIN_PASSWORD_LENGTH,
        "min_strength_score": MIN_STRENGTH_SCORE,
        "requires_upper": True,
        "requires_lower": True,
        "requires_digit": True,
        "requires_special": True,
    }


def validate_password_for_user(password: str, user, org_name: Optional[str] = None) -> None:
    """`validate_password` with the arguments pulled off a User row.

    A convenience with a real purpose: four routers set passwords, and three
    of them would otherwise each assemble this argument list by hand. One that
    forgets `backup_email` is a rule that silently stops applying.
    """
    validate_password(
        password,
        email=getattr(user, "email", None),
        backup_email=getattr(user, "backup_email", None),
        name=getattr(user, "name", None),
        org_name=org_name,
    )
