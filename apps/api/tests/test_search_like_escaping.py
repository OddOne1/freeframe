"""§233 — `%` and `_` are search terms, not wildcards.

`routers/share.py` escaped its LIKE pattern. Four other sites built
`f"%{text}%"` straight from user input and did not:

    routers/me.py       GET /me/assets?q=      Asset.name
    routers/me.py       GET /me/folders?q=     Folder.name
    routers/metadata.py smart collections      Asset.name via filter_rules
    routers/users.py    GET /users/search?q=   first_name | last_name | email

In those four, a search for `%` matched every row the caller could see,
`_` matched any single character, and a `\\` could escape the next character
of somebody's own search term. SQLAlchemy still parameterises the string, so
this is not SQL injection — it is a filter that silently does not filter,
and on `/users/search` (min_length=1, callable by any authenticated user)
one character enumerated the directory.

Runs against a REAL Postgres, deliberately. The thing under test is what
the database does with a LIKE pattern and an ESCAPE clause; a mocked session
would assert that we called `ilike` with a string we chose, which is the
same mistake in test form. Each router function is called for real rather
than having its query rebuilt here, for the reason test_user_storage_default
gives: a copy keeps passing when the original changes.

    docker run -d --name ff-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55441:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \\
      pytest apps/api/tests/test_search_like_escaping.py
"""
import os
import uuid

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; what a "
           "LIKE pattern matches is not something a mock session can express",
)

#: The names planted for every search test. One row per interesting
#: character plus two ordinary ones, so "did the wildcard leak?" and "does
#: normal search still work?" are answered by the same fixture.
NAMES = [
    "plain report",          # no special characters
    "100% complete",         # a literal percent
    "snake_case name",       # a literal underscore
    "back\\slash name",      # a literal backslash
    "PLAIN SHOUTING",        # for the case-insensitivity check
]


@pytest.fixture
def db():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL, future=True)
    session = sessionmaker(bind=engine, future=True)()
    created = []
    try:
        yield session, created
    finally:
        session.rollback()
        for obj in reversed(created):
            try:
                session.delete(obj)
                session.commit()
            except Exception:
                session.rollback()
        session.close()


def _tag():
    """A per-test marker, so one run cannot see another run's rows."""
    return uuid.uuid4().hex[:10]


def _user(session, created, tag, **kw):
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    user = User(
        email=kw.pop("email", f"u-{tag}@example.com"),
        last_name=kw.pop("last_name", f"User {tag}"),
        status=UserStatus.active,
        role=kw.pop("role", UserGlobalRole.superadmin),
        **kw,
    )
    session.add(user)
    session.commit()
    created.append(user)
    return user


def _project(session, created, owner, tag):
    from apps.api.models.project import Project, ProjectMember, ProjectRole

    project = Project(name=f"Project {tag}", created_by=owner.id)
    session.add(project)
    session.commit()
    created.append(project)

    member = ProjectMember(
        project_id=project.id, user_id=owner.id, role=ProjectRole.owner
    )
    session.add(member)
    session.commit()
    created.append(member)
    return project


def _assets(session, created, project, owner, tag):
    from apps.api.models.asset import Asset, AssetType

    made = {}
    for name in NAMES:
        asset = Asset(
            project_id=project.id,
            name=f"{name} {tag}",
            asset_type=AssetType.image,
            created_by=owner.id,
        )
        session.add(asset)
        made[name] = asset
    session.commit()
    created.extend(made.values())
    return made


def _folders(session, created, project, owner, tag):
    from apps.api.models.folder import Folder

    made = {}
    for name in NAMES:
        folder = Folder(project_id=project.id, name=f"{name} {tag}", created_by=owner.id)
        session.add(folder)
        made[name] = folder
    session.commit()
    created.extend(made.values())
    return made


def _names(rows):
    return sorted(r.name for r in rows)


def _expect(tag, *names):
    return sorted(f"{n} {tag}" for n in names)


def _like_calls(source: str) -> list[str]:
    """Every `.like(...)` / `.ilike(...)` argument list in `source`.

    Balanced-paren scanning rather than a regex: these calls nest
    (`ilike(like_contains(q), escape=...)`) and a non-greedy regex stops at
    the first inner `)`, which made this check pass a site it should have
    failed.
    """
    calls = []
    for marker in (".ilike(", ".like("):
        start = source.find(marker)
        while start != -1:
            i = start + len(marker)
            depth = 1
            while i < len(source) and depth:
                if source[i] == "(":
                    depth += 1
                elif source[i] == ")":
                    depth -= 1
                i += 1
            calls.append(source[start + len(marker):i - 1])
            start = source.find(marker, i)
    return calls


# ── site 1: GET /me/assets?q= ────────────────────────────────────────────────

