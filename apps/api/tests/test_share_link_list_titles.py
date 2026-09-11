"""A custom share-link title must survive the union_all (CLAUDE.md §147).

Runs against a REAL Postgres, deliberately. The bug was a duplicate column
in a compound SELECT: `project_query` selected `ShareLink.title` twice --
once plainly and once as `.label("target_name")`. Under the union's column
keying the two collapsed into one, so `row.title` resolved to the
*target_name* position for EVERY branch of the union, not just the project
one. A folder share with the title "Client review" came back as "Files".

A MagicMock session cannot express that at all -- it returns whatever rows
the test hands it, with no compound select and no column keying -- which is
precisely why the existing share-link tests stayed green while the HTTP
response was wrong in production.

`require_project_role` is stubbed: the permission gate is not what is under
test here and is covered elsewhere. Everything else is the real router
running the real query against the real schema.

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_share_link_list_titles.py
"""

import os
import uuid

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a compound "
           "SELECT's column keying is not something a mock session can express",
)


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db(sessionmaker_):
    """Yields a session plus the project id everything in a test hangs off.

    Teardown deletes only rows reachable from that one project. This database
    may be a scratch copy of a real one; nothing here truncates a table.
    """
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.share import ShareLink

    session = sessionmaker_()
    project = Project(name="Union Fix Test %s" % uuid.uuid4().hex[:8])
    session.add(project)
    session.commit()
    try:
        yield session, project
    finally:
        session.rollback()
        session.query(ShareLink).filter(
            ShareLink.project_id == project.id
        ).delete(synchronize_session=False)
        folder_ids = [f.id for f in session.query(Folder).filter(Folder.project_id == project.id)]
        if folder_ids:
            session.query(ShareLink).filter(
                ShareLink.folder_id.in_(folder_ids)
            ).delete(synchronize_session=False)
            session.query(Folder).filter(
                Folder.id.in_(folder_ids)
            ).delete(synchronize_session=False)
        session.query(Project).filter(Project.id == project.id).delete(synchronize_session=False)
        session.commit()
        session.close()


@pytest.fixture(autouse=True)
def allow_the_project(monkeypatch):
    from apps.api.routers import share as share_router
    monkeypatch.setattr(share_router, "require_project_role", lambda *a, **k: None)


def listing(session, project):
    from apps.api.routers.share import list_project_share_links
    # search= explicitly: called directly, FastAPI's Query(default=None)
    # arrives as a Query object rather than None.
    rows = list_project_share_links(project.id, search=None, db=session, current_user=None)
    return {r.token: r for r in rows}


def make_link(session, *, token, title, folder_id=None, project_id=None):
    from apps.api.models.share import ShareLink
    link = ShareLink(
        token=token,
        title=title,
        folder_id=folder_id,
        project_id=project_id,
    )
    session.add(link)
    session.commit()
    return link


def test_custom_titles_survive_the_union(db):
    """The headline regression: a folder link's own title, not its target's.

    Both branches are present at once on purpose. The bug only appeared in a
    compound select, so a test with a single share link -- or with only one
    KIND of share link -- reproduces nothing.
    """
    from apps.api.models.folder import Folder

    session, project = db
    folder = Folder(project_id=project.id, name="Files")
    session.add(folder)
    session.commit()

    make_link(session, token="tok-folder", title="Client review", folder_id=folder.id)
    make_link(session, token="tok-project", title="Everything, dailies", project_id=project.id)

    rows = listing(session, project)

    # The folder link kept its own title and did not inherit the folder's name.
    assert rows["tok-folder"].title == "Client review"
    assert rows["tok-folder"].title != folder.name
    assert rows["tok-folder"].target_name == "Files"

    # The project link kept its title, and its target is the PROJECT's name --
    # which is what the duplicated column was standing in for.
    assert rows["tok-project"].title == "Everything, dailies"
    assert rows["tok-project"].target_name == project.name
    assert rows["tok-project"].target_name != "Everything, dailies"


def test_project_target_name_is_not_the_link_title(db):
    """Pins the fix itself, in the one case where the old code looked right.

    With the old query a project link's `target_name` echoed its own title, so
    a link titled exactly after its project passed by coincidence. Naming the
    two differently is what makes the assertion mean anything.
    """
    session, project = db
    make_link(session, token="tok-only", title="Not the project name", project_id=project.id)

    row = listing(session, project)["tok-only"]
    assert row.title == "Not the project name"
    assert row.target_name == project.name


def test_an_empty_title_still_reports_the_real_target(db):
    """A link with no title set must not silently acquire its target's name.

    `title` is NOT NULL with a "" server default, so the empty string is a real
    state the UI renders a fallback for. If it came back pre-filled with the
    project name, that fallback would never run and the two cases would be
    indistinguishable.
    """
    session, project = db
    make_link(session, token="tok-untitled", title="", project_id=project.id)

    row = listing(session, project)["tok-untitled"]
    assert row.title == ""
    assert row.target_name == project.name
