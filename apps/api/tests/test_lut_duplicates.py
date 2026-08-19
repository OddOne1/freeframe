"""Duplicate LUT detection by content hash (CLAUDE.md §44).

The hash function is pure and tested directly; the scoping rules need real
Postgres, since "is there another row like this one" is the whole question.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres, except the
hash tests, which need nothing.
"""

import os
import uuid

import pytest
from fastapi import HTTPException

PG_URL = os.environ.get("TEST_DATABASE_URL")
needs_pg = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


def cube(size=2, entries=None, title="Untitled", domain_max="1.0 1.0 1.0"):
    rows = entries or ["0.0 0.0 0.0", "1.0 1.0 1.0"] * (size ** 3 // 2)
    return "\n".join([f'TITLE "{title}"', f"LUT_3D_SIZE {size}", f"DOMAIN_MAX {domain_max}", *rows])


# ─── the hash itself ─────────────────────────────────────────────────────────

def test_the_same_grade_hashes_the_same_despite_cosmetic_differences():
    from apps.api.routers.luts import _content_hash

    plain = cube(title="Kodak")
    noisy = "\r\n".join(
        [
            "# exported by another tool",
            'TITLE "Something Else"',
            "",
            "LUT_3D_SIZE 2",
            "DOMAIN_MAX 1.000000 1.000000 1.000000",
            "0.000000 0.0000000 0.0",
            "1.0 1.00000001 1.0",
            "0.0 0.0 0.0",
            "1.0 1.0 1.0",
            "0.0 0.0 0.0",
            "1.0 1.0 1.0",
            "0.0 0.0 0.0",
            "1.0 1.0 1.0",
        ]
    )
    # Different title, different comments, CRLF, different float spelling --
    # the same LUT. Hashing raw bytes would have called these different.
    assert _content_hash(plain) == _content_hash(noisy)


def test_a_different_grade_hashes_differently():
    from apps.api.routers.luts import _content_hash
    a = cube(entries=["0.0 0.0 0.0", "1.0 1.0 1.0"] * 4)
    b = cube(entries=["0.0 0.0 0.0", "0.5 1.0 1.0"] * 4)
    assert _content_hash(a) != _content_hash(b)


def test_the_domain_is_part_of_the_identity():
    from apps.api.routers.luts import _content_hash
    # Same entries, different input domain: genuinely different transforms.
    assert _content_hash(cube()) != _content_hash(cube(domain_max="2.0 2.0 2.0"))


# ─── scoping ─────────────────────────────────────────────────────────────────

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
            session.query(LutGroup).filter(LutGroup.id.in_(made["groups"])).delete(synchronize_session=False)
        if made["users"]:
            session.query(User).filter(User.id.in_(made["users"])).delete(synchronize_session=False)
        session.commit()
        session.close()


def make_user(session, made, superadmin=True):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    u = User(
        email=f"{uuid.uuid4().hex[:12]}@ffdupes.com", last_name="T",
        status=UserStatus.active,
        role=UserGlobalRole.superadmin if superadmin else UserGlobalRole.superuser,
    )
    session.add(u)
    session.commit()
    made["users"].append(u.id)
    return u


def make_lut(session, made, owner, text, *, name="A LUT", platform=False, group_id=None):
    from apps.api.models.lut import Lut
    from apps.api.routers.luts import _content_hash
    lut = Lut(
        owner_id=owner.id, name=name, s3_key=f"luts/{uuid.uuid4().hex}.cube",
        content_hash=_content_hash(text), is_platform_wide=platform, group_id=group_id,
    )
    session.add(lut)
    session.commit()
    made["luts"].append(lut.id)
    return lut


@needs_pg
def test_two_users_may_own_the_identical_file(db):
    session, made = db
    from apps.api.routers.luts import _find_owner_duplicate, _content_hash

    a = make_user(session, made)
    b = make_user(session, made)
    text = cube()
    make_lut(session, made, a, text)

    # Per-owner scope, decided with the user: b's upload is not a duplicate.
    assert _find_owner_duplicate(session, b.id, _content_hash(text)) is None
    assert _find_owner_duplicate(session, a.id, _content_hash(text)) is not None


@needs_pg
def test_a_platform_duplicate_is_found_across_owners(db):
    session, made = db
    from apps.api.routers.luts import _find_platform_duplicate, _content_hash

    a = make_user(session, made)
    text = cube()
    mine = make_lut(session, made, a, text, platform=True)

    found = _find_platform_duplicate(session, _content_hash(text))
    assert found is not None and found.id == mine.id
    # Excluding itself is what makes re-saving an already-platform LUT safe.
    assert _find_platform_duplicate(session, _content_hash(text), exclude_id=mine.id) is None


@needs_pg
def test_promoting_a_collision_is_rejected_and_says_where_it_lives(db):
    session, made = db
    from apps.api.models.lut import LutGroup
    from apps.api.routers.luts import update_lut
    from apps.api.schemas.lut import LutUpdate

    first_owner = make_user(session, made)
    group = LutGroup(owner_id=first_owner.id, name="House Looks", is_platform=True)
    session.add(group)
    session.commit()
    made["groups"].append(group.id)

    text = cube()
    make_lut(session, made, first_owner, text, name="Kodak 2383", platform=True, group_id=group.id)

    second_owner = make_user(session, made)
    theirs = make_lut(session, made, second_owner, text, name="My Copy")

    with pytest.raises(HTTPException) as exc:
        update_lut(theirs.id, LutUpdate(is_platform_wide=True), db=session, current_user=second_owner)
    assert exc.value.status_code == 409
    # Names it, and where it lives -- the explicit ask.
    assert "Kodak 2383" in exc.value.detail
    assert "House Looks" in exc.value.detail


@needs_pg
def test_promoting_a_unique_lut_still_works(db):
    session, made = db
    from apps.api.routers.luts import update_lut
    from apps.api.schemas.lut import LutUpdate

    admin = make_user(session, made)
    make_lut(session, made, admin, cube(), platform=True)
    other = make_lut(session, made, admin, cube(entries=["0.2 0.2 0.2", "0.9 0.9 0.9"] * 4))

    out = update_lut(other.id, LutUpdate(is_platform_wide=True), db=session, current_user=admin)
    assert out.is_platform_wide is True


@needs_pg
def test_re_saving_an_already_platform_lut_is_not_a_collision_with_itself(db):
    session, made = db
    from apps.api.routers.luts import update_lut
    from apps.api.schemas.lut import LutUpdate

    admin = make_user(session, made)
    lut = make_lut(session, made, admin, cube(), platform=True)
    # Sending is_platform_wide=True again must not trip on its own row.
    out = update_lut(lut.id, LutUpdate(is_platform_wide=True), db=session, current_user=admin)
    assert out.is_platform_wide is True


@needs_pg
def test_a_null_hash_neither_blocks_nor_is_blocked(db):
    session, made = db
    from apps.api.models.lut import Lut
    from apps.api.routers.luts import _find_owner_duplicate, _find_platform_duplicate, _content_hash

    owner = make_user(session, made)
    legacy = Lut(owner_id=owner.id, name="Pre-hash", s3_key=f"luts/{uuid.uuid4().hex}.cube")
    session.add(legacy)
    session.commit()
    made["luts"].append(legacy.id)

    # Rows from before this column existed are invisible to the check until
    # scripts/backfill_lut_hashes.py has run.
    assert _find_owner_duplicate(session, owner.id, _content_hash(cube())) is None
    assert _find_platform_duplicate(session, _content_hash(cube())) is None
