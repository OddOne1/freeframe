"""§234 F2/F4 — what a share-link viewer may ever learn about a person.

The owner's rule: nobody's identity leaks through a share link. A comment's
author reaches a share viewer as a LABEL and a COLOUR and nothing else —
initials on a link with no password, a first name on one that has a password
the viewer has already answered.

What the routes used to answer with is `CommentResponse`, which carries
`author_id`, `author_name`, `guest_author_id`, `author` (id, name,
avatar_url) and `guest_author` (id, name, **e-mail**). A share listing
therefore published every commenter's full name and every guest's e-mail
address to whoever held the link.

Two kinds of test here, and the first kind is the point:

* **the serialized JSON is searched for the fixture's own strings** — every
  e-mail, every last name, every user and guest uuid. Not "the field is
  absent", which only ever tests the fields someone thought of: the whole
  response text must not contain the string, wherever it might have come
  from (a nested reply, a mention inside a body, an echo of what was just
  posted);
* **the allowlist is pinned structurally**, so `ShareCommentResponse`
  gaining a field is a failing test rather than a quiet new leak.

See tests/share_world_234.py for the fixture and how to run this.
"""

import json
import uuid

import pytest
from unittest.mock import MagicMock, patch

from .share_world_234 import (
    auth_header,
    build_world,
    guest_fields,
    open_password_session,
    realdb,
    realredis,
    teardown_world,
    PG_URL,
)


# ── the allowlist, with no database at all ──────────────────────────────────

#: §234 F2's list, verbatim. A field not on it has no business reaching a
#: share viewer, and a field added to `CommentResponse` must not arrive here
#: by inheritance — which is why `ShareCommentResponse` is a separate model
#: rather than `CommentResponse` with things stripped off.
ALLOWED_FIELDS = {
    "id",
    "parent_id",
    "version_id",
    "timecode_start",
    "timecode_end",
    "body",
    "created_at",
    "updated_at",
    "visibility",
    "annotation",
    "author_label",
    "author_color",
    "replies",
}

#: Everything `CommentResponse` carries that must never appear here. Spelled
#: out so the failure names the field rather than a set difference.
FORBIDDEN_FIELDS = {
    "asset_id",
    "author_id",
    "author_name",
    "guest_author_id",
    "author",
    "guest_author",
    "attachments",
    "reactions",
    "resolved",
}


def test_the_share_comment_model_carries_exactly_the_allowlist():
    from apps.api.schemas.comment import ShareCommentResponse

    assert set(ShareCommentResponse.model_fields) == ALLOWED_FIELDS


def test_it_is_not_the_authenticated_model():
    """An allowlist that happened to BE `CommentResponse` would pass the
    test above the day someone made them the same class."""
    from apps.api.schemas.comment import CommentResponse, ShareCommentResponse

    assert ShareCommentResponse is not CommentResponse
    assert not issubclass(ShareCommentResponse, CommentResponse)
    leaked = FORBIDDEN_FIELDS & set(ShareCommentResponse.model_fields)
    assert not leaked, f"share response grew identity fields: {sorted(leaked)}"


def test_the_share_routes_answer_with_it():
    from apps.api.main import app
    from apps.api.schemas.comment import ShareCommentResponse

    models = {
        (r.path, tuple(sorted(r.methods))): r.response_model
        for r in app.routes
        if getattr(r, "path", "").startswith("/share/{token}/comment")
    }
    assert models[("/share/{token}/comments", ("GET",))] == list[ShareCommentResponse]
    assert models[("/share/{token}/comment", ("POST",))] is ShareCommentResponse


def _colliding_author_ids(link_id):
    """Two author ids whose KEYED palette slot on this link is the same.

    Searched for rather than assumed: the whole point of the collision rule
    is what happens when the keyed slots agree, and with eight colours two
    random ids agree only one time in eight — so a test that used two
    arbitrary ids would pass without exercising the rule at all. (That is
    not hypothetical: the end-to-end colour test below passes with the
    resolution removed, because the fixture's two authors happen to land on
    different slots.)
    """
    from apps.api.services.share_identity import _base_index

    first = uuid.uuid4()
    target = _base_index(link_id, "user", first)
    while True:
        second = uuid.uuid4()
        if second != first and _base_index(link_id, "user", second) == target:
            return first, second


