"""§234b — a comment marked internal is NEVER shown on a share link.

§234 F1 made it an option: `share_links.show_internal_comments`, a toggle in
the create dialog and in a link's settings, and a filter that read the
column. The owner removed the option. "Internal" means the team's own
notes, invisible to anyone holding a link, password or not — there is
nothing to configure.

Three things are asserted here, and the first is the one that matters:

* **the column is dead.** It is still in the database (applied on
  production; dropping it is a later migration), and a row where it is TRUE
  must behave exactly like a row where it is FALSE. Forced TRUE with raw
  SQL, not through the model, so the assertion holds whatever an ORM
  default does;
* **the field is gone from the schemas**, create, update and response, and
  from `ShareCommentResponse` — where `visibility` would only ever have
  said "public" once internal comments cannot be in the list;
* **an older client that still sends the key is not an error.** A browser
  tab left open across the deploy keeps POSTing
  `show_internal_comments: true`; Pydantic's default `model_config` ignores
  an unknown field rather than refusing the request, and the key has no
  effect anywhere.

Posting an internal comment through a share route is still refused (403) for
anyone without real access to the asset — §234's rule, unchanged, and
asserted in test_share_comment_scope.py.

See tests/share_world_234.py for the fixture and how to run this.
"""

import uuid

import pytest
from unittest.mock import MagicMock, patch

from sqlalchemy import text as sql_text

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


# ── the schemas, with no database at all ────────────────────────────────────


def test_the_create_schemas_have_no_such_field():
    from apps.api.schemas.share import (
        MultiShareCreate,
        ShareLinkCreate,
        ShareLinkListItem,
        ShareLinkResponse,
        ShareLinkUpdate,
        ShareLinkValidateResponse,
    )

    for schema in (
        ShareLinkCreate,
        MultiShareCreate,
        ShareLinkResponse,
        ShareLinkUpdate,
        ShareLinkListItem,
        ShareLinkValidateResponse,
    ):
        assert "show_internal_comments" not in schema.model_fields, schema.__name__


def test_the_share_comment_response_has_no_visibility_field():
    """A share viewer only ever sees public comments, so the field says
    nothing. The exact allowlist is pinned in
    test_share_comment_identity.py; this is the named half."""
    from apps.api.schemas.comment import ShareCommentResponse

    assert "visibility" not in ShareCommentResponse.model_fields
    assert "author_initials" in ShareCommentResponse.model_fields


def test_the_authenticated_model_keeps_its_visibility():
    """The field is removed from the SHARE response only. Inside the app an
    internal comment is a real thing and the panel marks it."""
    from apps.api.schemas.comment import CommentResponse

    assert "visibility" in CommentResponse.model_fields


@pytest.mark.parametrize(
    "schema_name", ["ShareLinkCreate", "MultiShareCreate", "ShareLinkUpdate"]
)
def test_an_older_client_may_still_send_the_key(schema_name):
    """Pydantic's default is `extra="ignore"`, which is what makes this
    deploy safe for a browser tab opened before it. Verified, not assumed:
    a model configured with `extra="forbid"` would 422 every stale client.
    """
    from apps.api import schemas

    schema = getattr(schemas.share, schema_name)
    assert schema.model_config.get("extra") in (None, "ignore")
    built = schema.model_validate({"show_internal_comments": True})
    assert not hasattr(built, "show_internal_comments")
    # And the key really was dropped rather than kept in an extras bag.
    assert "show_internal_comments" not in built.model_dump()


def test_the_visibility_filter_does_not_look_at_the_link():
    """The filter is the same SQL expression whatever the link says.

    Compiled to a string and compared, because an expression object does
    not support ==; and run against a link whose column is True, which is
    the mutation this file exists to catch ("read it again in the filter").
    """
    from types import SimpleNamespace

    from apps.api.routers.comments import _share_visibility_filter

    off = _share_visibility_filter(SimpleNamespace(show_internal_comments=False))
    on = _share_visibility_filter(SimpleNamespace(show_internal_comments=True))
    rendered = str(off.compile(compile_kwargs={"literal_binds": True}))
    assert rendered == str(on.compile(compile_kwargs={"literal_binds": True}))
    assert "'public'" in rendered
    assert "internal" not in rendered


def test_the_reconciler_does_not_write_the_dead_column():
    """`_reconcile_comment_settings` used to switch it off with the panel.

    Writing a dead column is how the rule would come back by accident, so
    the attribute must be left exactly as it was found.
    """
    from apps.api.models.share import SharePermission
    from apps.api.routers.share import _reconcile_comment_settings

    class Link:
        permission = SharePermission.view
        show_comments = False
        show_internal_comments = True

    link = Link()
    _reconcile_comment_settings(link)
    assert link.show_internal_comments is True


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


def force_column(world, link, value: bool) -> None:
    """Set `show_internal_comments` with raw SQL, bypassing the model.

    The point of the test is the DATABASE row, not what the ORM would have
    written: a link created before §234b can have TRUE in that column and
    must behave like any other link.
    """
    session = world["session"]
    session.execute(
        sql_text("UPDATE share_links SET show_internal_comments = :v WHERE id = :id"),
        {"v": value, "id": str(link.id)},
    )
    session.commit()
    session.expire_all()
    stored = session.execute(
        sql_text("SELECT show_internal_comments FROM share_links WHERE id = :id"),
        {"id": str(link.id)},
    ).scalar()
    assert stored is value, stored


