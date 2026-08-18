"""Per-link asset-metadata visibility (CLAUDE.md §33).

The point is the gate. A `disabled` link must refuse the route outright,
and a `basic` link must not be able to reach technical metadata or sidecar
data by asking — a level that only hides UI is not a level.

Exercised through the real router and the real gate helper.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.share import FieldsVisibility


def _link(level):
    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = uuid.uuid4()
    link.folder_id = None
    link.project_id = None
    link.visibility = "public"
    link.password_hash = None
    link.permission = "view"
    link.allowed_download_variants = []
    link.fields_visibility = level
    return link


def _asset(asset_id):
    from apps.api.models.asset import AssetType

    a = MagicMock()
    a.id = asset_id
    a.name = "clip"
    a.asset_type = AssetType.video
    a.description = "a description"
    a.rating = 4
    a.due_date = None
    a.keywords = ["b-roll", "drone"]
    a.applied_lut_id = None
    a.project_id = uuid.uuid4()
    return a


@pytest.fixture
def fields(client, mock_db):
    """Everything patched EXCEPT the visibility gate."""
    with patch("apps.api.routers.share.validate_share_link_with_session") as v, \
         patch("apps.api.routers.share._get_asset") as ga, \
         patch("apps.api.routers.share._validate_asset_in_share"), \
         patch("apps.api.routers.share._get_latest_media_file") as gm:
        asset_id = uuid.uuid4()
        ga.return_value = _asset(asset_id)
        mf = MagicMock()
        mf.technical_metadata = {"video_codec": "h264", "camera_make": "Sony"}
        gm.return_value = mf
        mock_db.query.return_value.filter.return_value.order_by.return_value.all.return_value = []
        yield v, asset_id


def _get(client, asset_id):
    return client.get(f"/share/tok/fields/{asset_id}")


class TestDisabled:
    def test_the_route_is_refused_outright(self, client, fields):
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.disabled)
        assert _get(client, asset_id).status_code == 403

    def test_a_raw_string_level_is_honoured_too(self, client, fields):
        """The ORM may hand back the enum or its value depending on how the
        row was loaded; the gate must not fail open on either."""
        validate, asset_id = fields
        validate.return_value = _link("disabled")
        assert _get(client, asset_id).status_code == 403


class TestBasic:
    def test_returns_the_basic_fields(self, client, fields):
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.basic)
        r = _get(client, asset_id)
        assert r.status_code == 200
        body = r.json()
        assert body["name"] == "clip"
        assert body["description"] == "a description"
        assert body["rating"] == 4
        assert body["keywords"] == ["b-roll", "drone"]

    def test_technical_metadata_is_NOT_returned(self, client, fields):
        """The whole distinction between basic and full."""
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.basic)
        body = _get(client, asset_id).json()
        assert body["technical_metadata"] is None
        assert body["sidecars"] is None

    def test_the_level_is_reported_so_the_client_cannot_guess(self, client, fields):
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.basic)
        assert _get(client, asset_id).json()["level"] == "basic"


class TestFull:
    def test_returns_technical_metadata(self, client, fields):
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.full)
        body = _get(client, asset_id).json()
        assert body["technical_metadata"] == {"video_codec": "h264", "camera_make": "Sony"}
        assert body["sidecars"] == []

    def test_still_returns_the_basic_fields(self, client, fields):
        validate, asset_id = fields
        validate.return_value = _link(FieldsVisibility.full)
        body = _get(client, asset_id).json()
        assert body["name"] == "clip"
        assert body["rating"] == 4


class TestWhatIsNeverExposed:
    """§33's deliberate exclusions — team data, not asset data."""

    @pytest.mark.parametrize("level", [FieldsVisibility.basic, FieldsVisibility.full])
    def test_no_custom_project_fields_and_no_voter_breakdown(self, client, fields, level):
        validate, asset_id = fields
        validate.return_value = _link(level)
        body = _get(client, asset_id).json()
        forbidden = {
            "custom_fields", "custom_field_values", "metadata_fields",
            "rating_votes", "ratings", "voters", "rating_breakdown",
            "assignee_id", "created_by",
        }
        leaked = forbidden & set(body.keys())
        assert not leaked, f"share payload exposes {leaked}"


class TestTheGateHelper:
    def test_ranks_levels_rather_than_comparing_equality(self):
        """`full` must satisfy a `basic` requirement — an equality check
        would refuse the strictly-more-permissive level."""
        from fastapi import HTTPException

        from apps.api.routers.share import _require_download_variant  # noqa: F401
        from apps.api.routers.share import _require_fields_visibility

        _require_fields_visibility(_link(FieldsVisibility.full), FieldsVisibility.basic)
        _require_fields_visibility(_link(FieldsVisibility.basic), FieldsVisibility.basic)
        with pytest.raises(HTTPException):
            _require_fields_visibility(_link(FieldsVisibility.basic), FieldsVisibility.full)
        with pytest.raises(HTTPException):
            _require_fields_visibility(_link(FieldsVisibility.disabled), FieldsVisibility.basic)
