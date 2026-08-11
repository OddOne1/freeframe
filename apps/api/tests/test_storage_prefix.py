"""Human-readable S3 key prefixes (CLAUDE.md §14).

Slug generation, validation, uniqueness, and the lock-on-first-upload.
Purge's awareness of the two coexisting formats lives in test_purge.py,
next to the rest of the deletion coverage.

Real database, not mocks: uniqueness is a DB constraint and the lock is a
row-locked read-modify-write, neither of which a MagicMock session can
get wrong or right.
"""
import uuid

import pytest


@pytest.fixture
def db():
    pytest.importorskip("sqlalchemy")
    from sqlalchemy import create_engine
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import sessionmaker

    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _project(db, name, slug=None, date_prefix=None):
    from apps.api.models.project import Project, ProjectType

    p = Project(
        id=uuid.uuid4(), name=name, project_type=ProjectType.personal,
        storage_slug=slug, storage_date_prefix=date_prefix,
    )
    db.add(p)
    db.commit()
    return p


# ── Slugify ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,expected", [
    ("Just Ride 2026", "just_ride_2026"),
    ("TEST FOTO", "test_foto"),
    ("Beach — B-Cam!", "beach_b_cam"),
    ("  leading and trailing  ", "leading_and_trailing"),
    ("multiple___separators", "multiple_separators"),
    ("Ünïcödé Nàme", "n_c_d_n_me"),
    ("2026", "2026"),
])
def test_slugify(name, expected):
    from apps.api.services.storage_prefix import slugify
    assert slugify(name) == expected


def test_slugify_never_returns_empty():
    """A name of pure punctuation must still yield a usable slug — the
    project id in the prefix disambiguates anyway, and failing an upload
    over an unusual project name would be indefensible."""
    from apps.api.services.storage_prefix import slugify
    assert slugify("!!! ???") == "project"
    assert slugify("") == "project"


def test_slugify_respects_the_length_cap():
    from apps.api.services.storage_prefix import MAX_SLUG_LENGTH, slugify
    out = slugify("a" * 200)
    assert len(out) <= MAX_SLUG_LENGTH
    assert not out.endswith("_")


# ── Validation ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", [
    "", "  ", "Has Spaces", "trailing_", "_leading",
    "double__underscore", "punctuation!", "a" * 41,
])
def test_validate_rejects(bad):
    from apps.api.services.storage_prefix import validate_slug
    with pytest.raises(ValueError):
        validate_slug(bad)


@pytest.mark.parametrize("good", ["beach", "just_ride_2026", "a", "a_b_c", "2026_shoot"])
def test_validate_accepts(good):
    from apps.api.services.storage_prefix import validate_slug
    assert validate_slug(good) == good


@pytest.mark.parametrize("typed,stored", [
    ("BEACH", "beach"),
    ("Just_Ride_2026", "just_ride_2026"),
    ("  beach  ", "beach"),
])
def test_case_and_padding_are_normalised_but_structure_is_not(typed, stored):
    """Case is lowercased because the field is lowercase by definition and
    nobody is surprised by that. Spaces and punctuation are REJECTED rather
    than rewritten -- silently turning "Beach Shoot" into "beach_shoot"
    changes what they'll see in the bucket."""
    from apps.api.services.storage_prefix import validate_slug
    assert validate_slug(typed) == stored


# ── Uniqueness ───────────────────────────────────────────────────────────

def test_two_projects_that_slugify_identically_get_distinct_slugs(db):
    """The stated acceptance check. Auto-generated slugs DE-DUPLICATE
    rather than rejecting: this runs inside someone's first upload, and
    failing it because an unrelated project has a similar name would be
    indefensible."""
    from apps.api.services.storage_prefix import lock_storage_prefix

    a = _project(db, "Beach Shoot")
    b = _project(db, "beach shoot")      # slugifies identically
    c = _project(db, "BEACH  SHOOT!!")   # and again

    lock_storage_prefix(db, a.id); db.commit()
    lock_storage_prefix(db, b.id); db.commit()
    lock_storage_prefix(db, c.id); db.commit()

    slugs = [db.get(type(a), p.id).storage_slug for p in (a, b, c)]
    assert slugs[0] == "beach_shoot"
    assert len(set(slugs)) == 3, f"slugs collided: {slugs}"


def test_a_hand_typed_duplicate_slug_is_refused(db):
    """The other half of that decision: a slug someone typed is rejected
    rather than silently renamed. Turning their `beach` into `beach_2`
    without saying so would be worse than an error."""
    from apps.api.services.storage_prefix import SlugUnavailable, claim_user_slug

    _project(db, "First", slug="beach")
    other = _project(db, "Second")

    with pytest.raises(SlugUnavailable):
        claim_user_slug(db, other, "beach")


