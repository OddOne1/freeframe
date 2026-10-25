"""What a share-link viewer may ever learn about a person (§234 F2).

The owner's rule, which overrides anything the share routes did before:
**nobody's identity may leak through a share link.** A link holder is an
anonymous stranger as far as this instance is concerned — they hold a URL,
which says nothing about who they are or who they may know about.

So a comment's author reaches a share viewer as exactly two values:

* ``author_label`` — the author's INITIALS on a link with no password
  ("MS"), their FIRST NAME on a password-protected link once the viewer has
  passed the gate ("Mathias"). The password is the only evidence a share
  viewer ever offers that they were meant to be there, so it is what buys
  the extra word.
* ``author_color`` — a palette colour this module assigns, per link.

Nothing else: no user id, no guest id, no e-mail, no full or last name, no
avatar, no role, no "this one is yours" flag. The allowlist response model
(`schemas/comment.ShareCommentResponse`) is the other half of this: the
route cannot leak a field it has no place to put.

Upstream v1.21.0 does not have this — it answers share listings with the
same `CommentResponse` the authenticated app gets, author object, guest
e-mail and all. The scope and password fixes in `permissions.py` are ported
from it; everything in this file is ours.
"""

import hashlib
import hmac
import uuid
from typing import Iterable, Optional

from ..config import settings
from ..models.share import ShareLink

#: One fixed palette, shared by every link. Mid-tone hexes that read on both
#: the dark share page and a light one, far enough apart that two authors in
#: the same thread are told apart at a glance.
#:
#: The INDEX is chosen server-side (see `author_color`) and only the hex is
#: sent. A client that received an index into a list it also had could
#: compare two links' indices for the same author; the hex alone still
#: allows comparing colours, which is why the derivation below is keyed per
#: link rather than per author.
PALETTE: list[str] = [
    "#8b5cf6",  # violet
    "#3b82f6",  # blue
    "#10b981",  # emerald
    "#f59e0b",  # amber
    "#ec4899",  # pink
    "#06b6d4",  # cyan
    "#6366f1",  # indigo
    "#f43f5e",  # rose
]

#: What an author with no usable name gets. A share viewer never sees an
#: e-mail or an id, so there is nothing else to fall back to.
UNKNOWN_INITIALS = "?"
UNKNOWN_FIRST_NAME = "Someone"

#: How a mention of someone who is not a mentioned member of the project
#: comes back. See `rewrite_mentions`.
ANONYMOUS_MENTION = "@someone"


def initials(name: Optional[str]) -> str:
    """"Mathias Sonnleitner" -> "MS". One word gives one letter."""
    parts = [p for p in (name or "").replace("\t", " ").split(" ") if p.strip()]
    letters = [p.strip()[0].upper() for p in parts[:2]]
    return "".join(letters) or UNKNOWN_INITIALS


def first_name(name: Optional[str]) -> str:
    """The first word of a name. For a guest that is the first word of
    whatever they typed into the share page's name box."""
    parts = [p for p in (name or "").replace("\t", " ").split(" ") if p.strip()]
    return parts[0].strip() if parts else UNKNOWN_FIRST_NAME


def label_for_name(name: Optional[str], *, password_protected: bool) -> str:
    """The label rule, in one place: initials without a password, first name
    with one. Every author on every share route goes through this —
    signed-in users, guests, reply authors and mentioned members alike."""
    return first_name(name) if password_protected else initials(name)


def link_is_password_protected(link: ShareLink) -> bool:
    return bool(link.password_hash)


def _color_key() -> bytes:
    """The HMAC key. `jwt_secret` is already the instance's server-side
    secret and never leaves the process; what matters here is only that the
    client cannot compute the mapping itself, because a colour it could
    recompute would be a hash of the author's id — i.e. an identifier.
    """
    return settings.jwt_secret.encode("utf-8")


def _base_index(link_id, author_kind: str, author_id) -> int:
    """This author's preferred palette slot on this link.

    Keyed on the link, so the same author is a different colour on two
    different links and the two cannot be matched up. Derived from the
    author's INTERNAL id, which is never sent, so there is nothing in the
    response a client can hash to get here.
    """
    message = f"{link_id}:{author_kind}:{author_id}".encode("utf-8")
    digest = hmac.new(_color_key(), message, hashlib.sha256).digest()
    return int.from_bytes(digest[:8], "big") % len(PALETTE)


class ShareAuthorStyles:
    """Labels and colours for the authors in one share listing.

    Built once per response, because the collision rule needs to see the
    whole set: two authors with the same initials ("MS" and "MS") — or, on a
    password link, the same first name — MUST NOT get the same colour, or
    the page shows one chip for two people.

    Collisions are resolved in order of each author's first comment in this
    listing (the prompt's suggestion), so the answer is the same on every
    request for the same thread. Two requests for the SAME listing therefore
    agree; a listing that does not contain both of two colliding authors has
    no collision to resolve, and each of them keeps their keyed slot.
    """

    def __init__(self, link: ShareLink):
        self._link = link
        self._password = link_is_password_protected(link)
        #: author key -> (name, first-seen sort key)
        self._authors: dict[tuple[str, uuid.UUID], tuple[Optional[str], tuple]] = {}
        self._resolved: dict[tuple[str, uuid.UUID], tuple[str, str]] = {}

    # ── building ──────────────────────────────────────────────────────────

    def add(self, author_kind: str, author_id, name: Optional[str], seen_at) -> None:
        """Declare an author in this listing. `seen_at` is the created_at of
        the comment they appeared in; the earliest one wins."""
        if author_id is None:
            return
        key = (author_kind, author_id)
        # A comment with no timestamp (not a thing the DB produces, but a
        # MagicMock in a test is) sorts after every real one rather than
        # raising on the comparison.
        sort_key = (seen_at is None, seen_at, str(author_id))
        existing = self._authors.get(key)
        if existing is None:
            self._authors[key] = (name, sort_key)
        else:
            old_name, old_sort = existing
            self._authors[key] = (old_name or name, min(old_sort, sort_key))
        self._resolved = {}

    def _resolve(self) -> None:
        if self._resolved or not self._authors:
            return
        ordered = sorted(self._authors.items(), key=lambda kv: kv[1][1])
        taken: dict[str, set[int]] = {}
        for key, (name, _sort) in ordered:
            label = label_for_name(name, password_protected=self._password)
            used = taken.setdefault(label, set())
            index = _base_index(self._link.id, key[0], key[1])
            if len(used) < len(PALETTE):
                # Step forward until this label has a colour of its own. A
                # deterministic walk, not a rehash, so it cannot land back
                # on a taken slot.
                for offset in range(len(PALETTE)):
                    candidate = (index + offset) % len(PALETTE)
                    if candidate not in used:
                        index = candidate
                        break
            used.add(index)
            self._resolved[key] = (label, PALETTE[index])

    # ── reading ───────────────────────────────────────────────────────────

    def style(self, author_kind: str, author_id) -> tuple[str, str]:
        """(label, colour) for an author that was `add`ed. An author this
        listing never declared still gets an answer rather than a crash —
        the unknown label and their keyed colour."""
        self._resolve()
        key = (author_kind, author_id)
        if key in self._resolved:
            return self._resolved[key]
        fallback = UNKNOWN_FIRST_NAME if self._password else UNKNOWN_INITIALS
        if author_id is None:
            return fallback, PALETTE[0]
        return fallback, PALETTE[_base_index(self._link.id, author_kind, author_id)]

    def label_for(self, name: Optional[str]) -> str:
        """The label rule for someone who is not a comment author — a
        mentioned project member."""
        return label_for_name(name, password_protected=self._password)
