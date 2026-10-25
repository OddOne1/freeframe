"""§233 — `POST /auth/register` is gone, and has to stay gone.

The route let an ANONYMOUS caller commit `User(status=active)` with a
password of their choosing: no invite, no admin, no rate limit, no check of
any kind. On an instance whose access model is "an admin invites you" that
is a public sign-up form, and nothing in `apps/web` or `apps/desktop` ever
called it.

These tests are the tripwire. Deleting a route is a one-line change to undo
by accident — a merge that resurrects it, a revert that goes one commit too
far — so the absence is asserted three ways: the path is unroutable, it is
not advertised in the OpenAPI schema, and (on a real database) an anonymous
POST at it adds no `users` row.

The routing assertions run against the mocked session like the rest of
`test_auth.py`; only the row-count one needs Postgres.
"""
import os
import uuid

import pytest


@pytest.fixture(autouse=True)
def _setup_guard_satisfied():
    """Let requests past SetupGuardMiddleware whatever database is behind it.

    The guard answers 503 to everything until a superadmin exists, and it
    reaches past the mocked session to the real `SessionLocal`. With no
    database reachable it fails open and these tests pass by accident; with
    a real one (which the row-count test below needs) it finds no superadmin
    and 503s every assertion in this file. Flipping its cached flag is what
    the rest of the suite gets for free from an unreachable DATABASE_URL,
    made explicit so this file behaves the same either way.
    """
    from apps.api.middleware import setup_guard

    previous = setup_guard._setup_complete
    setup_guard._setup_complete = True
    try:
        yield
    finally:
        setup_guard._setup_complete = previous


def test_post_is_404_not_405(client):
    """404, and the distinction is the point.

    Starlette answers 405 when a path MATCHES a route that does not accept
    the method, and 404 when nothing matches at all. A 405 here would mean
    `/auth/register` is still a registered path under some other verb — so
    this test asserts the stronger of the two.
    """
    resp = client.post(
        "/auth/register",
        json={"email": "nobody@example.com", "name": "No Body", "password": "Wq7#vLm2$kPz"},
    )
    assert resp.status_code == 404


@pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
def test_no_verb_reaches_it(client, method):
    assert getattr(client, method)("/auth/register").status_code == 404


def test_the_openapi_schema_does_not_mention_it(client):
    """Not just missing from the paths — missing from the schemas too.

    A generated client is built from this document, so a `RegisterRequest`
    left behind in `components/schemas` would keep advertising a shape the
    server no longer accepts.
    """
    schema = client.get("/openapi.json").json()

    assert "/auth/register" not in schema["paths"]
    assert not [p for p in schema["paths"] if p.endswith("/register")]
    assert "RegisterRequest" not in schema.get("components", {}).get("schemas", {})


def test_the_request_schema_class_is_gone():
    """Imported by name, because that is how a half-revert shows up."""
    import apps.api.schemas.auth as auth_schemas

    assert not hasattr(auth_schemas, "RegisterRequest")


def test_the_router_has_no_register_handler():
    import apps.api.routers.auth as auth_router

    assert not hasattr(auth_router, "register")
    paths = {getattr(r, "path", None) for r in auth_router.router.routes}
    assert "/auth/register" not in paths
    assert "/register" not in paths


# ─── and no row appears ──────────────────────────────────────────────────────
#
# The three tests above prove the route is unreachable. This one proves the
# consequence that actually matters, against a real Postgres: whatever an
# anonymous caller POSTs there, the `users` table does not grow.

PG_URL = os.environ.get("TEST_DATABASE_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a row "
           "count is not something the mocked session can express",
)


@realdb
def test_an_anonymous_post_creates_no_user_row():
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, func
    from sqlalchemy.orm import sessionmaker

    from apps.api.database import get_db
    from apps.api.main import app
    from apps.api.models.user import User

    engine = create_engine(PG_URL, future=True)
    Session = sessionmaker(bind=engine, future=True)

    def _override():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override
    counting = Session()
    try:
        before = counting.query(func.count(User.id)).scalar()

        email = f"anon-{uuid.uuid4().hex[:10]}@example.com"
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/auth/register",
            json={"email": email, "name": "Anon Ymous", "password": "Wq7#vLm2$kPz"},
        )
        assert resp.status_code == 404

        counting.expire_all()
        assert counting.query(func.count(User.id)).scalar() == before
        assert (
            counting.query(User).filter(func.lower(User.email) == email).first()
            is None
        )
    finally:
        counting.close()
        app.dependency_overrides.pop(get_db, None)
