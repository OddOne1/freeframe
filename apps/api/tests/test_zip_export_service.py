"""Cache keying, variant fallback and archive paths for zip downloads (§143).

Pure-function tests with no DB, worker or S3, because these three are where
the feature is actually decided:

  * the cache key defines when a viewer gets a stale archive;
  * the fallback defines what someone receives when their chosen variant is
    impossible for one file in a batch;
  * the path builder defines whether a zip can write outside its own folder.
"""
import pytest

from apps.api.models.share import DownloadVariant as DV
from apps.api.services.zip_export_service import (
    ResolvedFile,
    ResolvedSelection,
    available_variants_for,
    compute_cache_key,
    resolve_variant,
    zip_entry_path,
    zip_object_key,
    ZIP_PREFIX,
)

ALL = [v.value for v in DV]


def _sel(*files):
    return ResolvedSelection(files=list(files))


def _f(path="a.mov", asset="A", version="V", variant=DV.raw.value, lut=None):
    return ResolvedFile(asset_id=asset, version_id=version, path=path, variant=variant, applied_lut_id=lut)


# ── cache key: what counts as "the same selection" ───────────────────────

def test_same_selection_same_key_regardless_of_order():
    a, b = _f("one.mov", "A", "V1"), _f("two.mov", "B", "V2")
    assert compute_cache_key("link1", _sel(a, b)) == compute_cache_key("link1", _sel(b, a))


def test_different_scope_never_shares_an_archive():
    """A share link and an in-app download must not reuse each other's zip.

    They can legitimately contain the same files while being subject to
    different permissions, so the scope is part of identity.
    """
    f = _f()
    assert compute_cache_key("link1", _sel(f)) != compute_cache_key("link2", _sel(f))


@pytest.mark.parametrize("field,changed", [
    ("path", _f(path="renamed.mov")),
    ("version", _f(version="V2")),
    ("variant", _f(variant=DV.proxy_720p.value)),
])
def test_changing_any_identity_field_invalidates(field, changed):
    assert compute_cache_key("link1", _sel(_f())) != compute_cache_key("link1", _sel(changed))


def test_renaming_a_file_invalidates_even_though_every_id_is_unchanged():
    """The non-obvious half of the key, called out because it is easy to drop.

    A key built from ids alone looks complete and would serve the old tree
    forever after a rename or a move.
    """
    before = _f(path="Dailies/clip.mov", asset="A", version="V")
    after = _f(path="Dailies/renamed.mov", asset="A", version="V")
    assert before.asset_id == after.asset_id and before.version_id == after.version_id
    assert compute_cache_key("l", _sel(before)) != compute_cache_key("l", _sel(after))


def test_regrading_invalidates_a_lut_variant_but_not_a_plain_one():
    """Re-grading changes a *_lut export's bytes without changing its version.

    It must NOT invalidate a plain export, or every re-grade would force
    unrelated rebuilds.
    """
    lut_a = _f(variant=DV.raw_lut.value, lut="LUT-A")
    lut_b = _f(variant=DV.raw_lut.value, lut="LUT-B")
    assert compute_cache_key("l", _sel(lut_a)) != compute_cache_key("l", _sel(lut_b))

    plain_a = _f(variant=DV.raw.value, lut="LUT-A")
    plain_b = _f(variant=DV.raw.value, lut="LUT-B")
    assert compute_cache_key("l", _sel(plain_a)) == compute_cache_key("l", _sel(plain_b))


def test_adding_or_removing_a_file_invalidates():
    one = _sel(_f("a.mov", "A", "V"))
    two = _sel(_f("a.mov", "A", "V"), _f("b.mov", "B", "V"))
    assert compute_cache_key("l", one) != compute_cache_key("l", two)


def test_key_is_a_stable_hex_digest():
    k = compute_cache_key("l", _sel(_f()))
    assert len(k) == 64 and all(c in "0123456789abcdef" for c in k)
    assert k == compute_cache_key("l", _sel(_f()))  # deterministic across calls


# ── variant fallback ─────────────────────────────────────────────────────

def test_requested_variant_is_used_when_available():
    got, why = resolve_variant(DV.proxy_720p.value, ALL, is_video=True)
    assert (got, why) == (DV.proxy_720p.value, None)