class TestAssetSearch:
    @pytest.fixture
    def fixture(self, db):
        session, created = db
        tag = _tag()
        owner = _user(session, created, tag)
        project = _project(session, created, owner, tag)
        _assets(session, created, project, owner, tag)
        return session, tag, owner

    def _search(self, session, owner, q):
        from unittest.mock import patch

        from apps.api.routers import me

        with patch.object(
            me, "_build_asset_responses_bulk", side_effect=lambda a, d, u: a
        ):
            return me.list_my_assets(
                filter="owned", processing=False, q=q, skip=0, limit=100,
                db=session, current_user=owner,
            )

    def test_percent_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert _names(self._search(session, owner, "%")) == _expect(tag, "100% complete")

    def test_underscore_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert _names(self._search(session, owner, "_")) == _expect(tag, "snake_case name")

    def test_a_backslash_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert _names(self._search(session, owner, "\\")) == _expect(tag, "back\\slash name")

    def test_an_ordinary_substring_still_works(self, fixture):
        session, tag, owner = fixture
        assert _names(self._search(session, owner, "plain")) == _expect(
            tag, "PLAIN SHOUTING", "plain report"
        )

    def test_it_is_still_case_insensitive(self, fixture):
        session, tag, owner = fixture
        assert _names(self._search(session, owner, "SHOUTING")) == _expect(
            tag, "PLAIN SHOUTING"
        )

    def test_a_term_that_matches_nothing_returns_nothing(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "%%%%") == []


# ── site 2: GET /me/folders?q= ───────────────────────────────────────────────

class TestFolderSearch:
    @pytest.fixture
    def fixture(self, db):
        session, created = db
        tag = _tag()
        owner = _user(session, created, tag)
        project = _project(session, created, owner, tag)
        _folders(session, created, project, owner, tag)
        return session, tag, owner

    def _search(self, session, owner, q):
        from apps.api.routers import me

        rows = me.search_my_folders(q=q, limit=50, db=session, current_user=owner)
        return sorted(r["name"] for r in rows)

    def test_percent_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "%") == _expect(tag, "100% complete")

    def test_underscore_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "_") == _expect(tag, "snake_case name")

    def test_a_backslash_is_a_literal(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "\\") == _expect(tag, "back\\slash name")

    def test_an_ordinary_substring_still_works(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "plain") == _expect(
            tag, "PLAIN SHOUTING", "plain report"
        )

    def test_it_is_still_case_insensitive(self, fixture):
        session, tag, owner = fixture
        assert self._search(session, owner, "sHoUtInG") == _expect(tag, "PLAIN SHOUTING")


# ── site 3: smart collections (routers/metadata.py) ──────────────────────────

class TestSmartCollectionNameContains:
    """`filter_rules` is a JSONB blob the caller PUTs, so it is user input.

    A rule of `{"name_contains": "%"}` made a "smart" collection holding
    every asset in the project — and `_collection_asset_count` reported
    that number on the collections list.
    """

    @pytest.fixture
    def fixture(self, db):
        session, created = db
        tag = _tag()
        owner = _user(session, created, tag)
        project = _project(session, created, owner, tag)
        _assets(session, created, project, owner, tag)
        return session, tag, project

    def _matched(self, session, project, term):
        from apps.api.routers.metadata import _apply_smart_filter

        rows = _apply_smart_filter(
            session, project.id, {"name_contains": term}
        ).all()
        return _names(rows)

    def test_percent_is_a_literal(self, fixture):
        session, tag, project = fixture
        assert self._matched(session, project, "%") == _expect(tag, "100% complete")

    def test_underscore_is_a_literal(self, fixture):
        session, tag, project = fixture
        assert self._matched(session, project, "_") == _expect(tag, "snake_case name")

    def test_a_backslash_is_a_literal(self, fixture):
        session, tag, project = fixture
        assert self._matched(session, project, "\\") == _expect(tag, "back\\slash name")

    def test_an_ordinary_substring_still_works(self, fixture):
        session, tag, project = fixture
        assert self._matched(session, project, "plain") == _expect(
            tag, "PLAIN SHOUTING", "plain report"
        )

    def test_the_count_shown_on_the_list_follows(self, fixture):
        """`_collection_asset_count` runs the same filter — same answer."""
        from apps.api.models.metadata import Collection
        from apps.api.routers.metadata import _collection_asset_count

        session, tag, project = fixture
        collection = Collection(
            project_id=project.id,
            name=f"Smart {tag}",
            filter_rules={"name_contains": "%"},
        )
        session.add(collection)
        session.flush()
        try:
            assert _collection_asset_count(session, collection) == 1
        finally:
            session.rollback()


# ── site 4: GET /users/search?q= ─────────────────────────────────────────────

