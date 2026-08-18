"""Per-variant download permissions on a share link (CLAUDE.md §30/§30b).

The point of these is the ENFORCEMENT, not the schema. A share link that
permits only "Proxy 720p" must refuse every other variant to a caller who
skips the UI and hits the endpoint directly with a valid token — a link
whose restriction only exists in the frontend is not a restriction.

Exercised through the real router and the real gate helper, so a change
that loosens either is caught here rather than in review.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.share import (
    ALL_DOWNLOAD_VARIANTS,
    VARIANT_QUALITY,
    VARIANT_USES_LUT,
    DownloadVariant,
)
from apps.api.schemas.share import variant_values


def _link(variants):
    link = MagicMock()
    link.id = uuid.uuid4()
    link.asset_id = uuid.uuid4()
    link.folder_id = None
    link.project_id = None
    link.visibility = "public"
    link.password_hash = None
    link.title = "t"
    link.description = None
    link.permission = "view"
    link.allowed_download_variants = variants
    link.show_versions = False
    link.show_watermark = False
    link.appearance = None
    link.created_by = uuid.uuid4()
    return link


def _asset(asset_id):
    from apps.api.models.asset import AssetType

    asset = MagicMock()
    asset.id = asset_id
    asset.name = "clip"
    asset.asset_type = AssetType.video
    asset.description = None
    asset.project_id = uuid.uuid4()
    return asset


def _media():
    m = MagicMock()
    m.s3_key_processed = "processed/p/v"
    m.s3_key_raw = "raw/p/v/in.mp4"
    m.s3_key_thumbnail = None
    m.original_filename = "in.mp4"
    m.version_id = uuid.uuid4()
    m.duration_seconds = 1.0
    return m


def _get(client, token, asset_id, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get(f"/share/{token}/stream/{asset_id}?{q}")


@pytest.fixture
def stream(client, mock_db):
    """Patch everything the endpoint needs EXCEPT the permission gate."""
    with patch("apps.api.routers.share.validate_share_link_with_session") as v, \
         patch("apps.api.routers.share._get_asset") as ga, \
         patch("apps.api.routers.share._validate_asset_in_share"), \
         patch("apps.api.routers.share._get_latest_media_file") as gm, \
         patch("apps.api.routers.share._log_share_activity"), \
         patch("apps.api.routers.share.proxy_url_for", return_value="/stream/hls/x"), \
         patch("apps.api.routers.share.create_hls_token", return_value="tk"):
        asset_id = uuid.uuid4()
        ga.return_value = _asset(asset_id)
        gm.return_value = _media()
        yield v, asset_id


class TestEmptyMeansNoDownloads:
    """The migrated form of the old `allow_download: False`."""

    def test_every_variant_is_refused(self, client, stream):
        validate, asset_id = stream
        validate.return_value = _link([])
        for v in ALL_DOWNLOAD_VARIANTS:
            r = _get(client, "tok", asset_id, download="true", variant=v)
            assert r.status_code == 403, f"{v} returned {r.status_code}"

    def test_the_default_variant_is_refused_too(self, client, stream):
        """`?download=true` with no variant must not sneak past the gate."""
        validate, asset_id = stream
        validate.return_value = _link([])
        assert _get(client, "tok", asset_id, download="true").status_code == 403

    def test_but_viewing_still_works(self, client, stream):
        """Downloads off must never mean the link stops playing."""
        validate, asset_id = stream
        validate.return_value = _link([])
        assert _get(client, "tok", asset_id).status_code == 200


class TestOneVariantAllowed:
    """A link with only Proxy 720p — the prompt's own verification case."""

    ALLOWED = "proxy_720p"

    def test_the_five_others_are_refused(self, client, stream):
        validate, asset_id = stream
        validate.return_value = _link([self.ALLOWED])
        for v in ALL_DOWNLOAD_VARIANTS:
            if v == self.ALLOWED:
                continue
            r = _get(client, "tok", asset_id, download="true", variant=v)
            assert r.status_code == 403, f"{v} returned {r.status_code}"

    def test_the_allowed_one_passes_the_gate(self, client, stream):
        """403 is what must not happen. 400 is the export-endpoint hand-off."""
        validate, asset_id = stream
        validate.return_value = _link([self.ALLOWED])
        r = _get(client, "tok", asset_id, download="true", variant=self.ALLOWED)
        assert r.status_code != 403
        assert r.status_code == 400
        assert "export" in r.json()["detail"].lower()

    def test_raw_is_not_implied_by_a_proxy_grant(self, client, stream):
        """Permitting a downscaled render must never leak the original."""
        validate, asset_id = stream
        validate.return_value = _link([self.ALLOWED])
        r = _get(client, "tok", asset_id, download="true", variant="raw")
        assert r.status_code == 403