def test_lut_requested_but_asset_has_no_lut_falls_back_to_the_same_rung():
    """The headline case from the brief, and the fallback is same-quality.

    Dropping to `raw` here would hand someone a full-size original when
    they asked for a 720p proxy — a fallback should not silently upgrade
    the file size.
    """
    available = [DV.raw.value, DV.proxy_720p.value]  # no *_lut: asset has no LUT
    got, why = resolve_variant(DV.proxy_720p_lut.value, available, is_video=True)
    assert got == DV.proxy_720p.value
    assert "no LUT" in why


def test_lut_requested_with_only_raw_allowed_falls_back_to_raw_with_a_reason():
    got, why = resolve_variant(DV.raw_lut.value, [DV.raw.value], is_video=True)
    assert got == DV.raw.value
    assert why and "LUT" in why


def test_an_image_in_a_mixed_batch_gets_the_original_not_a_failure():
    """A still cannot be proxied or LUT-burned; the batch must not fail."""
    got, why = resolve_variant(DV.proxy_1080p_lut.value, ALL, is_video=False)
    assert got == DV.raw.value
    assert "not a video" in why


def test_fallback_never_silently_upgrades_to_a_larger_file():
    # Only the two 720p options exist; asking for 1080p must not yield raw.
    available = [DV.proxy_720p.value, DV.proxy_720p_lut.value]
    got, _ = resolve_variant(DV.proxy_1080p.value, available, is_video=True)
    assert got == DV.proxy_720p.value


def test_no_allowed_variants_is_refused_rather_than_guessed():
    got, why = resolve_variant(DV.raw.value, [], is_video=True)
    assert got == ""
    assert why


def test_honoured_request_carries_no_note():
    """A note shown when nothing was substituted would train people to ignore it."""
    for v in ALL:
        got, why = resolve_variant(v, ALL, is_video=True)
        assert got == v and why is None


# ── availability rule (shared with the single-item download gate) ─────────

class _Asset:
    def __init__(self, lut=None):
        self.applied_lut_id = lut


def test_lut_variants_are_hidden_on_an_asset_without_a_lut():
    assert available_variants_for(ALL, _Asset(lut=None)) == [
        v for v in ALL if not v.endswith("_lut")
    ]
    assert available_variants_for(ALL, _Asset(lut="x")) == ALL


def test_an_empty_permission_list_means_nothing_is_downloadable():
    assert available_variants_for([], _Asset(lut="x")) == []


# ── archive paths ────────────────────────────────────────────────────────

def test_folder_tree_is_preserved():
    taken = set()
    assert zip_entry_path(["Dailies", "Cam A"], "clip.mov", taken) == "Dailies/Cam A/clip.mov"


def test_root_level_files_have_no_folder_prefix():
    assert zip_entry_path([], "clip.mov", set()) == "clip.mov"


def test_duplicate_paths_are_suffixed_not_overwritten():
    """Two versions of one asset can legitimately share a name and folder.

    Overwriting inside the zip would silently drop a file the user picked.
    """
    taken = set()
    a = zip_entry_path(["F"], "clip.mov", taken)
    b = zip_entry_path(["F"], "clip.mov", taken)
    c = zip_entry_path(["F"], "clip.mov", taken)
    assert [a, b, c] == ["F/clip.mov", "F/clip (2).mov", "F/clip (3).mov"]


@pytest.mark.parametrize("evil", ["../../etc/passwd", "/etc/passwd", "..", "."])
def test_paths_cannot_escape_the_archive(evil):
    """Zip entries are just strings, and some extractors honour "..".

    Folder and asset names are user-supplied, so this is reachable input.
    """
    out = zip_entry_path([evil], evil, set())
    assert not out.startswith("/")
    assert ".." not in out.split("/")


def test_object_key_is_under_the_guarded_prefix():
    key = zip_object_key("proj", "link", "abc", "exp")
    assert key.startswith(ZIP_PREFIX)
    assert key == "zip-exports/proj/link/abc/exp.zip"
    assert zip_object_key("p", "user", "u1", "e").startswith(ZIP_PREFIX)
