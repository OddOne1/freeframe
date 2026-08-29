"""POST /assets/check-existing (CLAUDE.md §97 part A).

The desktop app asks this ONCE when resuming an upload job that died
mid-flight, with every asset id its journal recorded as uploaded. Anything
it does not get back is uploaded again.

So the property that matters is not "does it find assets" but the
opposite: that nothing a caller must not skip can come back. A deleted
asset, an unknown id, and another tenant's asset are all equally absent,
and none of them can be mistaken for permission to skip a file.

Real Postgres, because soft-delete and access filtering are database
questions -- a mock session cannot express either.

Skipped unless TEST_DATABASE_URL points at a migrated Postgres:

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_assets_check_existing.py
"""

import os
import uuid
from datetime import datetime, timezone

import pytest

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
    from apps.api.models.asset import Asset
    from apps.api.models.project import Project, ProjectMember
    from apps.api.models.user import User

    session = sessionmaker_()
    made = {"users": [], "projects": [], "assets": [], "members": []}
    try:
        yield session, made
    finally:
        session.rollback()
        for model, key in (
            (Asset, "assets"), (ProjectMember, "members"),
            (Project, "projects"), (User, "users"),
        ):
            if made[key]:
                session.query(model).filter(model.id.in_(made[key])).delete(
                    synchronize_session=False)
        session.commit()
        session.close()


def make_user(session, made):
    from apps.api.models.user import User, UserGlobalRole, UserStatus
    user = User(
        email=f"{uuid.uuid4().hex[:12]}@ffcheck.com",
        first_name="Case", last_name="Tester",
        status=UserStatus.active, role=UserGlobalRole.user,
    )
    session.add(user)
    session.commit()
    made["users"].append(user.id)
    return user


def make_project(session, made, owner):
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    project = Project(name=f"P{uuid.uuid4().hex[:8]}", created_by=owner.id)
    session.add(project)
    session.commit()
    made["projects"].append(project.id)
    member = ProjectMember(project_id=project.id, user_id=owner.id, role=ProjectRole.owner)
    session.add(member)
    session.commit()
    made["members"].append(member.id)
    return project


def make_asset(session, made, project, owner, deleted=False):
    from apps.api.models.asset import Asset, AssetType
    asset = Asset(
        project_id=project.id,
        name=f"clip-{uuid.uuid4().hex[:6]}.mov",
        asset_type=AssetType.video,
        created_by=owner.id,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )
    session.add(asset)
    session.commit()
    made["assets"].append(asset.id)
    return asset


def check(session, user, ids):
    from apps.api.routers.assets import check_existing_assets
    from apps.api.schemas.asset import CheckExistingRequest
    res = check_existing_assets(
        CheckExistingRequest(asset_ids=ids), db=session, current_user=user)
    return set(res.existing_ids)


def test_a_live_asset_comes_back(db):
    session, made = db
    user = make_user(session, made)
    project = make_project(session, made, user)
    asset = make_asset(session, made, project, user)
    assert check(session, user, [asset.id]) == {asset.id}


def test_a_soft_deleted_asset_does_not(db):
    """The case the whole endpoint exists for: the journal says this file
    uploaded, and it did -- but the asset is gone since. Skipping it would
    lose the file silently."""
    session, made = db
    user = make_user(session, made)
    project = make_project(session, made, user)
    gone = make_asset(session, made, project, user, deleted=True)
    assert check(session, user, [gone.id]) == set()


def test_an_unknown_id_does_not(db):
    session, made = db
    user = make_user(session, made)
    assert check(session, user, [uuid.uuid4()]) == set()


def test_someone_elses_asset_does_not(db):
    """Absent rather than an error, so a caller cannot use this to learn
    whether a uuid exists anywhere in the install -- and so the safe
    outcome (re-upload) is what a stranger's id produces."""
    session, made = db
    mine = make_user(session, made)
    theirs = make_user(session, made)
    their_project = make_project(session, made, theirs)
    their_asset = make_asset(session, made, their_project, theirs)
    assert check(session, mine, [their_asset.id]) == set()


def test_mixed_batch_returns_only_the_survivors(db):
    """One call, many ids -- the point of the endpoint. A resume must not
    make one request per file."""
    session, made = db
    user = make_user(session, made)
    project = make_project(session, made, user)
    live_a = make_asset(session, made, project, user)
    live_b = make_asset(session, made, project, user)
    gone = make_asset(session, made, project, user, deleted=True)
    unknown = uuid.uuid4()

    got = check(session, user, [live_a.id, gone.id, live_b.id, unknown])
    assert got == {live_a.id, live_b.id}


def test_empty_input_is_not_an_error(db):
    session, made = db
    user = make_user(session, made)
    assert check(session, user, []) == set()


def test_duplicate_ids_are_tolerated(db):
    """A journal that was itself resumed can name the same asset twice."""
    session, made = db
    user = make_user(session, made)
    project = make_project(session, made, user)
    asset = make_asset(session, made, project, user)
    assert check(session, user, [asset.id, asset.id, asset.id]) == {asset.id}
