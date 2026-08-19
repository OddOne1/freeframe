"""One level of LUT sub-group nesting (CLAUDE.md §45).

Real Postgres. The depth cap is application-enforced (Postgres cannot
express "at most one level" on a self-referential FK), so the tests that
matter are the rejections — and a rejection is only meaningful against a
schema that would otherwise have accepted the row.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres. See
test_platform_lut_groups.py for the container recipe.
"""

import os
import uuid

import pytest
from fastapi import HTTPException

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    return sessionmaker(autocommit=False, autoflush=False, bind=create_engine(PG_URL))


@pytest.fixture
def db(sessionmaker_):
    from apps.api.models.lut import Lut, LutGroup
    from apps.api.models.user import User

    session = sessionmaker_()
    made = {"users": [], "groups": [], "luts": []}
    try:
        yield session, made
    finally:
        session.rollback()
        if made["luts"]:
            session.query(Lut).filter(Lut.id.in_(made["luts"])).delete(synchronize_session=False)
        if made["groups"]:
            # Children first: the parent FK would otherwise block the delete.
            session.query(LutGroup).filter(
                LutGroup.id.in_(made["groups"])
            ).update({"parent_group_id": None}, synchronize_session=False)
            session.query(LutGroup).filter(LutGroup.id.in_(made["groups"])).delete(synchronize_session=False)
        if made["users"]:
            session.query(User).filter(User.id.in_(made["users"])).delete(synchronize_session=False)
        session.commit()
        session.close()


def make_user(session, made, superadmin=True):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    user = User(
        email=f"{uuid.uuid4().hex[:12]}@ffsubgroups.com",
        last_name="Tester",
        status=UserStatus.active,
        role=UserGlobalRole.superadmin if superadmin else UserGlobalRole.superuser,
    )
    session.add(user)
    session.commit()
    made["users"].append(user.id)
    return user


def personal(session, made, user, name, parent=None):
    from apps.api.routers.luts import create_lut_group
    from apps.api.schemas.lut import LutGroupCreate
    g = create_lut_group(
        LutGroupCreate(name=name, parent_group_id=parent), db=session, current_user=user
    )
    made["groups"].append(g.id)
    return g


def platform(session, made, user, name, parent=None):
    from apps.api.routers.luts import create_platform_lut_group
    from apps.api.schemas.lut import LutGroupCreate
    g = create_platform_lut_group(
        LutGroupCreate(name=name, parent_group_id=parent), db=session, current_user=user
    )
    made["groups"].append(g.id)
    return g


# ─── the happy path ──────────────────────────────────────────────────────────

def test_a_sub_group_is_created_through_the_same_endpoint(db):
    session, made = db
    user = make_user(session, made)
    main = personal(session, made, user, "Main")
    sub = personal(session, made, user, "Sub", parent=main.id)

    assert main.parent_group_id is None
    assert sub.parent_group_id == main.id


def test_platform_groups_nest_the_same_way(db):
    session, made = db
    admin = make_user(session, made)
    main = platform(session, made, admin, "Platform Main")
    sub = platform(session, made, admin, "Platform Sub", parent=main.id)
    assert sub.parent_group_id == main.id
    assert sub.is_platform is True


def test_a_lut_can_live_in_a_sub_group(db):
    session, made = db
    from apps.api.models.lut import Lut
    from apps.api.routers.luts import update_lut
    from apps.api.schemas.lut import LutUpdate

    user = make_user(session, made)
    main = personal(session, made, user, "Main")
    sub = personal(session, made, user, "Sub", parent=main.id)

    lut = Lut(owner_id=user.id, name="A", s3_key=f"luts/{uuid.uuid4().hex}.cube")
    session.add(lut)
    session.commit()
    made["luts"].append(lut.id)

    out = update_lut(lut.id, LutUpdate(group_id=sub.id), db=session, current_user=user)
    assert out.group_id == sub.id


# ─── exactly one level ───────────────────────────────────────────────────────

def test_a_sub_group_cannot_hold_sub_groups(db):
    session, made = db
    user = make_user(session, made)
    main = personal(session, made, user, "Main")
    sub = personal(session, made, user, "Sub", parent=main.id)

    with pytest.raises(HTTPException) as exc:
        personal(session, made, user, "Deeper", parent=sub.id)
    assert exc.value.status_code == 400
    assert "sub-group" in exc.value.detail