class TestAllSixAllowed:
    def test_raw_is_served_directly(self, client, stream):
        validate, asset_id = stream
        validate.return_value = _link(list(ALL_DOWNLOAD_VARIANTS))
        r = _get(client, "tok", asset_id, download="true", variant="raw")
        assert r.status_code == 200

    def test_no_variant_is_refused(self, client, stream):
        validate, asset_id = stream
        validate.return_value = _link(list(ALL_DOWNLOAD_VARIANTS))
        for v in ALL_DOWNLOAD_VARIANTS:
            r = _get(client, "tok", asset_id, download="true", variant=v)
            assert r.status_code != 403, f"{v} was refused"


class TestUnknownVariantsAreNotStorable:
    def test_an_unknown_key_is_rejected_at_the_schema_boundary(self):
        from pydantic import ValidationError

        from apps.api.schemas.share import ShareLinkCreate

        with pytest.raises(ValidationError):
            ShareLinkCreate(allowed_download_variants=["raw", "proxy_4k"])

    def test_an_unknown_key_in_the_url_is_rejected(self, client, stream):
        validate, asset_id = stream
        validate.return_value = _link(list(ALL_DOWNLOAD_VARIANTS))
        r = _get(client, "tok", asset_id, download="true", variant="proxy_4k")
        assert r.status_code == 422


class TestStoredShape:
    def test_duplicates_and_order_are_normalised(self):
        got = variant_values(["proxy_720p", "raw", "raw", "proxy_720p"])
        assert got == ["raw", "proxy_720p"]

    def test_enum_members_become_plain_strings(self):
        got = variant_values([DownloadVariant.raw_lut, DownloadVariant.raw])
        assert got == ["raw", "raw_lut"]
        assert all(type(v) is str for v in got)

    def test_empty_stays_empty(self):
        assert variant_values([]) == []

    def test_every_variant_has_a_lut_and_quality_mapping(self):
        """The export task reads these tables; a gap would be a silent
        wrong-render rather than an error."""
        for v in DownloadVariant:
            assert v in VARIANT_USES_LUT
            assert v in VARIANT_QUALITY
        assert VARIANT_QUALITY[DownloadVariant.raw] is None
        assert VARIANT_QUALITY[DownloadVariant.proxy_720p] == "720p"
        assert VARIANT_USES_LUT[DownloadVariant.proxy_1080p_lut] is True
        assert VARIANT_USES_LUT[DownloadVariant.proxy_1080p] is False