def _styles_for(password_hash=None):
    from types import SimpleNamespace

    from apps.api.services.share_identity import ShareAuthorStyles

    link = SimpleNamespace(id=uuid.uuid4(), password_hash=password_hash)
    return link, ShareAuthorStyles(link)


def test_two_authors_whose_keyed_slot_collides_are_pulled_apart():
    """§234 F2 — same initials MUST NOT mean the same chip colour."""
    from datetime import datetime, timezone

    link, styles = _styles_for()
    first, second = _colliding_author_ids(link.id)
    styles.add("user", first, "Mathias Sonnleitner", datetime(2026, 1, 1, tzinfo=timezone.utc))
    styles.add("user", second, "Marta Steiner", datetime(2026, 1, 2, tzinfo=timezone.utc))

    label_a, colour_a = styles.style("user", first)
    label_b, colour_b = styles.style("user", second)
    assert label_a == label_b == "MS"
    assert colour_a != colour_b


def test_the_same_first_name_on_a_password_link_is_pulled_apart_too():
    from datetime import datetime, timezone

    link, styles = _styles_for(password_hash="$2b$12$whatever")
    first, second = _colliding_author_ids(link.id)
    styles.add("user", first, "Marta Steiner", datetime(2026, 1, 1, tzinfo=timezone.utc))
    styles.add("user", second, "Marta Sonnleitner", datetime(2026, 1, 2, tzinfo=timezone.utc))

    label_a, colour_a = styles.style("user", first)
    label_b, colour_b = styles.style("user", second)
    assert label_a == label_b == "Marta"
    assert colour_a != colour_b


