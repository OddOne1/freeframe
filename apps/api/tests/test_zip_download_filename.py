"""A batch download is named after its share link, not "download.zip" (§175).

Every archive used to be served as the literal string `download.zip`, so a
reviewer who pulled three links' downloads got three files with the same name
and no way to tell them apart.

The rule: `{link title}.zip` for a whole scope, `{link title}_selection.zip`
for a subset. The scope is carried on the request and persisted on the row —
NOT inferred from item-count vs total-count, which cannot distinguish "all of
it" from "the one I picked" for a link holding exactly one asset.

Expected filenames here are built by calling `build_download_filename`, the
helper the code under test uses, rather than typed out as literals. A
hand-typed "Client Review.zip" would keep passing if the extension logic
broke, which is most of what that helper does.
"""

import uuid
from unittest.mock import MagicMock

import pytest

from apps.api.models.zip_export import ZipExportStatus
from apps.api.services.s3_service import build_download_filename
from apps.api.services.zip_export_service import (
    ZIP_FALLBACK_NAME, zip_download_filename,
)

S3_KEY = "zip-exports/proj/link/abc/def.zip"


def expected(base: str) -> str:
    """What the real helper produces for a base name, extension included."""
    return build_download_filename(base, S3_KEY)


# ─── the naming rule itself ──────────────────────────────────────────────────

def test_a_full_download_is_named_after_the_link():
    assert zip_download_filename("Client Review", "all", S3_KEY) == expected("Client Review")


def test_a_partial_selection_is_marked_as_one():
    got = zip_download_filename("Client Review", "selected", S3_KEY)
    assert got == expected("Client Review_Selected")
    assert got != expected("Client Review"), "a subset must not be named like the whole link"


def test_the_old_selection_spelling_still_names_a_subset():
    """§175 called this "selection". A browser tab open across the deploy is
    still sending that word, and it must not produce a name claiming the
    whole link."""
    assert (
        zip_download_filename("Client Review", "selection", S3_KEY)
        == zip_download_filename("Client Review", "selected", S3_KEY)
    )


def test_an_untitled_link_falls_back_to_a_non_empty_name():
    """`ShareLink.title` is NOT NULL with a "" default, so untitled is a real
    state — and `"" + ".zip"` would offer the browser a dotfile with no name."""
    got = zip_download_filename("", "all", S3_KEY)
    assert got == expected(ZIP_FALLBACK_NAME)
    assert got.startswith(ZIP_FALLBACK_NAME)
    assert got != expected(""), "an empty base is not an acceptable filename"


@pytest.mark.parametrize("blank", ["", "   ", None, "  .  "])
def test_every_flavour_of_blank_title_falls_back(blank):
    """None covers the in-app flow, where there is no share link at all, and a
    whitespace/dot-only title is user input that reduces to nothing."""
    assert zip_download_filename(blank, "all", S3_KEY) == expected(ZIP_FALLBACK_NAME)


def test_the_extension_is_not_doubled_for_a_link_already_called_zip():
    """Delegated to `build_download_filename`, which is the reason to call it
    rather than concatenate ".zip"."""
    assert zip_download_filename("Archive.zip", "all", S3_KEY) == "Archive.zip"


def test_a_title_containing_a_path_separator_cannot_produce_a_path():
    """A title is free text. `Client / Round 2.zip` in a Content-Disposition
    leaves a browser saving `Round 2.zip` or rejecting the name outright, and
    neither `build_download_filename` nor the header sanitizer touches
    separators."""
    for title in ("Client / Round 2", r"Client \ Round 2"):
        got = zip_download_filename(title, "all", S3_KEY)
        assert "/" not in got and "\\" not in got, got
        assert got == expected("Client - Round 2")


# ─── what the endpoint actually serves ───────────────────────────────────────

def _export(*, scope="all", share_link_id=None, project_id=None, folder_name=None):
    export = MagicMock()
    export.id = uuid.uuid4()
    export.status = ZipExportStatus.ready
    export.s3_key = S3_KEY
    export.scope = scope
    export.folder_name = folder_name
    export.share_link_id = share_link_id
    export.project_id = project_id or uuid.uuid4()
    export.manifest = []
    export.file_count = 2
    export.files_done = 2
    export.total_bytes = 10
    export.bytes_done = 10
    export.phase = None
    export.error = None
    return export


