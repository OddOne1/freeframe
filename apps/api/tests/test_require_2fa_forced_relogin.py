"""Forced re-login when 2FA becomes mandatory (§207).

§199 built the mechanism — `users.token_version`, stamped into every access
and refresh token as a `tv` claim and checked by `get_current_user` and
/auth/refresh. §207 wires the one place that was never connected to it:
PATCH /site-settings turning `require_2fa` on. Before this, that flip changed
one boolean and left every single-factor session running for the whole refresh
window, so the policy only took effect at each user's next login.

Real Postgres, and tokens carried through the real middleware on real
requests, because every property here is about what a DIFFERENT request sees
after a write. A mock session cannot express a bulk UPDATE ... RETURNING, and
calling the router function directly would skip `get_current_user` — which IS
the thing under test: the point is not that a column changed, it is that a
token stops working.

Redis is reached by nothing on these paths (no endpoint here is rate-limited,
and the 2FA staging/code pools are patched the way conftest's own
`staged_2fa_setup` does it), so a Redis is not required to run the file —
but the suite is written against the real stack and one is used in the
environment below.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_require_2fa_forced_relogin.py
"""

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)

_POLICY_OK_PASSWORD = "Tf4#qRn8!vZw"


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db(sessionmaker_):
    """A real session, and every row it made torn down afterwards.

    `site_settings` is a singleton row the app creates on demand, so it is
    reset rather than deleted: deleting it would make the next test's
    `_get_or_create_settings` insert a fresh one, which is fine, but leaving
    `require_2fa` on would leak the policy into unrelated tests.
    """
    from apps.api.models.site_settings import SiteSettings
    from apps.api.models.user import User

    session = sessionmaker_()
    made = {"users": []}
    try:
        yield session, made
    finally:
        session.rollback()
        if made["users"]:
            session.query(User).filter(User.id.in_(made["users"])).delete(
                synchronize_session=False
            )
        row = session.query(SiteSettings).first()
        if row is not None:
            row.require_2fa = False
        session.commit()
        session.close()


@pytest.fixture
def client(db):
    """A TestClient on the real app, talking to the real session.

    `get_current_user` is deliberately NOT overridden — unlike conftest's own
    `client`/`auth_headers` pair, which short-circuits it. The whole subject
    of this file is whether a token still authenticates, so the middleware
    has to actually run.
    """
    session, _ = db
    with patch("apps.api.services.s3_service.ensure_bucket_exists"), patch(
        "apps.api.services.s3_service.get_s3_client", return_value=MagicMock()
    ):
        from fastapi.testclient import TestClient

        from apps.api.database import get_db
        from apps.api.main import app

        app.dependency_overrides[get_db] = lambda: session
        c = TestClient(app, raise_server_exceptions=False)
        yield c
        app.dependency_overrides.clear()


def make_user(session, made, *, enrolled=False, status=None, superadmin=False):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    from apps.api.services.auth_service import hash_password

    user = User(
        email=f"{uuid.uuid4().hex[:12]}@ff207.test",
        first_name="Relogin",
        last_name="Tester",
        password_hash=hash_password(_POLICY_OK_PASSWORD),
        status=status or UserStatus.active,
        role=UserGlobalRole.superadmin if superadmin else UserGlobalRole.user,
        two_factor_enabled=enrolled,
        two_factor_method="totp" if enrolled else None,
        # §200's gate would 403 every protected route without these. The
        # requests below all live under /auth/*, which the gate lets through
        # unconditionally, but a half-set-up user would still be a confusing
        # fixture to debug against.
        backup_email=f"{uuid.uuid4().hex[:12]}@backup207.test",
        backup_email_verified_at=datetime.now(timezone.utc),
    )
    session.add(user)
    session.commit()
    made["users"].append(user.id)
    return user


def token_for(user):
    """An access token minted under this user's CURRENT token_version."""
    from apps.api.services.auth_service import create_access_token

    return create_access_token(str(user.id), user.token_version or 0)


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def me(client, token):
    """A real authenticated request. /auth/me because it is the smallest
    endpoint that goes through `get_current_user` and is not behind §200's
    account gate."""
    return client.get("/auth/me", headers=auth(token))


def set_require_2fa(client, admin_token, enabled):
    return client.patch(
        "/site-settings", json={"require_2fa": enabled}, headers=auth(admin_token)
    )


def version_of(session, user):
    session.expire(user)
    return user.token_version or 0


# ── A — the flip signs out exactly the right people ────────────────────────