class TestExportCommand:
    """The ffmpeg argv for each variant (CLAUDE.md §30, step 3).

    This is the part that ships without a real ffmpeg run — there is none
    in this environment. What CAN be pinned is that the argv says what the
    spec says it should, so a later edit cannot quietly change what a
    "Proxy 720p" file actually is.
    """

    @staticmethod
    def _cmd(variant, lut="/tmp/w/grade.cube"):
        from apps.api.tasks.lut_tasks import _build_export_command

        return _build_export_command(
            DownloadVariant(variant), "https://s3/in.mov", lut, "/tmp/w/out.mp4"
        )

    def _vf(self, variant, lut="/tmp/w/grade.cube"):
        cmd = self._cmd(variant, lut)
        return cmd[cmd.index("-vf") + 1]

    def test_proxy_rungs_match_the_transcode_ladder_verbatim(self):
        """A file labelled 720p must be the same 720p the player streams."""
        from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder  # noqa: F401
        from apps.api.tasks.lut_tasks import QUALITY_LADDER

        assert QUALITY_LADDER["1080p"] == ("1920:1080", 20)
        assert QUALITY_LADDER["720p"] == ("1280:720", 22)

        assert "scale=1280:720" in self._vf("proxy_720p")
        assert "scale=1920:1080" in self._vf("proxy_1080p")
        assert "-crf" in self._cmd("proxy_720p")
        assert self._cmd("proxy_720p")[self._cmd("proxy_720p").index("-crf") + 1] == "22"
        assert self._cmd("proxy_1080p")[self._cmd("proxy_1080p").index("-crf") + 1] == "20"

    def test_proxy_pads_to_even_dimensions(self):
        """H.264 cannot encode odd dimensions; the ladder pads for this."""
        for v in ("proxy_720p", "proxy_1080p"):
            vf = self._vf(v)
            assert "force_original_aspect_ratio=decrease" in vf
            assert "pad=ceil(iw/2)*2:ceil(ih/2)*2" in vf

    def test_lut_variants_burn_the_lut_and_plain_ones_do_not(self):
        for v in ("raw_lut", "proxy_720p_lut", "proxy_1080p_lut"):
            assert "lut3d=" in self._vf(v), v
        for v in ("proxy_720p", "proxy_1080p"):
            assert "lut3d=" not in self._vf(v), v

    def test_proxy_lut_applies_the_lut_before_scaling(self):
        """Grade at full resolution, then downscale — the other order
        samples a LUT against already-degraded pixels."""
        vf = self._vf("proxy_720p_lut")
        assert vf.index("lut3d=") < vf.index("scale=")

    def test_raw_lut_keeps_the_settings_graded_exports_already_used(self):
        """Generalising the task must not change what the existing
        'Download with LUT' button produces."""
        cmd = self._cmd("raw_lut")
        assert cmd[cmd.index("-crf") + 1] == "18"
        assert cmd[cmd.index("-preset") + 1] == "medium"
        assert "scale=" not in self._vf("raw_lut")

    def test_audio_is_pinned_not_inherited(self):
        """The HLS ladder has no -c:a and takes ffmpeg's mpegts default;
        a portable download must not."""
        for v in ("raw_lut", "proxy_720p", "proxy_1080p_lut"):
            cmd = self._cmd(v)
            assert cmd[cmd.index("-c:a") + 1] == "aac", v
            assert "-b:a" in cmd, v

    def test_faststart_is_set(self):
        for v in ("raw_lut", "proxy_720p", "proxy_1080p_lut"):
            cmd = self._cmd(v)
            assert "+faststart" in cmd, v

    def test_framerate_is_never_forced(self):
        """Neither ladder rung touches fps, so the source's is preserved."""
        for v in ALL_DOWNLOAD_VARIANTS:
            if v == "raw":
                continue
            assert "-r" not in self._cmd(v), v

    def test_raw_has_no_command_at_all(self):
        """Re-encoding the original with no filter would produce a file
        that is not the original while claiming to be."""
        with pytest.raises(ValueError, match="served directly"):
            self._cmd("raw")

    def test_a_lut_variant_without_a_lut_refuses(self):
        with pytest.raises(ValueError, match="needs a LUT"):
            self._cmd("proxy_720p_lut", lut=None)

    def test_the_lut_path_is_escaped_for_the_filtergraph(self):
        vf = self._vf("raw_lut", lut="/tmp/a:b/grade.cube")
        assert "a\\:b" in vf
