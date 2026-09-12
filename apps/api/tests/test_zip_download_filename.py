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
    got = zip_download_filename("Client Review", "selection", S3_KEY)
    assert got == expected("Client Review_selection")
    assert got != expected("Client Review"), "a subset must not be named like the whole link"


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

def _export(*, scope="all", share_link_id=None, project_id=None):
    export = MagicMock()
    export.id = uuid.uuid4()
    export.status = ZipExportStatus.ready
    export.s3_key = S3_KEY
    export.scope = scope
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
        _export(scope="selection", share_link_id=link_id),
    )
    assert name == expected("Autumn Campaign_selection")


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
        for requested in ("all", "selection"):
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
    verified. Labelling a complete one `{link}_selection.zip` is merely less
    specific. So a caller that says nothing gets the second.
    """
    from apps.api.schemas.share import ZipExportRequest

    req = ZipExportRequest(items=[{"asset_id": str(uuid.uuid4())}])
    assert req.scope == "selection"


def test_the_model_default_matches_the_schema_default():
    """Two independent defaults for the same concept — a row inserted without
    a scope and a request sent without one must agree, or a legacy row would
    be named differently from an identical fresh request."""
    from apps.api.models.zip_export import ZipExport
    from apps.api.schemas.share import ZipExportRequest

    column_default = ZipExport.__table__.c.scope.server_default.arg
    req = ZipExportRequest(items=[{"asset_id": str(uuid.uuid4())}])
    assert str(column_default).strip("'") == req.scope