class TestTurningTheRequirementOn:
    def test_it_signs_out_the_unenrolled_and_leaves_the_enrolled_alone(self, client, db):
        """The central claim of §207, asserted on tokens rather than columns."""
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        unenrolled = make_user(session, made, enrolled=False)
        enrolled = make_user(session, made, enrolled=True)

        admin_token = token_for(admin)
        unenrolled_token = token_for(unenrolled)
        enrolled_token = token_for(enrolled)

        # Both work beforehand, or the assertion afterwards proves nothing.
        assert me(client, unenrolled_token).status_code == 200
        assert me(client, enrolled_token).status_code == 200

        res = set_require_2fa(client, admin_token, True)
        assert res.status_code == 200, res.text

        assert me(client, unenrolled_token).status_code == 401
        assert me(client, enrolled_token).status_code == 200

    def test_the_acting_admin_is_not_exempt(self, client, db):
        """A superadmin without a second factor signs themselves out.

        Deliberate, not an oversight: the alternative leaves the one account
        on the instance holding a single-factor session under a policy that
        forbids exactly that.
        """
        session, made = db
        admin = make_user(session, made, enrolled=False, superadmin=True)
        admin_token = token_for(admin)

        assert set_require_2fa(client, admin_token, True).status_code == 200
        assert me(client, admin_token).status_code == 401

    def test_a_deactivated_user_is_not_counted(self, client, db):
        """Their sessions are already refused on every request (get_current_user
        re-reads `status`), so bumping them would change nothing and would
        inflate the number the admin is shown."""
        from apps.api.models.user import UserStatus

        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        deactivated = make_user(
            session, made, enrolled=False, status=UserStatus.deactivated
        )
        before = version_of(session, deactivated)

        res = set_require_2fa(client, token_for(admin), True)
        assert res.status_code == 200
        assert version_of(session, deactivated) == before

    def test_the_reported_count_equals_the_rows_bumped(self, client, db):
        """The response's number is the UPDATE's own row count.

        Checked against the versions that actually moved, not against a
        second count taken from the same predicate — the point is that the
        figure describes what happened, not that two queries agree.
        """
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        unenrolled = [make_user(session, made, enrolled=False) for _ in range(3)]
        enrolled = make_user(session, made, enrolled=True)

        before = {u.id: version_of(session, u) for u in unenrolled + [enrolled]}

        res = set_require_2fa(client, token_for(admin), True)
        assert res.status_code == 200
        reported = res.json()["two_factor_signed_out_count"]

        moved = [
            u
            for u in unenrolled + [enrolled]
            if version_of(session, u) != before[u.id]
        ]
        assert len(moved) == 3
        assert enrolled not in moved
        # The instance may hold users this test did not create, so the
        # reported total is >= the three it can account for, and the three it
        # created are all in it.
        assert reported >= 3

    def test_the_preview_count_matches_what_the_write_then_does(self, client, db):
        """The confirmation dialog's number, and then the write's.

        They are two statements (the preview necessarily runs before the
        decision), so what is asserted is that they agree when nothing
        changes in between — which is what the shared predicate buys.
        """
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        for _ in range(2):
            make_user(session, made, enrolled=False)

        preview = client.get(
            "/site-settings/require-2fa-impact", headers=auth(token_for(admin))
        )
        assert preview.status_code == 200
        predicted = preview.json()["affected_users"]

        res = set_require_2fa(client, token_for(admin), True)
        assert res.json()["two_factor_signed_out_count"] == predicted

    def test_the_preview_is_superadmin_only(self, client, db):
        session, made = db
        ordinary = make_user(session, made, enrolled=True)
        res = client.get(
            "/site-settings/require-2fa-impact", headers=auth(token_for(ordinary))
        )
        assert res.status_code == 403


class TestTheFlipsThatMustEndNoSessions:
    def test_turning_it_off_bumps_nothing(self, client, db):
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        unenrolled = make_user(session, made, enrolled=False)

        assert set_require_2fa(client, token_for(admin), True).status_code == 200
        # The admin is enrolled, so their own token survived the flip above.
        after_on = version_of(session, unenrolled)

        res = set_require_2fa(client, token_for(admin), False)
        assert res.status_code == 200
        assert res.json()["two_factor_signed_out_count"] is None
        assert version_of(session, unenrolled) == after_on

    def test_on_to_on_is_not_a_change(self, client, db):
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        unenrolled = make_user(session, made, enrolled=False)

        set_require_2fa(client, token_for(admin), True)
        after_first = version_of(session, unenrolled)

        res = set_require_2fa(client, token_for(admin), True)
        assert res.status_code == 200
        assert res.json()["two_factor_signed_out_count"] is None
        assert version_of(session, unenrolled) == after_first

    def test_an_unrelated_setting_touches_no_session(self, client, db):
        """Not a generic "any settings change bumps" hook. A timezone does not
        change what a live session is entitled to."""
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        unenrolled = make_user(session, made, enrolled=False)
        before = version_of(session, unenrolled)
        unenrolled_token = token_for(unenrolled)

        res = client.patch(
            "/site-settings",
            json={"timezone": "Europe/Vienna"},
            headers=auth(token_for(admin)),
        )
        assert res.status_code == 200
        assert res.json()["two_factor_signed_out_count"] is None
        assert version_of(session, unenrolled) == before
        assert me(client, unenrolled_token).status_code == 200


