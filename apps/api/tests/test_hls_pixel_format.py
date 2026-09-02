"""The HLS ladder must emit renditions Apple's decoder can play (§117).

x264 inherits the SOURCE pixel format when none is given, so a 10-bit or
4:2:2 master -- ProRes 422, Log, essentially any professional camera -- came
out as High 10 or High 4:2:2. Chromium software-decodes those, which is why
this looked fine there; Safari's AVFoundation does not, and plays the AAC
track with no picture and no error at all.

Measured while diagnosing: in real Safari 26.5.2 an 8-bit H.264/TS HLS stream
renders correctly inside this app's own player markup (readyState 4,
videoWidth 768, no error), so the failure is in the content, not the player.

Static, and stdlib-only, so it runs in the container, in CI, and on a laptop
with neither ffmpeg nor the transcoder's dependencies installed -- which is
where this was written. Running ffmpeg to inspect real output would be the
stronger test and needs a machine that has it.
"""

from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "packages" / "transcoder" / "ffmpeg_transcoder.py"


def _code_without_comments() -> str:
    """Source with comment lines dropped.

    The block being asserted on explains the fix and names the very flags in
    question, so a substring check over the raw text matches the prose rather
    than the code.
    """
    return "\n".join(
        line for line in SRC.read_text().splitlines() if not line.strip().startswith("#")
    )


def _ladder_block() -> str:
    """Just the per-quality output loop, where per-stream flags must live."""
    code = _code_without_comments()
    start = code.index("for i, quality in enumerate(qualities):")
    return code[start : code.index("segment_dir", start)]


def test_pixel_format_is_pinned_to_8bit_420():
    block = _ladder_block()
    assert "-pix_fmt:v:{i}" in block, (
        "the HLS ladder must pin a pixel format; without one x264 carries the "
        "source's 10-bit or 4:2:2 format into the delivery renditions, which "
        "Apple's decoder refuses"
    )
    assert '"yuv420p"' in block


def test_profile_is_pinned():
    block = _ladder_block()
    assert "-profile:v:{i}" in block and '"high"' in block


def test_pinned_per_output_rather_than_globally():
    """A bare -pix_fmt applies to one output; this ladder has three."""
    block = _ladder_block()
    # Per-stream specifiers, matching the per-output codec flag beside them.
    assert "-c:v:{i}" in block
    assert "-pix_fmt:v:{i}" in block
    # And not the unqualified form, which would silently cover one rendition.
    assert '"-pix_fmt"' not in block


if __name__ == "__main__":
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