def _db(*, link_title=None, project_name=None):
    """A session returning a ShareLink and/or Project by model class."""
    from apps.api.models.project import Project
    from apps.api.models.share import ShareLink

    link = MagicMock(); link.title = link_title
    project = MagicMock(); project.name = project_name

    db = MagicMock()

    def query(model):
        result = MagicMock()
        found = None
        if model is ShareLink and link_title is not None:
            found = link
        elif model is Project and project_name is not None:
            found = project
        result.filter.return_value.first.return_value = found
        return result

    db.query.side_effect = query
    return db


def served_name(db, export) -> str:
    """The filename actually embedded in the URL the client receives."""
    from urllib.parse import parse_qs, urlparse

    from apps.api.routers.share import _zip_status_payload

    payload = _zip_status_payload(db, export)
    assert payload.url, "a ready export must carry a URL"
    return parse_qs(urlparse(payload.url).query)["download"][0]


def test_the_status_payload_serves_the_link_title():
    link_id = uuid.uuid4()
    name = served_name(_db(link_title="Autumn Campaign"), _export(share_link_id=link_id))
    assert name == expected("Autumn Campaign")
    assert name != "download.zip"


def test_the_status_payload_marks_a_selection():
    link_id = uuid.uuid4()
    name = served_name(
        _db(link_title="Autumn Campaign"),
        _export(scope="selected", share_link_id=link_id),
    )
    assert name == expected("Autumn Campaign_Selected")


def test_a_cache_hit_is_named_exactly_like_a_cold_build():
    """`reused=True` is the path a second viewer takes, and it goes through the
    same payload builder — so the name must not depend on who triggered it."""
    from apps.api.routers.share import _zip_status_payload
    from urllib.parse import parse_qs, urlparse

    link_id = uuid.uuid4()
    export = _export(share_link_id=link_id)
    db = _db(link_title="Autumn Campaign")

    cold = _zip_status_payload(db, export, reused=False)
    hot = _zip_status_payload(db, export, reused=True)

    pick = lambda u: parse_qs(urlparse(u).query)["download"][0]
    assert pick(cold.url) == pick(hot.url) == expected("Autumn Campaign")
    assert hot.reused is True and cold.reused is False


def test_the_in_app_download_uses_the_project_name():
    """The authenticated flow has no share link (`share_link_id` is None), and
    its project's name is the closest thing to what the user asked for."""
    name = served_name(_db(project_name="Winter Shoot"), _export(share_link_id=None))
    assert name == expected("Winter Shoot")


def test_an_untitled_link_falls_through_to_the_project_name():
    """An empty title is not "no scope" — the link exists, it just has no name,
    so the project it belongs to is a better answer than the generic fallback."""
    link_id = uuid.uuid4()
    name = served_name(
        _db(link_title="", project_name="Winter Shoot"),
        _export(share_link_id=link_id),
    )
    assert name == expected("Winter Shoot")


def test_a_build_that_is_not_ready_carries_no_url_to_name():
    from apps.api.routers.share import _zip_status_payload

    export = _export(share_link_id=uuid.uuid4())
    export.status = ZipExportStatus.building
    payload = _zip_status_payload(_db(link_title="Autumn Campaign"), export)
    assert payload.url is None and payload.ready is False


# ─── the flag has to survive the trip ────────────────────────────────────────

def test_the_requested_scope_is_persisted_on_the_row():
    """Without this the naming rule is inert end-to-end.

    The payload tests above set `export.scope` themselves, so they would all
    still pass while `_start_or_reuse_zip` dropped the request's scope and
    every archive fell back to the column default.
    """
    from unittest.mock import patch

    from apps.api.routers import share as share_router

    added = []
    db = MagicMock()
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
    db.add.side_effect = added.append

    with patch.object(share_router, "send_task_safe"):
        # "selection" is covered separately: §177 folds that spelling to
        # "selected" on the way in, so it is the one value that legitimately
        # does NOT round-trip unchanged.
        for requested in ("all", "selected"):
            added.clear()
            share_router._start_or_reuse_zip(
                db,
                plan=[{"path": "a.mov"}],
                resolved=MagicMock(files=[]),
                scope_kind="link",
                scope_id=uuid.uuid4(),
                project_id=uuid.uuid4(),
                share_link_id=uuid.uuid4(),
                created_by=None,
                scope=requested,
            )
            assert len(added) == 1
            assert added[0].scope == requested, (
                f"requested scope={requested!r} but the row recorded "
                f"{added[0].scope!r}"
            )


def test_an_unspecified_scope_is_treated_as_a_selection():
    """The conservative default, and the direction matters.

    Labelling a partial archive `{link}.zip` claims a completeness nothing
    verified. Labelling a complete one `{link}_Selected.zip` is merely less
    specific. So a caller that says nothing gets the second.
    """
    from apps.api.schemas.share import ZipExportRequest

    req = ZipExportRequest(items=[{"asset_id": str(uuid.uuid4())}])
    assert req.scope == "selected"


