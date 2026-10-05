"""The event stream is opened by a ticket, not by a bearer token (§211).

What this replaces
------------------
`GET /events/{project_id}?token=<access token>` — because `EventSource`
cannot send an Authorization header, which is a browser limitation rather than
an oversight. Two problems with the answer it reached for:

  1. the URL carried a full-API-scope bearer token, so it landed in
     Cloudflare's logs, Traefik's logs and the browser's own history, valid
     for its whole lifetime;
  2. the branch that read it called `decode_token` by hand and never compared
     `tv` against `users.token_version`. §207 ended sessions on the
     `require_2fa` flip, a password change and an admin 2FA reset — and none
     of that reached the stream. A user signed out everywhere kept receiving
     events.

A ticket fixes the second problem outright (issuance goes through
`get_current_user`) and shrinks the first to nothing that matters: one stream,
one project, 60 seconds, destroyed on use.

Real Postgres AND real Redis, with real tokens through the real middleware —
`get_current_user` is deliberately NOT overridden. The subject here is which
credentials are accepted, so the code that accepts them has to run.

Skipped unless both are configured:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    docker run -d --name ff-redis -p 63799:6379 redis:7-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
    TEST_REDIS_URL=redis://127.0.0.1:63799/0 \\
      pytest apps/api/tests/test_event_ticket.py
"""

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
REDIS_URL = os.environ.get("TEST_REDIS_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL
    or not PG_URL.startswith("postgresql")
    or not REDIS_URL
    or not REDIS_URL.startswith("redis"),
    reason="needs TEST_DATABASE_URL and TEST_REDIS_URL",
)


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(autouse=True)
def _redis(monkeypatch):
    """Point the SYNC redis helper at the test Redis.

    `redis_service` caches one client in a module global, so the URL has to be
    set before the first call and the cache dropped between tests.
    """
    from apps.api import config
    from apps.api.services import redis_service

    monkeypatch.setattr(config.settings, "redis_url", REDIS_URL, raising=False)
    redis_service._redis_client = None
    yield
    redis_service._redis_client = None


@pytest.fixture
def world(sessionmaker_):
    """Two projects, a member of the first only, plus an outsider."""
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    from apps.api.services.auth_service import hash_password

    session = sessionmaker_()
    # §207/§208's harness lesson: setup_guard reads the real database past any
    # dependency override and 503s everything when no superadmin exists.
    if (
        session.query(User)
        .filter(User.role == UserGlobalRole.superadmin, User.deleted_at.is_(None))
        .first()
        is None
    ):
        session.add(
            User(
                email="setup-guard@ff211.test",
                first_name="Setup",
                last_name="Guard",
                status=UserStatus.active,
                role=UserGlobalRole.superadmin,
                email_verified=True,
            )
        )
        session.commit()

    def make_user(**over):
        u = User(
            email=f"{uuid.uuid4().hex[:12]}@ff211.test",
            first_name="Stream",
            last_name="Tester",
            password_hash=hash_password("Tf4#qRn8!vZw"),
            status=UserStatus.active,
            role=UserGlobalRole.user,
            email_verified=True,
            # §200's gate 403s every non-/auth route without these.
            backup_email=f"{uuid.uuid4().hex[:12]}@backup211.test",
            backup_email_verified_at=datetime.now(timezone.utc),
            **over,
        )
        session.add(u)
        session.commit()
        return u

    member = make_user()
    outsider = make_user()

    project_a = Project(name=f"A{uuid.uuid4().hex[:8]}", created_by=member.id)
    project_b = Project(name=f"B{uuid.uuid4().hex[:8]}", created_by=member.id)
    session.add_all([project_a, project_b])
    session.commit()
    memberships = [
        ProjectMember(project_id=project_a.id, user_id=member.id, role=ProjectRole.owner),
        ProjectMember(project_id=project_b.id, user_id=member.id, role=ProjectRole.owner),
    ]
    session.add_all(memberships)
    session.commit()

    bag = {
        "session": session,
        "member": member,
        "outsider": outsider,
        "project_a": project_a,
        "project_b": project_b,
        "make_user": make_user,
    }
    try:
        yield bag
    finally:
        session.rollback()
        session.query(ProjectMember).filter(
            ProjectMember.project_id.in_([project_a.id, project_b.id])
        ).delete(synchronize_session=False)
        session.query(Project).filter(
            Project.id.in_([project_a.id, project_b.id])
        ).delete(synchronize_session=False)
        session.query(User).filter(
            User.email.like("%@ff211.test"), User.role != UserGlobalRole.superadmin
        ).delete(synchronize_session=False)
        session.commit()
        session.close()


