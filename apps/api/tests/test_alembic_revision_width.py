"""A revision id has to fit in the column Alembic records it in (§222).

Alembic creates `alembic_version.version_num` as VARCHAR(32) and writes a
revision's id into it immediately after that revision's `upgrade()` returns.
`add_version_processing_started_at` is 33 characters. On the live server the
chain therefore crashed the api with

    value too long for type character varying(32)

and was recovered by running `ALTER TABLE alembic_version ALTER COLUMN
version_num TYPE VARCHAR(64)` by hand. Production is stamped at that
revision, so the id cannot be renamed; the migration now widens the column
itself, before it does anything else.

Two further ids (`add_lut_groups_and_platform_wide`,
`add_transcription_to_media_files`) are exactly 32 characters, so this was
not one unlucky name — the limit was already touching, and the next
descriptive slug was going to hit it either way.

Both checks here are deliberately structural rather than a note in a
docstring. The second one WALKS THE CHAIN: an id longer than Alembic's
default width is only legal if the migration that records it, or one of its
ancestors, has already widened the column — which is a property of the
revision graph, not of a comment.

Stdlib-only and import-free, like test_celery_wiring.py: these parse the
migration files, so they run identically in the container, in CI, and on a
laptop with no Alembic, no Postgres and no database at all.
"""

import ast
import re
from pathlib import Path

API = Path(__file__).resolve().parents[1]
VERSIONS = API / "alembic" / "versions"

#: Alembic's own default width for `alembic_version.version_num`. An id
#: longer than this needs the column widened first, or it cannot be recorded.
DEFAULT_VERSION_NUM_WIDTH = 32

#: The width the chain widens to. Read from the migration that does it, not
#: repeated here, so the two cannot disagree.
WIDENING_MIGRATION = VERSIONS / "add_version_processing_started_at.py"


def _widened_width() -> int:
    m = re.search(
        r"_WIDENED_VERSION_NUM_WIDTH\s*=\s*(\d+)", WIDENING_MIGRATION.read_text()
    )
    assert m, f"{WIDENING_MIGRATION.name} no longer declares the widened width"
    return int(m.group(1))