def test_the_model_default_matches_the_schema_default():
    """Two independent defaults for the same concept — a row inserted without
    a scope and a request sent without one must agree, or a legacy row would
    be named differently from an identical fresh request."""
    from apps.api.models.zip_export import ZipExport
    from apps.api.schemas.share import ZipExportRequest

    column_default = ZipExport.__table__.c.scope.server_default.arg
    req = ZipExportRequest(items=[{"asset_id": str(uuid.uuid4())}])
    assert str(column_default).strip("'") == req.scope


# ─── §177: the four shapes, and the reuse bug that hid them ──────────────────

class TestTheNamingScheme:
    """`{base}` is the link title (or the project name in-app). What follows
    it states the SHAPE of what was downloaded, not how many files it held."""

    def test_a_whole_scope_carries_no_suffix(self):
        assert zip_download_filename("Rope Challenge", "all", S3_KEY) == expected(
            "Rope Challenge"
        )

    def test_a_mixed_selection_is_marked_selected(self):
        """Loose files, or files alongside folders: nothing more specific can
        honestly be said about it."""
        assert zip_download_filename("Rope Challenge", "selected", S3_KEY) == expected(
            "Rope Challenge_Selected"
        )

    def test_one_folder_is_named_after_that_folder(self):
        got = zip_download_filename(
            "Rope Challenge", "single_folder", S3_KEY, "Day 2 Rushes"
        )
        assert got == expected("Rope Challenge_Day 2 Rushes")

    def test_several_folders_say_so(self):
        assert zip_download_filename(
            "Rope Challenge", "multiple_folders", S3_KEY
        ) == expected("Rope Challenge_MultipleFolders")

    @pytest.mark.parametrize("missing", [None, "", "   ", " . "])
    def test_a_single_folder_with_no_usable_name_falls_back_to_selected(self, missing):
        """NOT to the bare base. `{base}.zip` is the one name that claims the
        whole scope, which is exactly the claim this function exists to keep
        honest — a folder whose name reduces to nothing is still a subset."""
        got = zip_download_filename("Rope Challenge", "single_folder", S3_KEY, missing)
        assert got == expected("Rope Challenge_Selected")
        assert got != expected("Rope Challenge")

    def test_a_folder_name_cannot_smuggle_in_a_path(self):
        """A folder name is user input, same as a link title (see the title
        test above) — and a separator in a Content-Disposition leaves a
        browser saving the tail or rejecting the name."""
        got = zip_download_filename(
            "Rope Challenge", "single_folder", S3_KEY, "Day 2 / Rushes"
        )
        assert "/" not in got and "\\" not in got, got
        assert got == expected("Rope Challenge_Day 2 - Rushes")

    def test_an_unknown_scope_is_treated_as_a_subset(self):
        """Forward compatibility in the safe direction: a scope this build
        does not recognise must not be named like a complete archive."""
        got = zip_download_filename("Rope Challenge", "something_new", S3_KEY)
        assert got == expected("Rope Challenge_Selected")

    def test_the_folder_name_reaches_the_served_url(self):
        """The pieces above are only wired together at serve time."""
        name = served_name(
            _db(link_title="Rope Challenge"),
            _export(
                scope="single_folder",
                share_link_id=uuid.uuid4(),
                folder_name="Day 2 Rushes",
            ),
        )
        assert name == expected("Rope Challenge_Day 2 Rushes")


