"""Poster upload formats and thumbnail generation (CLAUDE.md §19c / §19d).

These did not exist before. The §19c build verified thumbnail behaviour with
throwaway commands against a disposable stack rather than committed tests, so
when §19d came to remove the GIF branch there was nothing to re-run and
nothing that would have caught the branch being removed incorrectly. That is
the gap this file closes.

Two things are worth pinning here, both of which produce a plausible-looking
wrong result rather than an error if they regress:

  * AVIF has to actually DECODE. Core Pillow has no AVIF codec; the plugin
    registers itself on import. If that import is dropped or the plugin is
    missing, _build_poster_thumbnail's except-branch quietly returns None and
    every AVIF poster silently serves the full-size original forever -- which
    looks exactly like working software.
  * Alpha has to composite onto WHITE. JPEG has no alpha channel, and the
    default conversion fills with black, turning a transparent logo poster
    into a black square.
"""
import io

import pytest

from apps.api.routers.projects import (
    ALLOWED_POSTER_TYPES,
    POSTER_THUMB_MAX_EDGE,
    _build_poster_thumbnail,
)

PIL = pytest.importorskip("PIL", reason="Pillow is required for poster thumbnails")
from PIL import Image  # noqa: E402


def _encode(mode, size, fmt, **kw):
    colour = (200, 30, 30, 128) if mode == "RGBA" else (200, 30, 30)
    im = Image.new(mode, size, colour)
    buf = io.BytesIO()
    im.save(buf, format=fmt, **kw)
    return buf.getvalue()


# ── Accepted formats (§19d) ──────────────────────────────────────────────

def test_gif_is_no_longer_an_accepted_poster_format():
    """§19d reverses §19c: no animated images anywhere. GIF is rejected at
    upload rather than being uploaded and thumbnailed differently."""
    assert "image/gif" not in ALLOWED_POSTER_TYPES


def test_avif_is_an_accepted_poster_format():
    assert "image/avif" in ALLOWED_POSTER_TYPES


def test_the_static_formats_were_not_disturbed():
    assert ALLOWED_POSTER_TYPES == {
        "image/jpeg", "image/png", "image/webp", "image/avif",
    }


# ── Thumbnail generation ─────────────────────────────────────────────────

def test_avif_actually_decodes_and_thumbnails():
    """The one that matters for §19d.

    A missing pillow_avif import doesn't raise -- Image.open() just fails
    and the helper returns None -- so this asserts a real thumbnail comes
    back, not merely that nothing blew up.
    """
    try:
        source = _encode("RGB", (1600, 1200), "AVIF")
    except (OSError, KeyError) as exc:  # pragma: no cover
        pytest.fail(f"Pillow cannot encode AVIF, so the plugin isn't registered: {exc}")

    thumb = _build_poster_thumbnail(source, "image/avif")
    assert thumb is not None, "AVIF produced no thumbnail -- is pillow-avif-plugin installed?"

    im = Image.open(io.BytesIO(thumb))
    assert im.format == "JPEG"
    assert max(im.size) == POSTER_THUMB_MAX_EDGE


def test_a_large_jpeg_is_downscaled_and_keeps_its_aspect_ratio():
    source = _encode("RGB", (4000, 3000), "JPEG", quality=95)
    im = Image.open(io.BytesIO(_build_poster_thumbnail(source, "image/jpeg")))
    assert im.size == (800, 600)
    assert im.format == "JPEG"


def test_transparency_is_composited_onto_white_not_black():
    """A transparent logo poster must not come back as a black square."""
    thumb = _build_poster_thumbnail(_encode("RGBA", (1200, 1200), "PNG"), "image/png")
    im = Image.open(io.BytesIO(thumb))
    assert im.mode == "RGB"
    r, g, b = im.convert("RGB").getpixel((0, 0))
    # 50% red over white lands near (227,142,142); over black it would be
    # roughly (100,15,15). The distinguishing signal is the blue channel.
    assert b > 100, f"alpha looks composited onto black, not white: {(r, g, b)}"


def test_an_already_small_jpeg_is_left_alone():
    """Re-encoding would only lose quality for no saving."""
    assert _build_poster_thumbnail(_encode("RGB", (300, 300), "JPEG"), "image/jpeg") is None


def test_a_small_png_is_still_converted():
    """Not a no-op like the JPEG case: converting to JPEG still saves bytes
    and normalises the format the thumbnail key promises."""
    assert _build_poster_thumbnail(_encode("RGB", (300, 300), "PNG"), "image/png") is not None


def test_unreadable_input_returns_none_rather_than_raising():
    """The upload is already validated and stored by this point. Failing the
    request over a missing derivative would be worse than serving the
    original, which every caller falls back to."""
    assert _build_poster_thumbnail(b"not an image at all", "image/png") is None


def test_no_format_gets_a_special_case_any_more():
    """§19c returned None for GIF to preserve animation. §19d removed GIF
    from the accepted formats, so that branch was deleted rather than
    adapted -- every accepted format now flows through the same path.

    Checked behaviourally: each accepted format produces a JPEG thumbnail.
    """
    for content_type, fmt in (
        ("image/jpeg", "JPEG"), ("image/png", "PNG"),
        ("image/webp", "WEBP"), ("image/avif", "AVIF"),
    ):
        thumb = _build_poster_thumbnail(_encode("RGB", (1500, 1000), fmt), content_type)
        assert thumb is not None, f"{content_type} produced no thumbnail"
        assert Image.open(io.BytesIO(thumb)).format == "JPEG", content_type


# ── How the original is served (§19d) ────────────────────────────────────

def test_avif_is_served_as_an_image_and_is_cacheable():
    """Adding AVIF to the accepted formats is not finished at the upload.

    The proxy derives the response content type from the key's extension,
    not from what was stored, so an unmapped extension is served as
    application/octet-stream with no-cache. Browsers usually sniff an <img>
    anyway, which is exactly why this degrades quietly: AVIF posters would
    render but be re-downloaded in full on every single view, and only AVIF
    posters would behave that way.
    """
    from apps.api.services.s3_service import get_content_type

    content_type, cache_control = get_content_type("posters/x/poster.avif")
    assert content_type == "image/avif"
    assert cache_control == "max-age=86400"


def test_the_generated_thumbnail_key_is_served_as_jpeg():
    from apps.api.services.s3_service import get_content_type

    assert get_content_type("posters/x/poster_thumb.jpg")[0] == "image/jpeg"