def _revisions() -> dict:
    """{revision id -> (filename, [down_revisions], source)} for the chain.

    `down_revision` may be None (the base) or a TUPLE of parents (a merge
    point — this chain has one, 91065b39168e). Both are flattened to a list,
    because a check that quietly mishandled the merge would stop walking
    halfway up the graph and pass for the wrong reason.
    """
    out = {}
    for path in sorted(VERSIONS.glob("*.py")):
        src = path.read_text()
        rev = re.search(r"^revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        if not rev:
            continue
        rid = rev.group(1).strip().strip("\"'")
        down = re.search(r"^down_revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        parents = re.findall(r"[\"']([^\"']+)[\"']", down.group(1)) if down else []
        out[rid] = (path.name, parents, src)
    return out


def _ancestors_inclusive(rid: str, revisions: dict) -> set:
    """Every revision applied no later than `rid`, including `rid` itself."""
    seen, stack = set(), [rid]
    while stack:
        current = stack.pop()
        if current in seen or current not in revisions:
            continue
        seen.add(current)
        stack.extend(revisions[current][1])
    return seen


def _widens_to(src: str) -> int:
    """The width this migration widens version_num to, or 0 if it does not.

    Matched on the ALTER itself rather than on any mention of the table, so a
    migration that merely talks about the column in a comment does not count
    as having widened it.
    """
    if "alembic_version" not in src:
        return 0
    found = re.findall(
        r"ALTER\s+TABLE\s+alembic_version\s+ALTER\s+COLUMN\s+version_num\s+"
        r"TYPE\s+VARCHAR\(\s*(\{?[A-Za-z_][\w]*\}?|\d+)\s*\)",
        src, re.I | re.S,
    )
    widths = []
    for raw in found:
        if raw.isdigit():
            widths.append(int(raw))
            continue
        # An f-string placeholder, e.g. VARCHAR({_WIDENED_VERSION_NUM_WIDTH}).
        # Resolved from the module constant in the SAME file, so a migration
        # written with a named width still counts as a widening -- and so
        # that lowering that constant lowers what this check believes.
        name = raw.strip("{}")
        const = re.search(rf"^{re.escape(name)}\s*=\s*(\d+)", src, re.M)
        if const:
            widths.append(int(const.group(1)))
    if not widths:
        return 0
    return max(widths)


# ── the fixtures that guard the fixtures ───────────────────────────────────


def test_the_scan_finds_the_chain():
    """If the glob or the regex broke, every assertion below would pass
    against nothing at all."""
    revisions = _revisions()
    assert len(revisions) >= 60, f"only parsed {len(revisions)} revisions"
    assert "add_version_processing_started_at" in revisions


def test_every_down_revision_names_a_revision_that_exists():
    """Chain integrity, and a precondition for the ancestor walk: a dangling
    parent would silently truncate it."""
    revisions = _revisions()
    dangling = {
        rid: [p for p in parents if p not in revisions]
        for rid, (_f, parents, _s) in revisions.items()
    }
    dangling = {k: v for k, v in dangling.items() if v}
    assert not dangling, f"down_revision(s) naming nothing: {dangling}"


def test_the_merge_point_is_still_walked_as_two_parents():
    """The one merge revision in this chain. If the parser flattened it to a
    single string, `_ancestors_inclusive` would miss a whole branch."""
    revisions = _revisions()
    merges = {
        rid: parents for rid, (_f, parents, _s) in revisions.items()
        if len(parents) > 1
    }
    assert merges, "no merge point found; the tuple down_revision parsing is untested"
    for rid, parents in merges.items():
        assert all(p in revisions for p in parents), f"{rid}: {parents}"


# ── check 1: nothing may exceed the widened column ─────────────────────────


def test_no_revision_id_or_down_revision_exceeds_the_column():
    """THE bound. One character over and the migration cannot be recorded,
    which fails as an api crash loop on deploy rather than as a bad migration.

    The limit is derived from the width the chain actually widens to, minus
    one character of margin, rather than written here as a number — so
    raising the column raises the allowance in one place.
    """
    limit = _widened_width() - 1
    assert limit == 63, f"expected a 63-character allowance, computed {limit}"

    revisions = _revisions()
    too_long = {}
    for rid, (filename, parents, _src) in revisions.items():
        if len(rid) > limit:
            too_long[f"{filename}: revision"] = f"{rid} ({len(rid)} chars)"
        for parent in parents:
            if len(parent) > limit:
                too_long[f"{filename}: down_revision"] = f"{parent} ({len(parent)} chars)"
    assert not too_long, (
        f"revision id(s) longer than the {limit}-character allowance: "
        f"{too_long}. alembic_version.version_num is VARCHAR({_widened_width()})."
    )


# ── check 2: an over-default id requires the widening, by the graph ────────


def test_an_over_default_id_is_only_legal_because_an_ancestor_widens_the_column():
    """The real check, not a comment.

    Any id longer than Alembic's own VARCHAR(32) is recordable only if the
    column was already widened by the time that revision is stamped — i.e. by
    that revision itself or by one of its ancestors. This walks the graph and
    says so; it is what makes the 33-character id a deliberate, supported
    thing rather than a crash waiting for the next fresh install.
    """
    revisions = _revisions()
    widened_by = {
        rid: _widens_to(src)
        for rid, (_f, _p, src) in revisions.items()
        if _widens_to(src)
    }
    assert widened_by, (
        "no migration widens alembic_version.version_num at all, so no id "
        "may exceed 32 characters"
    )

    long_ids = {
        rid: len(rid) for rid in revisions
        if len(rid) > DEFAULT_VERSION_NUM_WIDTH
    }
    # Non-vacuous on purpose: this chain HAS such an id, and production is
    # stamped at it. If this ever fires, the id was renamed -- which orphans
    # the live database -- not merely shortened.
    assert long_ids, (
        "expected at least one revision id over 32 characters "
        "(add_version_processing_started_at); has it been renamed?"
    )

    unsupported = {}
    for rid, length in long_ids.items():
        ancestors = _ancestors_inclusive(rid, revisions)
        covering = [
            other for other, width in widened_by.items()
            if other in ancestors and width >= length
        ]
        if not covering:
            unsupported[rid] = (
                f"{length} chars, and no ancestor widens version_num to >= {length}"
            )
    assert not unsupported, (
        f"revision id(s) too long for the column at the moment they are "
        f"stamped: {unsupported}"
    )


def test_the_widening_runs_before_the_rest_of_its_own_upgrade():
    """Order inside `upgrade()` matters for the migration that carries the
    over-length id: Alembic records the id after `upgrade()` returns, so the
    ALTER has to precede anything that could fail and abort the transaction
    before it runs."""
    tree = ast.parse(WIDENING_MIGRATION.read_text())
    upgrade = next(
        n for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "upgrade"
    )
    body = [ast.unparse(stmt) for stmt in upgrade.body]
    alter_at = next(
        (i for i, stmt in enumerate(body) if "alembic_version" in stmt), None
    )
    assert alter_at is not None, "upgrade() no longer widens the column"
    other_ops = [
        i for i, stmt in enumerate(body)
        if "op." in stmt and "alembic_version" not in stmt
    ]
    assert other_ops, "upgrade() does nothing else; this check is vacuous"
    assert alter_at < min(other_ops), (
        "the widening must come first in upgrade(); it is the precondition "
        "for this revision being recordable at all"
    )


def test_the_widening_is_guarded_so_it_is_idempotent():
    """Production already ran the ALTER by hand, and this revision is already
    stamped there — but a re-run, a restore, or a database someone widened
    further must not be narrowed or error."""
    src = WIDENING_MIGRATION.read_text()
    assert "information_schema.columns" in src, (
        "the widening is unconditional; it would NARROW a column that someone "
        "has made wider than 64"
    )
    assert "character_maximum_length" in src
    assert re.search(r"character_maximum_length\s*<\s*\{?_?WIDENED", src) or \
        re.search(r"character_maximum_length\s*<\s*\d+", src), (
            "the guard does not compare the current width"
        )
    assert "character_maximum_length IS NOT NULL" in src, (
        "an unbounded text column reports NULL here and must be left alone"
    )


def test_the_default_width_the_test_assumes_matches_the_migration():
    """Two copies of 32 that could drift."""
    src = WIDENING_MIGRATION.read_text()
    m = re.search(r"_DEFAULT_VERSION_NUM_WIDTH\s*=\s*(\d+)", src)
    assert m, "the migration no longer records Alembic's default width"
    assert int(m.group(1)) == DEFAULT_VERSION_NUM_WIDTH


def test_the_downgrade_does_not_narrow_the_column_back():
    """Narrowing is only safe if no stamped id needs the width — and this
    revision's own id does, so a downgrade that narrowed would have to decide
    what to do about the row recording it."""
    tree = ast.parse(WIDENING_MIGRATION.read_text())
    downgrade = next(
        n for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name == "downgrade"
    )
    rendered = ast.unparse(downgrade)
    assert "alembic_version" not in rendered, (
        "downgrade() touches alembic_version; narrowing it back would break "
        "the row that records this very revision"
    )


def test_how_close_the_rest_of_the_chain_sits_to_the_old_limit():
    """Documents the finding rather than guarding anything: two ids are at
    exactly 32, so VARCHAR(32) was one character from failing regardless of
    which migration was written next."""
    revisions = _revisions()
    at_the_old_limit = sorted(
        rid for rid in revisions if len(rid) == DEFAULT_VERSION_NUM_WIDTH
    )
    assert at_the_old_limit == [
        "add_lut_groups_and_platform_wide",
        "add_transcription_to_media_files",
    ], (
        f"the set of ids sitting exactly on Alembic's 32-character default "
        f"has changed: {at_the_old_limit}"
    )


if __name__ == "__main__":
    # Runnable without pytest, like test_celery_wiring.py: this file needs no
    # Alembic, no Postgres and no application imports, so it should be usable
    # anywhere the repo is checked out.
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL  {name}: {exc}")
    print("\nOK" if not failures else f"\n{failures} FAILED")
    raise SystemExit(1 if failures else 0)