# ── B — forced enrolment ends in a real sign-in ────────────────────────────


@pytest.fixture
def staged(db):
    """§194b's Redis enrolment staging, as a dict — same approach, and the
    same reasoning, as conftest's `staged_2fa_setup`."""
    store = {}

    with patch(
        "apps.api.routers.auth.store_pending_2fa_setup",
        side_effect=lambda uid, m, s: store.__setitem__(
            str(uid), {"method": m, "secret": s}
        ),
    ), patch(
        "apps.api.routers.auth.read_pending_2fa_setup",
        side_effect=lambda uid: store.get(str(uid)),
    ), patch(
        "apps.api.routers.auth.clear_pending_2fa_setup",
        side_effect=lambda uid: store.pop(str(uid), None),
    ), patch(
        "apps.api.routers.auth.clear_2fa_setup_code"
    ):
        yield store


def confirm_forced_enrolment(client, db, staged, user):
    """Walk a forced first login's enrolment to the backup-codes screen.

    Returns the confirm-setup response. Staging is planted directly rather
    than driven through /auth/2fa/setup: what matters below is what confirm
    does to sessions, and the setup step is §194b's territory, already
    covered elsewhere.
    """
    import pyotp

    from apps.api.services import totp_service
    from apps.api.services.auth_service import create_2fa_pending_token

    secret = totp_service.generate_totp_secret()
    staged[str(user.id)] = {
        "method": "totp",
        "secret": totp_service.encrypt_secret(secret),
    }
    pending = create_2fa_pending_token(str(user.id))
    return client.post(
        "/auth/2fa/confirm-setup",
        json={"pending_token": pending, "code": pyotp.TOTP(secret).now()},
    )


class TestForcedEnrolmentConfirm:
    def test_it_ends_older_sessions_and_hands_this_one_a_working_token(
        self, client, db, staged
    ):
        """Already true before §207 (confirm-setup bumps, then re-issues from
        the post-bump version) and pinned here because §207's sign-out step
        depends on it: the token the codes screen uses has to work for at
        least the one request that ends it.
        """
        session, made = db
        user = make_user(session, made, enrolled=False)
        older_token = token_for(user)

        res = confirm_forced_enrolment(client, db, staged, user)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["backup_codes"]
        # Spelled out rather than left to a KeyError/TypeError below: losing
        # the re-issued pair is a specific regression (the codes screen would
        # have nothing to authenticate with), and it should read as that.
        assert body["tokens"], "confirm-setup must hand this browser a new pair"

        new_token = body["tokens"]["access_token"]
        assert me(client, new_token).status_code == 200
        assert me(client, older_token).status_code == 401

    def test_dismissing_the_codes_ends_this_session_too(self, client, db, staged):
        """§207's new endpoint. The pair confirm-setup issued exists so the
        codes can be rendered; once the user says they have them, it stops
        working, and they sign in with the factor they just set up."""
        session, made = db
        user = make_user(session, made, enrolled=False)

        res = confirm_forced_enrolment(client, db, staged, user)
        assert res.json()["tokens"], "confirm-setup must hand this browser a new pair"
        new_token = res.json()["tokens"]["access_token"]

        ended = client.post(
            "/auth/2fa/end-enrolment-session", json={}, headers=auth(new_token)
        )
        assert ended.status_code == 200
        assert ended.json()["signed_out"] is True
        # No replacement pair, deliberately — see
        # TwoFactorEndEnrolmentSessionResponse.
        assert "tokens" not in ended.json()

        assert me(client, new_token).status_code == 401

    def test_the_endpoint_needs_a_live_session(self, client, db):
        session, made = db
        user = make_user(session, made, enrolled=False)
        token = token_for(user)
        client.post("/auth/2fa/end-enrolment-session", json={}, headers=auth(token))
        # Already stale now; a second call cannot be made with it.
        again = client.post(
            "/auth/2fa/end-enrolment-session", json={}, headers=auth(token)
        )
        assert again.status_code == 401


# ── Out of scope, pinned so §207 cannot have moved it ──────────────────────