@pytest.fixture(autouse=True)
def _finite_stream_body():
    """Replace the endless SSE generator with a one-chunk one.

    Not a shortcut around the thing under test: what this file asserts is
    WHICH CREDENTIALS open the stream, and the ticket logic in front of
    `event_stream` runs untouched. The body itself is §210's subject and is
    tested there against real Redis.

    Needed because the real generator never ends and, after §210, blocks for
    up to KEEPALIVE_SECONDS inside Redis per iteration — so closing the
    response waits out that block, and 14 tests × 30s times the suite out
    (measured: EXIT=124).
    """

    async def one_chunk(project_id, keepalive_seconds=None):
        yield ": keepalive\n\n"

    with patch("apps.api.routers.events.event_stream", one_chunk):
        yield


@pytest.fixture
def client(world):
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=MagicMock()
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: world["session"]
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def auth(user):
    from apps.api.services.auth_service import create_access_token

    return {
        "Authorization": f"Bearer {create_access_token(str(user.id), user.token_version or 0)}"
    }


def mint(client, user, project):
    return client.post(f"/events/ticket?project_id={project.id}", headers=auth(user))


def open_stream(client, project, ticket):
    """Open the stream WITHOUT consuming the body.

    `stream=True` matters: the response is an endless generator, and reading
    it would hang the test. The status line is the whole assertion.
    """
    with client.stream("GET", f"/events/{project.id}?ticket={ticket}") as res:
        return res.status_code


# ── a — the ticket's own rules ──────────────────────────────────────────────


class TestTheTicketOpensTheStreamExactlyOnce:
    def test_a_fresh_ticket_opens_the_stream(self, client, world):
        res = mint(client, world["member"], world["project_a"])
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ticket"]
        assert body["project_id"] == str(world["project_a"].id)
        assert body["expires_in"] == 60

        assert open_stream(client, world["project_a"], body["ticket"]) == 200

    def test_the_ticket_is_opaque(self, client, world):
        """It must not be a token, or an encoding of one — nothing a log
        reader could learn a user or project id from."""
        ticket = mint(client, world["member"], world["project_a"]).json()["ticket"]

        assert "." not in ticket, "looks like a JWT"
        assert str(world["member"].id) not in ticket
        assert str(world["project_a"].id) not in ticket
        assert len(ticket) >= 32

    def test_a_second_use_of_the_same_ticket_is_refused(self, client, world):
        ticket = mint(client, world["member"], world["project_a"]).json()["ticket"]

        assert open_stream(client, world["project_a"], ticket) == 200
        # Single use, enforced by an atomic GETDEL — so a replayed URL out of
        # a proxy log is worth nothing.
        assert open_stream(client, world["project_a"], ticket) == 401

    def test_an_expired_ticket_is_refused(self, client, world):
        """TTL injected rather than waited out: the real one is 60s."""
        from apps.api.services.redis_service import (
            generate_event_ticket,
            store_event_ticket,
        )

        ticket = generate_event_ticket()
        store_event_ticket(
            ticket,
            str(world["member"].id),
            str(world["project_a"].id),
            ttl_seconds=1,
        )
        import time

        time.sleep(1.2)
        assert open_stream(client, world["project_a"], ticket) == 401

    def test_a_ticket_for_one_project_cannot_open_another(self, client, world):
        """The permission check happens at issuance, so a ticket honoured on
        any project would be a key to every project."""
        ticket = mint(client, world["member"], world["project_a"]).json()["ticket"]

        assert open_stream(client, world["project_b"], ticket) == 401
        # And it is spent either way, rather than left usable after a probe.
        assert open_stream(client, world["project_a"], ticket) == 401

    def test_an_unknown_ticket_is_refused(self, client, world):
        assert open_stream(client, world["project_a"], "not-a-real-ticket") == 401

    def test_no_ticket_at_all_is_refused(self, client, world):
        with client.stream("GET", f"/events/{world['project_a'].id}") as res:
            assert res.status_code == 401


# ── b — issuance applies the checks the stream was missing ─────────────────