class TestAReusedRowIsRelabelled:
    """§177's real bug: `scope` was written on the cache MISS only.

    The row outlives the request that built it, so the first request's label
    stuck forever. Confirmed live — a genuine "Download All" of the Rope
    Challenge link came back as `Rope Challenge_selection.zip`, because an
    earlier request over the identical file set had built the row under a
    selection scope.
    """

    def _reuse(self, existing, *, scope, folder_name=None):
        from unittest.mock import patch

        from apps.api.routers import share as share_router

        db = MagicMock()
        db.query.return_value.filter.return_value.order_by.return_value.first.return_value = existing

        with patch.object(share_router, "send_task_safe"):
            export, reused = share_router._start_or_reuse_zip(
                db,
                plan=[{"path": "a.mov"}],
                resolved=MagicMock(files=[]),
                scope_kind="link",
                scope_id=uuid.uuid4(),
                project_id=uuid.uuid4(),
                share_link_id=uuid.uuid4(),
                created_by=None,
                scope=scope,
                folder_name=folder_name,
            )
        return export, reused, db

    def test_download_all_over_an_existing_selection_renames_the_download(self):
        """The exact live failure, end to end: build under one scope, ask
        again for the identical file set as "all", and the served filename
        must lose the suffix."""
        row = _export(scope="selected", share_link_id=uuid.uuid4())

        export, reused, db = self._reuse(row, scope="all")

        assert reused is True, "identical contents must still reuse the archive"
        assert export.scope == "all"
        db.commit.assert_called_once()
        assert served_name(_db(link_title="Rope Challenge"), export) == expected(
            "Rope Challenge"
        )

    def test_the_folder_name_is_refreshed_on_reuse_too(self):
        """Same row, a different folder whose contents happen to be identical
        — the name has to follow the request, not the build."""
        row = _export(
            scope="single_folder", share_link_id=uuid.uuid4(), folder_name="Day 1"
        )

        export, _, _ = self._reuse(row, scope="single_folder", folder_name="Day 2")

        assert export.folder_name == "Day 2"
        assert served_name(_db(link_title="Rope Challenge"), export) == expected(
            "Rope Challenge_Day 2"
        )

    def test_a_reuse_at_the_same_scope_writes_nothing(self):
        """No pointless UPDATE on the common path — two viewers pulling the
        same link is the reuse case this cache exists for."""
        row = _export(scope="all", share_link_id=uuid.uuid4())

        _, reused, db = self._reuse(row, scope="all")

        assert reused is True
        db.commit.assert_not_called()

    def test_the_old_spelling_is_folded_before_it_reaches_the_row(self):
        """A stale tab sending §175's "selection" must not leave the database
        holding two words for one state."""
        row = _export(scope="all", share_link_id=uuid.uuid4())

        export, _, _ = self._reuse(row, scope="selection")

        assert export.scope == "selected"

    def test_a_failed_rename_still_serves_the_archive(self):
        """The bytes are ready and correct either way — a commit error here
        is not worth turning a working download into an error."""
        from unittest.mock import patch

        from apps.api.routers import share as share_router

        row = _export(scope="selected", share_link_id=uuid.uuid4())
        db = MagicMock()
        db.query.return_value.filter.return_value.order_by.return_value.first.return_value = row
        db.commit.side_effect = RuntimeError("connection lost")

        with patch.object(share_router, "send_task_safe"):
            export, reused = share_router._start_or_reuse_zip(
                db,
                plan=[{"path": "a.mov"}],
                resolved=MagicMock(files=[]),
                scope_kind="link",
                scope_id=uuid.uuid4(),
                project_id=uuid.uuid4(),
                share_link_id=uuid.uuid4(),
                created_by=None,
                scope="all",
            )

        assert reused is True and export is row
        db.rollback.assert_called_once()


class TestTheNewShapesArePersistedOnAColdBuild:
    """The miss path, for the fields §177 adds — the reuse tests above would
    all still pass while a fresh build dropped them."""

    def _build(self, *, scope, folder_name=None):
        from unittest.mock import patch

        from apps.api.routers import share as share_router

        added = []
        db = MagicMock()
        db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
        db.add.side_effect = added.append

        with patch.object(share_router, "send_task_safe"):
            share_router._start_or_reuse_zip(
                db,
                plan=[{"path": "a.mov"}],
                resolved=MagicMock(files=[]),
                scope_kind="link",
                scope_id=uuid.uuid4(),
                project_id=uuid.uuid4(),
                share_link_id=uuid.uuid4(),
                created_by=None,
                scope=scope,
                folder_name=folder_name,
            )
        assert len(added) == 1
        return added[0]

    @pytest.mark.parametrize(
        "scope", ["all", "selected", "single_folder", "multiple_folders"]
    )
    def test_every_shape_survives_the_trip(self, scope):
        assert self._build(scope=scope).scope == scope

    def test_the_folder_name_survives_the_trip(self):
        row = self._build(scope="single_folder", folder_name="Day 2 Rushes")
        assert row.folder_name == "Day 2 Rushes"

    def test_the_old_spelling_is_folded_on_a_cold_build_too(self):
        assert self._build(scope="selection").scope == "selected"


def test_the_scope_column_fits_the_longest_value():
    """"multiple_folders" is exactly 16 characters — the width the column had
    before §177 widened it, with nothing to spare."""
    from apps.api.models.zip_export import ZipExport

    width = ZipExport.__table__.c.scope.type.length
    assert width >= len("multiple_folders")
    assert width > 16, "no headroom is how the next value gets truncated"