def test_a_platform_sub_group_cannot_hold_sub_groups_either(db):
    session, made = db
    admin = make_user(session, made)
    main = platform(session, made, admin, "Main")
    sub = platform(session, made, admin, "Sub", parent=main.id)

    with pytest.raises(HTTPException) as exc:
        platform(session, made, admin, "Deeper", parent=sub.id)
    assert exc.value.status_code == 400


# ─── the two kinds do not cross ──────────────────────────────────────────────

def test_a_personal_sub_group_cannot_sit_under_a_platform_group(db):
    session, made = db
    admin = make_user(session, made)
    plat = platform(session, made, admin, "Platform Main")

    with pytest.raises(HTTPException) as exc:
        personal(session, made, admin, "Mine", parent=plat.id)
    assert exc.value.status_code == 400


def test_a_platform_sub_group_cannot_sit_under_a_personal_group(db):
    session, made = db
    admin = make_user(session, made)
    mine = personal(session, made, admin, "Mine")

    with pytest.raises(HTTPException) as exc:
        platform(session, made, admin, "Shared", parent=mine.id)
    assert exc.value.status_code == 400


def test_someone_elses_personal_group_is_not_a_valid_parent(db):
    session, made = db
    a = make_user(session, made)
    b = make_user(session, made)
    theirs = personal(session, made, b, "Theirs")

    with pytest.raises(HTTPException) as exc:
        personal(session, made, a, "Mine", parent=theirs.id)
    # 404, not 403: a group the caller cannot see does not exist to them.
    assert exc.value.status_code == 404


def test_a_missing_parent_is_rejected(db):
    session, made = db
    user = make_user(session, made)
    with pytest.raises(HTTPException) as exc:
        personal(session, made, user, "Orphan", parent=uuid.uuid4())
    assert exc.value.status_code == 404


# ─── deletion ────────────────────────────────────────────────────────────────

def test_deleting_a_main_group_promotes_its_sub_groups(db):
    session, made = db
    from apps.api.models.lut import Lut, LutGroup
    from apps.api.routers.luts import delete_lut_group

    user = make_user(session, made)
    main = personal(session, made, user, "Main")
    sub = personal(session, made, user, "Sub", parent=main.id)
    lut = Lut(owner_id=user.id, name="A", s3_key=f"luts/{uuid.uuid4().hex}.cube", group_id=sub.id)
    session.add(lut)
    session.commit()
    made["luts"].append(lut.id)

    delete_lut_group(main.id, db=session, current_user=user)
    session.expire_all()

    # The sub-group survives as a top-level group, and keeps its LUT. The
    # FK's SET NULL only fires on a hard delete, which this is not.
    surviving = session.query(LutGroup).filter(LutGroup.id == sub.id).one()
    assert surviving.deleted_at is None
    assert surviving.parent_group_id is None
    assert session.query(Lut).filter(Lut.id == lut.id).one().group_id == sub.id


def test_deleting_a_platform_main_group_promotes_its_sub_groups(db):
    session, made = db
    from apps.api.models.lut import LutGroup
    from apps.api.routers.luts import delete_platform_lut_group

    admin = make_user(session, made)
    main = platform(session, made, admin, "Main")
    sub = platform(session, made, admin, "Sub", parent=main.id)

    delete_platform_lut_group(main.id, db=session, current_user=admin)
    session.expire_all()
    surviving = session.query(LutGroup).filter(LutGroup.id == sub.id).one()
    assert surviving.deleted_at is None
    assert surviving.parent_group_id is None


# ─── purely additive ─────────────────────────────────────────────────────────

def test_a_group_created_without_a_parent_is_unchanged(db):
    session, made = db
    from apps.api.routers.luts import list_lut_groups

    user = make_user(session, made)
    main = personal(session, made, user, "Plain")
    listed = [g for g in list_lut_groups(db=session, current_user=user) if g.id == main.id]
    assert len(listed) == 1
    assert listed[0].parent_group_id is None