def test_the_earlier_author_keeps_their_keyed_slot():
    """Collisions are resolved in order of first comment, so the answer does
    not depend on which of the two the walk happens to reach first."""
    from datetime import datetime, timezone

    from apps.api.services.share_identity import PALETTE, _base_index

    link, styles = _styles_for()
    first, second = _colliding_author_ids(link.id)
    slot = _base_index(link.id, "user", first)
    styles.add("user", first, "Mathias Sonnleitner", datetime(2026, 1, 1, tzinfo=timezone.utc))
    styles.add("user", second, "Marta Steiner", datetime(2026, 1, 2, tzinfo=timezone.utc))
    assert styles.style("user", first)[1] == PALETTE[slot]

    # The same two, declared in the other order: the EARLIER comment still
    # keeps the slot.
    _link2, other = _styles_for()
    other._link = link  # same link, so the keyed slots are the same two
    other.add("user", second, "Marta Steiner", datetime(2026, 1, 2, tzinfo=timezone.utc))
    other.add("user", first, "Mathias Sonnleitner", datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert other.style("user", first)[1] == PALETTE[slot]


def test_a_different_label_may_reuse_a_colour():
    """The rule is about telling two people with the SAME label apart. Two
    different labels sharing a colour is not a collision — eight colours
    would otherwise cap a thread at eight commenters."""
    from datetime import datetime, timezone

    link, styles = _styles_for()
    first, second = _colliding_author_ids(link.id)
    styles.add("user", first, "Ada Lovelace", datetime(2026, 1, 1, tzinfo=timezone.utc))
    styles.add("user", second, "Grace Hopper", datetime(2026, 1, 2, tzinfo=timezone.utc))
    assert styles.style("user", first)[0] == "AL"
    assert styles.style("user", second)[0] == "GH"
    assert styles.style("user", first)[1] == styles.style("user", second)[1]


def test_the_label_rule_in_isolation():
    from apps.api.services.share_identity import label_for_name

    assert label_for_name("Mathias Sonnleitner", password_protected=False) == "MS"
    assert label_for_name("Mathias Sonnleitner", password_protected=True) == "Mathias"
    # One word, and a middle name.
    assert label_for_name("Cher", password_protected=False) == "C"
    assert label_for_name("Ada B Lovelace", password_protected=False) == "AB"
    # Nothing usable: still never an id or an address.
    assert label_for_name(None, password_protected=False) == "?"
    assert label_for_name("  ", password_protected=True) == "Someone"


# ── everything below needs the real schema ──────────────────────────────────

pytestmark = realdb


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def world(sessionmaker_):
    session = sessionmaker_()
    bag = build_world(session)
    try:
        yield bag
    finally:
        teardown_world(bag)


@pytest.fixture
def client(world):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=MagicMock()
    ), patch(
        "apps.api.middleware.rate_limit.check_rate_limit", return_value=(True, 0)
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def secrets_of(world) -> list[str]:
    """Every string in this world that identifies a person.

    E-mails, last names, and the uuids of every user and guest. The user
    uuids matter as much as the names: an id is an identifier even when it
    carries no letters, and `author_id` is exactly what used to be sent.
    """
    people = [world["owner"], world["member"], world["outsider"]]
    out = [p.email for p in people]
    out += [p.last_name for p in people if p.last_name]
    out += [str(p.id) for p in people]
    out += [world["guest"].email, str(world["guest"].id)]
    # The guest's surname, from the name they typed ("Dana Doe").
    out.append("Doe")
    return out


def assert_no_identity(text: str, world, *, allow=()):
    """`text` is the raw response body. Searched as TEXT, deliberately."""
    lowered = text.lower()
    for secret in secrets_of(world):
        if secret in allow:
            continue
        assert secret.lower() not in lowered, f"{secret!r} reached a share viewer"


def flatten(payload):
    out = []
    stack = list(payload)
    while stack:
        c = stack.pop()
        out.append(c)
        stack.extend(c.get("replies") or [])
    return out


# ── F4's matrix: nothing identifying, in any combination ────────────────────


@realredis
class TestNoIdentityReachesAShareViewer:
    """{password, no password} x {guest author, signed-in author, reply,
    mention, internal on/off}. Each case asserts on the whole response text.
    """

    def _listing(self, client, world, link_key):
        link = world[link_key]
        params = {}
        if link.password_hash:
            params["share_session"] = open_password_session(link.token)
        resp = client.get(f"/share/{link.token}/comments", params=params)
        assert resp.status_code == 200, resp.text
        return resp

    @pytest.mark.parametrize(
        "link_key", ["link_asset", "link_pw", "link_internal_on"]
    )
    def test_the_listing_as_it_stands(self, client, world, link_key):
        resp = self._listing(client, world, link_key)
        assert_no_identity(resp.text, world)
        # And it did return something, so the assertion above is not vacuous.
        assert resp.json()

    @pytest.mark.parametrize("link_key", ["link_asset", "link_pw"])
    def test_a_guest_s_own_comment_comes_back_without_their_e_mail(
        self, client, world, link_key
    ):
        """The echo is the easiest leak to miss: the guest just typed the
        address, so a response repeating it looks harmless."""
        link = world[link_key]
        query = ""
        if link.password_hash:
            query = f"?share_session={open_password_session(link.token)}"
        fields = guest_fields("echo")
        resp = client.post(
            f"/share/{link.token}/comment{query}",
            json={"body": "my own note", **fields},
        )
        assert resp.status_code == 201, resp.text
        assert fields["guest_email"].lower() not in resp.text.lower()
        assert "Visitor" not in resp.text  # their surname
        assert_no_identity(resp.text, world)

    @pytest.mark.parametrize("link_key", ["link_asset", "link_pw"])
    def test_a_signed_in_author_is_a_label_too(self, client, world, link_key):
        link = world[link_key]
        query = ""
        if link.password_hash:
            query = f"?share_session={open_password_session(link.token)}"
        resp = client.post(
            f"/share/{link.token}/comment{query}",
            json={"body": "from a member"},
            headers=auth_header(world["member"]),
        )
        assert resp.status_code == 201, resp.text
        assert_no_identity(resp.text, world)
        body = resp.json()
        expected = "Marta" if link.password_hash else "MS"
        assert body["author_label"] == expected

    def test_a_reply_s_author_is_a_label_too(self, client, world):
        """Replies are built by the same recursion and were the likeliest
        place for `_build_comment_response` to survive."""
        resp = self._listing(client, world, "link_asset")
        replies = [c for c in flatten(resp.json()) if c["parent_id"]]
        assert replies
        for reply in replies:
            assert reply["author_label"]
            assert reply["author_color"].startswith("#")
            assert set(reply) == ALLOWED_FIELDS

    def test_a_mention_in_a_body_is_a_label_not_an_address(self, client, world):
        resp = client.post(
            f"/share/{world['link_asset'].token}/comment",
            json={
                "body": f"@{world['member'].email} and @{world['outsider'].email}",
                **guest_fields("mentioner"),
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()["body"]
        # The member, who really was mentioned: their label.
        assert "@MS" in body
        # The non-member, who was silently ignored: not even that.
        assert "@someone" in body
        assert_no_identity(resp.text, world)

        # And the same through the listing, not only the echo.
        listed = self._listing(client, world, "link_asset")
        assert_no_identity(listed.text, world)
        assert world["member"].email.lower() not in listed.text.lower()

    def test_a_mention_on_a_password_link_uses_the_first_name(self, client, world):
        token = world["link_pw"].token
        session_id = open_password_session(token)
        resp = client.post(
            f"/share/{token}/comment?share_session={session_id}",
            json={
                "body": f"@{world['member'].email} please look",
                **guest_fields("mentioner2"),
            },
        )
        assert resp.status_code == 201, resp.text
        assert "@Marta" in resp.json()["body"]
        assert world["member"].email.lower() not in resp.text.lower()

    def test_internal_comments_carry_no_identity_either(self, client, world):
        resp = self._listing(client, world, "link_internal_on")
        text = resp.text
        assert "the internal note" in text
        assert_no_identity(text, world)
        for comment in flatten(resp.json()):
            assert set(comment) == ALLOWED_FIELDS

    def test_every_comment_in_every_listing_has_exactly_the_allowed_keys(
        self, client, world
    ):
        for link_key in ("link_asset", "link_pw", "link_internal_on"):
            resp = self._listing(client, world, link_key)
            for comment in flatten(resp.json()):
                assert set(comment) == ALLOWED_FIELDS, (link_key, sorted(comment))


@realredis
class TestTheLinkCreatorSeesWhatAGuestSees:
    def test_a_signed_in_creator_gets_the_share_shape(self, client, world):
        """"Preview my link" must not quietly become the authenticated
        view — the point of a preview is to see what the recipient sees."""
        resp = client.get(
            f"/share/{world['link_asset'].token}/comments",
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 200, resp.text
        for comment in flatten(resp.json()):
            assert set(comment) == ALLOWED_FIELDS
        assert_no_identity(resp.text, world)


# ── F4: the colour rule ─────────────────────────────────────────────────────


class TestColours:
    def _labels(self, client, world, link, params=None):
        resp = client.get(f"/share/{link.token}/comments", params=params or {})
        assert resp.status_code == 200, resp.text
        return {
            (c["author_label"], c["author_color"]) for c in flatten(resp.json())
        }

    def test_two_authors_with_the_same_initials_get_different_colours(
        self, client, world
    ):
        """"Mathias Sonnleitner" and "Marta Steiner" are both "MS"; one chip
        colour for two people is the bug this rule exists for."""
        # Both authors in one thread: the fixture's internal reply is
        # Marta's, so the link that shows internal comments has both.
        pairs = self._labels(client, world, world["link_internal_on"])
        ms = {colour for label, colour in pairs if label == "MS"}
        assert len(ms) == 2, pairs

    def test_the_colours_are_the_same_on_a_second_request(self, client, world):
        first = self._labels(client, world, world["link_internal_on"])
        second = self._labels(client, world, world["link_internal_on"])
        assert first == second

    def test_one_author_gets_a_different_colour_on_a_different_link(
        self, client, world
    ):
        """Keyed on the link, so two links cannot be correlated by colour.

        The second link's id is CHOSEN (one that lands on another palette
        slot for this author) rather than left to uuid4 — with eight colours
        a random one collides one time in eight, and a test that fails one
        run in eight teaches people to re-run it.
        """
        from apps.api.models.share import ShareLink, SharePermission
        from apps.api.services.share_identity import _base_index

        session, owner = world["session"], world["owner"]
        here = _base_index(world["link_asset"].id, "user", owner.id)
        candidate = uuid.uuid4()
        while _base_index(candidate, "user", owner.id) == here:
            candidate = uuid.uuid4()

        other = ShareLink(
            id=candidate,
            token=uuid.uuid4().hex,
            asset_id=world["asset_single"].id,
            created_by=owner.id,
            permission=SharePermission.comment,
            show_comments=True,
        )
        session.add(other)
        session.commit()

        mine = {c for l, c in self._labels(client, world, world["link_asset"]) if l == "MS"}
        theirs = {c for l, c in self._labels(client, world, other) if l == "MS"}
        assert mine and theirs
        assert mine != theirs

    def test_the_colour_is_a_palette_hex_and_nothing_else(self, client, world):
        from apps.api.services.share_identity import PALETTE

        pairs = self._labels(client, world, world["link_internal_on"])
        for _label, colour in pairs:
            assert colour in PALETTE

    def test_the_server_key_is_load_bearing(self, client, world):
        """The colour is an HMAC over the author's internal id under the
        instance's own secret — not a plain hash of anything the client
        holds. Rotating the key moves the answer, which is what says the key
        is in the derivation at all; a client cannot recompute a mapping it
        has no key for, and so cannot match one author across two links.
        """
        from apps.api.config import settings
        from apps.api.services.share_identity import PALETTE, _base_index

        link, owner = world["link_asset"], world["owner"]
        original = settings.jwt_secret
        seen = set()
        try:
            for suffix in ("", "-rotated", "-again", "-more", "-still"):
                settings.jwt_secret = original + suffix
                seen.add(_base_index(link.id, "user", owner.id))
        finally:
            settings.jwt_secret = original
        # Five different keys landing on one slot out of eight would mean the
        # key is not reaching the hash.
        assert len(seen) > 1, seen
        assert _base_index(link.id, "user", owner.id) < len(PALETTE)


# ── the uploader in a folder listing (F2, outside comments) ─────────────────


@realredis
class TestTheFolderListingUploader:
    def test_it_is_a_label_not_a_name(self, client, world):
        resp = client.get(
            f"/share/{world['link_folder'].token}/assets",
            params={"folder_id": str(world["folder_a1"].id)},
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["assets"]
        assert items
        assert all(i["uploader_label"] == "MS" for i in items), items
        assert "created_by_name" not in items[0]
        assert_no_identity(resp.text, world)

    def test_a_password_link_gets_the_first_name(self, client, world):
        token = world["link_pw_folder"].token
        session_id = open_password_session(token)
        resp = client.get(
            f"/share/{token}/assets",
            params={
                "folder_id": str(world["folder_a1"].id),
                "share_session": session_id,
            },
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["assets"]
        assert all(i["uploader_label"] == "Mathias" for i in items), items
        assert_no_identity(resp.text, world)

    def test_the_comment_count_does_not_count_the_internal_thread(
        self, client, world
    ):
        """A count that includes internal comments is itself a statement
        that an internal thread exists (§234 F1)."""
        from apps.api.models.comment import Comment

        session = world["session"]
        asset = world["asset_in_a1"]
        session.add(Comment(
            asset_id=asset.id,
            version_id=world["versions"][asset.id].id,
            author_id=world["owner"].id,
            body="team only",
            visibility="internal",
        ))
        session.commit()

        resp = client.get(
            f"/share/{world['link_folder'].token}/assets",
            params={"folder_id": str(world["folder_a1"].id)},
        )
        item = [a for a in resp.json()["assets"] if a["id"] == str(asset.id)][0]
        assert item["comment_count"] == 1