class TestUserSearch:
    """The one that leaked the most: any authenticated caller, min_length=1."""

    @pytest.fixture
    def fixture(self, db):
        session, created = db
        tag = _tag()
        caller = _user(session, created, tag, email=f"caller-{tag}@example.com")
        made = {
            "percent": _user(
                session, created, tag,
                email=f"pct-{tag}@example.com", last_name=f"Hundred% {tag}",
            ),
            "underscore": _user(
                session, created, tag,
                email=f"und-{tag}@example.com", last_name=f"Snake_Case {tag}",
            ),
            "backslash": _user(
                session, created, tag,
                email=f"bsl-{tag}@example.com", last_name=f"Back\\Slash {tag}",
            ),
            "plain": _user(
                session, created, tag,
                email=f"pln-{tag}@example.com", last_name=f"Plainname {tag}",
            ),
        }
        return session, tag, caller, made

    def _search(self, session, caller, q):
        from apps.api.routers.users import search_users

        return search_users(q=q, db=session, current_user=caller)

    def test_percent_does_not_enumerate_the_directory(self, fixture):
        """The headline: one character used to hand back ten accounts."""
        session, tag, caller, made = fixture
        found = self._search(session, caller, "%")
        assert [u.id for u in found] == [made["percent"].id]

    def test_underscore_is_a_literal(self, fixture):
        session, tag, caller, made = fixture
        found = self._search(session, caller, "_")
        assert [u.id for u in found] == [made["underscore"].id]

    def test_a_backslash_is_a_literal(self, fixture):
        session, tag, caller, made = fixture
        found = self._search(session, caller, "\\")
        assert [u.id for u in found] == [made["backslash"].id]

    def test_an_ordinary_substring_still_works(self, fixture):
        session, tag, caller, made = fixture
        found = self._search(session, caller, f"Plainname {tag}")
        assert [u.id for u in found] == [made["plain"].id]

    def test_it_is_still_case_insensitive(self, fixture):
        session, tag, caller, made = fixture
        found = self._search(session, caller, f"pLaInNaMe {tag}")
        assert [u.id for u in found] == [made["plain"].id]

    def test_the_email_column_is_searched_the_same_way(self, fixture):
        session, tag, caller, made = fixture
        found = self._search(session, caller, f"pln-{tag}@example.com")
        assert [u.id for u in found] == [made["plain"].id]


# ── site 5: share-link titles, which already escaped ─────────────────────────

class TestShareLinkTitleSearch:
    """Not one of the four, and tested anyway.

    `share.py` is where the helper came from, so this is the regression
    test for the move: it now imports `services.search` and passes the
    `escape=` argument it previously left to PostgreSQL's default.
    """

    def test_percent_is_still_a_literal(self, db):
        from apps.api.models.share import ShareLink
        from apps.api.routers.share import list_project_share_links

        session, created = db
        tag = _tag()
        owner = _user(session, created, tag)
        project = _project(session, created, owner, tag)

        for title in ("100% done", "plain title"):
            link = ShareLink(
                project_id=project.id,
                token=uuid.uuid4().hex,
                title=f"{title} {tag}",
                created_by=owner.id,
            )
            session.add(link)
            created.append(link)
        session.commit()

        rows = list_project_share_links(
            project_id=project.id, search="%", db=session, current_user=owner
        )
        assert [r.title for r in rows] == [f"100% done {tag}"]


# ── the helper itself ────────────────────────────────────────────────────────

class TestTheHelper:
    """Cheap unit checks; they need no database but belong next to the rest."""

    def test_the_backslash_is_escaped_first(self):
        """Order matters, and getting it wrong is silent.

        Escaping `%` first would leave `\\%`, and doubling backslashes
        afterwards would turn it into `\\\\%` — a literal backslash followed
        by a wildcard, which is the bug in a different costume.
        """
        from apps.api.services.search import escape_like

        assert escape_like("\\") == "\\\\"
        assert escape_like("\\%") == "\\\\\\%"
        assert escape_like("100%") == "100\\%"
        assert escape_like("a_b") == "a\\_b"

    def test_ordinary_text_is_untouched(self):
        from apps.api.services.search import escape_like

        assert escape_like("plain report") == "plain report"

    def test_like_contains_wraps_the_escaped_text(self):
        from apps.api.services.search import like_contains

        assert like_contains("100%") == "%100\\%%"
        assert like_contains("") == "%%"

    def test_every_call_site_passes_the_escape_character(self):
        """One mechanism, used the same way everywhere.

        A site that escapes the string but omits `escape=` works on
        PostgreSQL by luck (its default IS backslash) and would be the
        easiest thing to copy wrongly into the next router.
        """
        from apps.api.services.search import LIKE_ESCAPE

        assert LIKE_ESCAPE == "\\"
        for path in (
            "apps/api/routers/me.py",
            "apps/api/routers/metadata.py",
            "apps/api/routers/users.py",
            "apps/api/routers/share.py",
        ):
            calls = _like_calls(open(path).read())
            assert calls, f"{path} has no LIKE call any more — update this test"
            for call in calls:
                assert "escape=LIKE_ESCAPE" in call, f"{path}: unescaped LIKE {call!r}"

    def test_no_router_builds_a_raw_percent_pattern(self):
        """The shape of the original bug, banned by grep."""
        import pathlib
        import re

        offenders = []
        for path in pathlib.Path("apps/api/routers").glob("*.py"):
            for line in path.read_text().splitlines():
                if re.search(r'f"%\{', line) or re.search(r"f'%\{", line):
                    offenders.append(f"{path}: {line.strip()}")
        assert not offenders, offenders
