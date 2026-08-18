"""Platform LUT groups are one shared set (CLAUDE.md §39).

Real Postgres, because the whole point is what two *different* superadmins
see in the same table -- a mock session can only replay whatever the test
told it to.

The routers are called directly rather than over HTTP: what is under test is
the scoping and the permission checks inside them, and going through the app
would add auth plumbing without adding coverage of either.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_platform_lut_groups.py
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
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


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
        # Named rows only -- this may be someone's scratch copy of a real DB.
        if made["luts"]:
            session.query(Lut).filter(Lut.id.in_(made["luts"])).delete(synchronize_session=False)
        if made["groups"]:
            session.query(LutGroup).filter(LutGroup.id.in_(made["groups"])).delete(synchronize_session=False)
        if made["users"]:
            session.query(User).filter(User.id.in_(made["users"])).delete(synchronize_session=False)
        session.commit()
        session.close()


def make_user(session, made, superadmin: bool):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    user = User(
        email=f"{uuid.uuid4().hex[:12]}@ffplatformgroups.com",
        last_name="Tester",
        status=UserStatus.active,
        role=UserGlobalRole.superadmin if superadmin else UserGlobalRole.superuser,
    )
    session.add(user)
    session.commit()
    made["users"].append(user.id)
    return user


def make_lut(session, made, owner, *, platform=False, group_id=None):
    from apps.api.models.lut import Lut
    lut = Lut(
        owner_id=owner.id,
        name="A LUT",
        s3_key=f"luts/{uuid.uuid4().hex}.cube",
        is_platform_wide=platform,
        group_id=group_id,
    )
    session.add(lut)
    session.commit()
    made["luts"].append(lut.id)
    return lut


# ─── shared, not per-superadmin ──────────────────────────────────────────────

def test_every_superadmin_sees_the_same_platform_groups(db):
    session, made = db
    from apps.api.routers.luts import create_platform_lut_group, list_platform_lut_groups
    from apps.api.schemas.lut import LutGroupCreate

    a = make_user(session, made, superadmin=True)
    b = make_user(session, made, superadmin=True)

    name = f"Show {uuid.uuid4().hex[:6]}"
    group = create_platform_lut_group(LutGroupCreate(name=name), db=session, current_user=a)
    made["groups"].append(group.id)

    # B never created it and does not own it.
    seen = [g.id for g in list_platform_lut_groups(db=session, current_user=b)]
    assert group.id in seen


def test_another_superadmin_can_rename_and_delete_it(db):
    session, made = db
    from apps.api.routers.luts import (
        create_platform_lut_group, rename_platform_lut_group, delete_platform_lut_group,
        list_platform_lut_groups,
    )
    from apps.api.schemas.lut import LutGroupCreate, LutGroupUpdate

    a = make_user(session, made, superadmin=True)
    b = make_user(session, made, superadmin=True)
    group = create_platform_lut_group(LutGroupCreate(name="Before"), db=session, current_user=a)
    made["groups"].append(group.id)

    renamed = rename_platform_lut_group(
        group.id, LutGroupUpdate(name="After"), db=session, current_user=b
    )
    assert renamed.name == "After"

    delete_platform_lut_group(group.id, db=session, current_user=b)
    assert group.id not in [g.id for g in list_platform_lut_groups(db=session, current_user=a)]


def test_deleting_a_platform_group_ungroups_its_luts_rather_than_taking_them(db):
    session, made = db
    from apps.api.routers.luts import create_platform_lut_group, delete_platform_lut_group
    from apps.api.schemas.lut import LutGroupCreate
    from apps.api.models.lut import Lut

    a = make_user(session, made, superadmin=True)
    group = create_platform_lut_group(LutGroupCreate(name="Doomed"), db=session, current_user=a)
    made["groups"].append(group.id)
    lut = make_lut(session, made, a, platform=True, group_id=group.id)

    delete_platform_lut_group(group.id, db=session, current_user=a)
    session.expire_all()
    assert session.query(Lut).filter(Lut.id == lut.id).one().group_id is None


def test_a_platform_group_is_not_listed_as_its_creators_personal_group(db):
    session, made = db
    from apps.api.routers.luts import create_platform_lut_group, list_lut_groups
    from apps.api.schemas.lut import LutGroupCreate

    a = make_user(session, made, superadmin=True)
    group = create_platform_lut_group(LutGroupCreate(name="Shared"), db=session, current_user=a)
    made["groups"].append(group.id)

    # Otherwise the creator would see it in both lists and could file a
    # personal LUT into it from the personal side.
    assert group.id not in [g.id for g in list_lut_groups(db=session, current_user=a)]


# ─── permissions ─────────────────────────────────────────────────────────────

def test_a_non_superadmin_can_read_but_not_change_platform_groups(db):
    session, made = db
    from apps.api.routers.luts import (
        create_platform_lut_group, list_platform_lut_groups,
        rename_platform_lut_group, delete_platform_lut_group,
    )
    from apps.api.schemas.lut import LutGroupCreate, LutGroupUpdate

    admin = make_user(session, made, superadmin=True)
    plain = make_user(session, made, superadmin=False)
    group = create_platform_lut_group(LutGroupCreate(name="Readable"), db=session, current_user=admin)
    made["groups"].append(group.id)

    # Read: allowed, same as GET /luts/platform.
    assert group.id in [g.id for g in list_platform_lut_groups(db=session, current_user=plain)]

    for call in (
        lambda: create_platform_lut_group(LutGroupCreate(name="Nope"), db=session, current_user=plain),
        lambda: rename_platform_lut_group(group.id, LutGroupUpdate(name="Nope"), db=session, current_user=plain),
        lambda: delete_platform_lut_group(group.id, db=session, current_user=plain),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 403


# ─── a LUT and its group must agree ──────────────────────────────────────────

def test_a_personal_lut_cannot_be_filed_in_a_platform_group(db):
    session, made = db
    from apps.api.routers.luts import create_platform_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=True)
    group = create_platform_lut_group(LutGroupCreate(name="Platform"), db=session, current_user=a)
    made["groups"].append(group.id)
    lut = make_lut(session, made, a, platform=False)

    with pytest.raises(HTTPException) as exc:
        update_lut(lut.id, LutUpdate(group_id=group.id), db=session, current_user=a)
    assert exc.value.status_code == 400


def test_a_platform_lut_cannot_be_filed_in_a_personal_group(db):
    session, made = db
    from apps.api.routers.luts import create_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=True)
    personal = create_lut_group(LutGroupCreate(name="Mine"), db=session, current_user=a)
    made["groups"].append(personal.id)
    lut = make_lut(session, made, a, platform=True)

    with pytest.raises(HTTPException) as exc:
        update_lut(lut.id, LutUpdate(group_id=personal.id), db=session, current_user=a)
    assert exc.value.status_code == 400


def test_promoting_and_filing_in_one_call_is_allowed(db):
    session, made = db
    from apps.api.routers.luts import create_platform_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=True)
    group = create_platform_lut_group(LutGroupCreate(name="Platform"), db=session, current_user=a)
    made["groups"].append(group.id)
    lut = make_lut(session, made, a, platform=False)

    # Checked against what the request leaves behind, not what it started
    # with -- this is what dragging a personal LUT onto a platform group does.
    out = update_lut(
        lut.id, LutUpdate(is_platform_wide=True, group_id=group.id), db=session, current_user=a
    )
    assert out.is_platform_wide is True
    assert out.group_id == group.id


def test_promoting_alone_drops_a_group_the_lut_no_longer_belongs_in(db):
    session, made = db
    from apps.api.routers.luts import create_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=True)
    personal = create_lut_group(LutGroupCreate(name="Mine"), db=session, current_user=a)
    made["groups"].append(personal.id)
    lut = make_lut(session, made, a, platform=False, group_id=personal.id)

    # The Platform button sends is_platform_wide only. Leaving the personal
    # group attached would be a pair the rule above rejects.
    out = update_lut(lut.id, LutUpdate(is_platform_wide=True), db=session, current_user=a)
    assert out.is_platform_wide is True
    assert out.group_id is None


def test_a_personal_group_still_takes_a_personal_lut(db):
    session, made = db
    from apps.api.routers.luts import create_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=False)
    personal = create_lut_group(LutGroupCreate(name="Mine"), db=session, current_user=a)
    made["groups"].append(personal.id)
    lut = make_lut(session, made, a, platform=False)

    out = update_lut(lut.id, LutUpdate(group_id=personal.id), db=session, current_user=a)
    assert out.group_id == personal.id


def test_someone_elses_personal_group_is_still_unreachable(db):
    session, made = db
    from apps.api.routers.luts import create_lut_group, update_lut
    from apps.api.schemas.lut import LutGroupCreate, LutUpdate

    a = make_user(session, made, superadmin=True)
    b = make_user(session, made, superadmin=True)
    theirs = create_lut_group(LutGroupCreate(name="Theirs"), db=session, current_user=b)
    made["groups"].append(theirs.id)
    lut = make_lut(session, made, a, platform=False)

    # Sharing platform groups must not have opened up personal ones.
    with pytest.raises(HTTPException) as exc:
        update_lut(lut.id, LutUpdate(group_id=theirs.id), db=session, current_user=a)
    assert exc.value.status_code == 404