def flatten(payload):
    out = []
    stack = list(payload)
    while stack:
        c = stack.pop()
        out.append(c)
        stack.extend(c.get("replies") or [])
    return out


def listing(client, world, link):
    params = {}
    if link.password_hash:
        params["share_session"] = open_password_session(link.token)
    resp = client.get(f"/share/{link.token}/comments", params=params)
    assert resp.status_code == 200, resp.text
    return resp


@realredis
class TestTheColumnIsDead:
    """C — forced TRUE in the DB, on a link that HAS an internal comment."""

    @pytest.mark.parametrize("link_key", ["link_asset", "link_pw"])
    @pytest.mark.parametrize("column", [False, True])
    def test_the_internal_comment_is_not_returned(
        self, client, world, link_key, column
    ):
        link = world[link_key]
        force_column(world, link, column)

        resp = listing(client, world, link)
        bodies = [c["body"] for c in flatten(resp.json())]
        # The fixture's internal note and its internal REPLY, which is the
        # one that used to survive by being deep in a thread.
        assert "the internal note" not in bodies
        assert "the internal reply" not in bodies
        assert "the internal" not in resp.text
        # Not vacuous: the public thread did come back.
        assert "the public note" in bodies
        assert "the reply" in bodies

    @pytest.mark.parametrize("link_key", ["link_asset", "link_pw"])
    def test_a_fresh_internal_comment_filed_in_the_app_does_not_appear(
        self, client, world, link_key
    ):
        """The owner's own scenario, end to end: a member marks a comment
        internal through the AUTHENTICATED route, then the link is opened.
        """
        link = world[link_key]
        force_column(world, link, True)
        asset = world["asset_single"]

        made = client.post(
            f"/assets/{asset.id}/comments",
            json={
                "body": "FILED-INTERNAL",
                "visibility": "internal",
                "version_id": str(world["versions"][asset.id].id),
            },
            headers=auth_header(world["owner"]),
        )
        assert made.status_code == 201, made.text
        assert made.json()["visibility"] == "internal"

        resp = listing(client, world, link)
        assert "FILED-INTERNAL" not in resp.text

    def test_the_card_s_comment_count_does_not_count_it_either(
        self, client, world
    ):
        """A count that includes internal comments is itself a statement
        that an internal thread exists — and the folder listing read the
        column for it until §234b."""
        from apps.api.models.comment import Comment

        session = world["session"]
        link = world["link_folder"]
        force_column(world, link, True)
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
            f"/share/{link.token}/assets",
            params={"folder_id": str(world["folder_a1"].id)},
        )
        assert resp.status_code == 200, resp.text
        item = [a for a in resp.json()["assets"] if a["id"] == str(asset.id)][0]
        # The one public comment the fixture put on this asset.
        assert item["comment_count"] == 1


@realredis
class TestTheHandlersIgnoreTheKey:
    """A — a stale client's extra key reaches the create/update handlers."""

    def test_creating_an_asset_link_with_the_key_still_works(self, client, world):
        resp = client.post(
            f"/assets/{world['asset_single'].id}/share",
            json={"title": "stale client", "show_internal_comments": True},
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 201, resp.text
        assert "show_internal_comments" not in resp.json()
        # And the column is still at its server default, not what was sent.
        stored = world["session"].execute(
            sql_text(
                "SELECT show_internal_comments FROM share_links WHERE token = :t"
            ),
            {"t": resp.json()["token"]},
        ).scalar()
        assert stored is False

    def test_patching_a_link_with_the_key_still_works(self, client, world):
        link = world["link_asset"]
        resp = client.patch(
            f"/share/{link.token}",
            json={"title": "renamed", "show_internal_comments": True},
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["title"] == "renamed"
        assert "show_internal_comments" not in resp.json()
        stored = world["session"].execute(
            sql_text("SELECT show_internal_comments FROM share_links WHERE id = :id"),
            {"id": str(link.id)},
        ).scalar()
        assert stored is False

    def test_a_multi_share_with_the_key_still_works(self, client, world):
        resp = client.post(
            f"/projects/{world['project'].id}/share/multi",
            json={
                "asset_ids": [str(world["asset_single"].id)],
                "title": "stale multi",
                "show_internal_comments": True,
            },
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 201, resp.text
        assert "show_internal_comments" not in resp.json()

    def test_hiding_the_comment_panel_no_longer_writes_the_column(
        self, client, world
    ):
        """§234 F1 had `_reconcile_comment_settings` clear it with the
        panel. Nothing writes it now, so a row that was TRUE stays TRUE —
        and still shows no internal comment."""
        link = world["link_asset"]
        force_column(world, link, True)
        resp = client.patch(
            f"/share/{link.token}",
            json={"show_comments": False},
            headers=auth_header(world["owner"]),
        )
        assert resp.status_code == 200, resp.text
        stored = world["session"].execute(
            sql_text("SELECT show_internal_comments FROM share_links WHERE id = :id"),
            {"id": str(link.id)},
        ).scalar()
        assert stored is True