def test_a_project_may_re_claim_its_own_slug(db):
    from apps.api.services.storage_prefix import claim_user_slug
    p = _project(db, "First", slug="beach")
    assert claim_user_slug(db, p, "beach") == "beach"


def test_the_database_itself_rejects_a_duplicate(db):
    """Not just the service layer. The app-side check is a read-then-write
    and loses a concurrent race; the constraint is what actually holds."""
    from sqlalchemy.exc import IntegrityError

    _project(db, "First", slug="beach")
    with pytest.raises(IntegrityError):
        _project(db, "Second", slug="beach")


# ── Locking ──────────────────────────────────────────────────────────────

def test_first_upload_locks_slug_and_date(db):
    from datetime import datetime, timezone
    from apps.api.services.storage_prefix import is_locked, lock_storage_prefix

    p = _project(db, "Just Ride 2026")
    assert not is_locked(p)

    when = datetime(2026, 8, 11, tzinfo=timezone.utc)
    locked = lock_storage_prefix(db, p.id, now=when)
    db.commit()

    assert locked.storage_slug == "just_ride_2026"
    assert locked.storage_date_prefix == "260811"
    assert is_locked(locked)


def test_a_slug_chosen_before_upload_is_kept(db):
    """Locking assigns a date; it must not overwrite a slug the user
    deliberately set beforehand."""
    from apps.api.services.storage_prefix import lock_storage_prefix

    p = _project(db, "Just Ride 2026", slug="my_own_choice")
    lock_storage_prefix(db, p.id)
    db.commit()

    assert db.get(type(p), p.id).storage_slug == "my_own_choice"


def test_locking_is_idempotent(db):
    """The second and thousandth upload must reuse the frozen values, not
    re-derive them — a date that moved would split one project across two
    prefixes."""
    from datetime import datetime, timezone
    from apps.api.services.storage_prefix import lock_storage_prefix

    p = _project(db, "Beach")
    first = lock_storage_prefix(db, p.id, now=datetime(2026, 8, 11, tzinfo=timezone.utc))
    db.commit()
    slug, date_prefix = first.storage_slug, first.storage_date_prefix

    # A month later, same project.
    again = lock_storage_prefix(db, p.id, now=datetime(2026, 9, 20, tzinfo=timezone.utc))
    db.commit()

    assert (again.storage_slug, again.storage_date_prefix) == (slug, date_prefix)


def test_the_date_is_the_lock_sentinel_not_the_slug(db):
    """A slug set by hand pre-upload must NOT read as locked, or the user
    could never correct their own typo before uploading."""
    from apps.api.services.storage_prefix import is_locked

    assert not is_locked(_project(db, "A", slug="chosen_early"))
    assert is_locked(_project(db, "B", slug="s", date_prefix="260811"))


# ── Building and reading prefixes ────────────────────────────────────────

def test_prefix_falls_back_to_the_bare_id_before_locking(db):
    from apps.api.services.storage_prefix import prefix_for_project
    p = _project(db, "Beach")
    assert prefix_for_project(p) == str(p.id)


def test_prefix_once_locked(db):
    from apps.api.services.storage_prefix import prefix_for_project
    p = _project(db, "Beach", slug="beach", date_prefix="260811")
    assert prefix_for_project(p) == f"260811_beach_{p.id}"


def test_both_formats_end_with_the_project_id(db):
    """Deliberate: it keeps the prefix unique even if two slugs ever
    collided, and means nothing downstream has to guess which format it is
    looking at."""
    from apps.api.services.storage_prefix import prefix_for_project
    unlocked = _project(db, "A")
    locked = _project(db, "B", slug="b", date_prefix="260811")
    assert prefix_for_project(unlocked).endswith(str(unlocked.id))
    assert prefix_for_project(locked).endswith(str(locked.id))


@pytest.mark.parametrize("key,expected", [
    ("raw/abc-123/asset/version/original.mov", "abc-123"),
    ("processed/260811_beach_abc-123/asset/version/hls", "260811_beach_abc-123"),
    ("sidecars/260811_beach_abc-123/asset/x.cdl", "260811_beach_abc-123"),
    ("comment-attachments/cid/x/a.png", None),   # not an asset-storage area
    ("", None),
    (None, None),
    ("raw", None),
])
def test_project_prefix_of_key(key, expected):
    from apps.api.services.storage_prefix import project_prefix_of_key
    assert project_prefix_of_key(key) == expected