class TestIssuanceGoesThroughTheRealDoor:
    def test_a_bumped_token_version_cannot_mint_a_ticket(self, client, world):
        """§207 finally reaches the stream.

        This is the whole security point of §211: the old endpoint decoded the
        token itself and never compared `tv`, so a user signed out everywhere
        kept streaming. Now they cannot even get a ticket.
        """
        from apps.api.services.auth_service import bump_token_version

        session, member, project = (
            world["session"],
            world["member"],
            world["project_a"],
        )
        stale = auth(member)  # minted under the CURRENT version

        bump_token_version(member)
        session.commit()

        res = client.post(f"/events/ticket?project_id={project.id}", headers=stale)
        assert res.status_code == 401, res.text

    def test_a_deactivated_user_cannot_mint_a_ticket(self, client, world):
        from apps.api.models.user import UserStatus

        session, member, project = (
            world["session"],
            world["member"],
            world["project_a"],
        )
        headers = auth(member)
        member.status = UserStatus.deactivated
        session.commit()

        assert (
            client.post(
                f"/events/ticket?project_id={project.id}", headers=headers
            ).status_code
            == 401
        )

    def test_a_non_member_cannot_mint_a_ticket(self, client, world):
        res = client.post(
            f"/events/ticket?project_id={world['project_a'].id}",
            headers=auth(world["outsider"]),
        )
        assert res.status_code == 403, res.text

    def test_an_unauthenticated_caller_cannot_mint_a_ticket(self, client, world):
        res = client.post(f"/events/ticket?project_id={world['project_a'].id}")
        assert res.status_code in (401, 403)

    def test_an_unknown_project_does_not_yield_a_ticket(self, client, world):
        res = client.post(
            f"/events/ticket?project_id={uuid.uuid4()}", headers=auth(world["member"])
        )
        assert res.status_code in (403, 404)


# ── c — the old ?token= door is gone ───────────────────────────────────────


class TestTheTokenQueryParameterIsGone:
    def test_a_valid_access_token_in_the_url_no_longer_opens_the_stream(
        self, client, world
    ):
        """Removed outright rather than deprecated. §211's step 0 checked
        every client: the web app is the only one, the desktop app does not
        use this endpoint, and share-link guests never reach it."""
        from apps.api.services.auth_service import create_access_token

        member, project = world["member"], world["project_a"]
        token = create_access_token(str(member.id), member.token_version or 0)

        with client.stream(
            "GET", f"/events/{project.id}?token={token}"
        ) as res:
            assert res.status_code == 401

    def test_a_token_is_not_accepted_as_a_ticket_either(self, client, world):
        """The obvious thing a stale client would try next."""
        from apps.api.services.auth_service import create_access_token

        member, project = world["member"], world["project_a"]
        token = create_access_token(str(member.id), member.token_version or 0)

        assert open_stream(client, project, token) == 401

    def test_an_authorization_header_alone_does_not_open_the_stream(
        self, client, world
    ):
        """Not a regression: EventSource cannot send one, so nothing real
        depends on it, and accepting it would reopen a second door that would
        need its own checks."""
        with client.stream(
            "GET",
            f"/events/{world['project_a'].id}",
            headers=auth(world["member"]),
        ) as res:
            assert res.status_code == 401


# ── e — bumped while connected ─────────────────────────────────────────────


class TestSessionInvalidationReachesTheStream:
    def test_a_user_bumped_while_connected_cannot_reconnect(self, client, world):
        """The end-to-end property, in the order it happens live.

        A stream already open cannot be torn down from here — HTTP has no way
        to reach into a response body in flight — so what §211 guarantees is
        that the NEXT connection fails. Since every reconnect needs a fresh
        ticket and every ticket needs a live session, a signed-out user stops
        streaming at their next reconnect rather than when their token
        happens to expire.
        """
        from apps.api.services.auth_service import bump_token_version

        session, member, project = (
            world["session"],
            world["member"],
            world["project_a"],
        )

        # Connected and working.
        first = mint(client, member, project)
        assert first.status_code == 200
        assert open_stream(client, project, first.json()["ticket"]) == 200

        stale = auth(member)
        bump_token_version(member)
        session.commit()

        # The reconnect: no ticket, so no stream.
        assert (
            client.post(
                f"/events/ticket?project_id={project.id}", headers=stale
            ).status_code
            == 401
        )

    def test_a_ticket_minted_before_deactivation_is_refused_on_connect(
        self, client, world
    ):
        """60 seconds is short, but it is long enough to be deactivated in —
        so the stream re-reads the user rather than trusting the ticket."""
        from apps.api.models.user import UserStatus

        session, member, project = (
            world["session"],
            world["member"],
            world["project_a"],
        )
        ticket = mint(client, member, project).json()["ticket"]

        member.status = UserStatus.deactivated
        session.commit()

        assert open_stream(client, project, ticket) == 401

    def test_a_ticket_minted_before_losing_membership_is_refused_on_connect(
        self, client, world
    ):
        from apps.api.models.project import ProjectMember

        session, member, project = (
            world["session"],
            world["member"],
            world["project_a"],
        )
        ticket = mint(client, member, project).json()["ticket"]

        session.query(ProjectMember).filter(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == member.id,
        ).delete(synchronize_session=False)
        session.commit()

        assert open_stream(client, project, ticket) == 403