class TestVoluntaryEnrolmentIsUnchanged:
    def test_an_already_signed_in_user_enrolling_gets_a_working_token_back(
        self, client, db, staged
    ):
        """Voluntary enrolment from Settings is explicitly out of §207's scope.
        It bumps (§199) and hands back a replacement pair, and it does NOT
        sign the user out — nothing here calls the new endpoint. Pinned
        rather than changed."""
        session, made = db
        user = make_user(session, made, enrolled=False)
        session_token = token_for(user)

        import pyotp

        from apps.api.services import totp_service

        secret = totp_service.generate_totp_secret()
        staged[str(user.id)] = {
            "method": "totp",
            "secret": totp_service.encrypt_secret(secret),
        }
        res = client.post(
            "/auth/2fa/confirm-setup",
            json={"code": pyotp.TOTP(secret).now()},
            headers=auth(session_token),
        )
        assert res.status_code == 200, res.text
        assert res.json()["tokens"], "confirm-setup must hand this browser a new pair"
        new_token = res.json()["tokens"]["access_token"]
        # Still signed in, on the replacement pair.
        assert me(client, new_token).status_code == 200
        # And the old one is gone, which is §199's behaviour, not §207's.
        assert me(client, session_token).status_code == 401


class TestShareGuestsAreUnaffected:
    """Share links carry no user token, so `token_version` has no bearing on
    them — but "turning on 2FA broke the public share pages" would be a bad
    way to find that out, so it is asserted rather than assumed.
    """

    @staticmethod
    def _shared_asset(session, made):
        from apps.api.models.asset import (
            Asset,
            AssetType,
            AssetVersion,
            ProcessingStatus,
        )
        from apps.api.models.project import Project, ProjectMember, ProjectRole
        from apps.api.models.share import ShareLink, SharePermission

        owner = make_user(session, made, enrolled=False)
        project = Project(name=f"P{uuid.uuid4().hex[:8]}", created_by=owner.id)
        session.add(project)
        session.commit()
        member = ProjectMember(
            project_id=project.id, user_id=owner.id, role=ProjectRole.owner
        )
        asset = Asset(
            project_id=project.id,
            name=f"clip-{uuid.uuid4().hex[:6]}.mov",
            asset_type=AssetType.video,
            created_by=owner.id,
        )
        session.add_all([member, asset])
        session.commit()
        version = AssetVersion(
            asset_id=asset.id,
            version_number=1,
            processing_status=ProcessingStatus.ready,
            created_by=owner.id,
        )
        link = ShareLink(
            token=uuid.uuid4().hex,
            asset_id=asset.id,
            created_by=owner.id,
            permission=SharePermission.comment,
            show_comments=True,
        )
        session.add_all([version, link])
        session.commit()
        return link

    def test_the_share_page_still_resolves_after_a_bump(self, client, db):
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        link = self._shared_asset(session, made)

        before = client.get(f"/share/{link.token}")
        assert before.status_code == 200, before.text

        assert set_require_2fa(client, token_for(admin), True).status_code == 200

        after = client.get(f"/share/{link.token}")
        assert after.status_code == 200, after.text

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "PRE-EXISTING §200 DEFECT, not §207. models/user.py's GuestUser "
            "(:223) declares backup_email, backup_email_verified_at and "
            "account_gate_waived_at, but alembic/versions/"
            "add_account_security_gate.py adds those three columns to `users` "
            "only — nothing anywhere adds them to `guest_users`. So the "
            "GuestUser lookup inside guest_comment() raises "
            "psycopg2.errors.UndefinedColumn and the POST 500s, on a migrated "
            "database, with or without §207. Strict so that fixing the "
            "migration turns this into an XPASS somebody has to look at, "
            "rather than a line nobody reads again."
        ),
    )
    def test_a_guest_comment_still_posts_after_a_bump(self, client, db):
        """The property §207 was asked to protect, written as it should be.

        Posting, not just loading: posting is what a reviewer would actually
        lose. It fails today for a reason that has nothing to do with
        `token_version` — see the xfail above — and the assertions are left
        exactly as they would be once that is fixed.
        """
        session, made = db
        admin = make_user(session, made, enrolled=True, superadmin=True)
        link = self._shared_asset(session, made)

        def post_comment(text):
            return client.post(
                f"/share/{link.token}/comment",
                json={
                    "body": text,
                    "guest_email": f"{uuid.uuid4().hex[:8]}@guest207.test",
                    "guest_name": "Guest Reviewer",
                },
            )

        assert post_comment("before the flip").status_code == 201
        assert set_require_2fa(client, token_for(admin), True).status_code == 200
        assert post_comment("after the flip").status_code == 201
