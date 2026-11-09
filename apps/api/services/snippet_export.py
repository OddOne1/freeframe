"""SocialSnippet clip exports: the rules, as plain functions.

Everything here is pure or nearly so (no Celery, no S3, no HTTP), so the
route, the render task and the tests share one definition of: what a valid
request is, what makes two requests the same render, which stored file
ffmpeg reads, the exact ffmpeg argv, and the download's name.

── Framing ───────────────────────────────────────────────────────────────
`framing = {x, y, zoom}`: x and y (0..1) are where in the SOURCE frame the
centre of the picked region should sit; zoom (>= 1) divides the region's
size. The region is clamped to stay inside the frame, so x = 0 means "as
far left as the region can go", not "centred on the left edge".

  9:16  the region is the largest 9:16 rectangle that fits the source,
        divided by zoom; it is cropped and scaled to fill 1080x1920.
  16:9  the region is the whole frame divided by zoom (keeping the source's
        own shape); it is scaled to FIT 1920x1080 and padded black. So a
        16:9 source at zoom 1 is just a scale, and a vertical source gets
        pillarboxed rather than cropped.

Non-square pixels are squared first, so the shapes above are the shapes a
viewer sees.

── Input ─────────────────────────────────────────────────────────────────
See `choose_input`.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from ..models.snippet import EXPORT_ASPECTS
from ..models.snippet_export import EXPORT_PREFIX

#: The longest clip one export may cover.
EXPORT_MAX_MS = 10 * 60 * 1000
#: The shortest; the same floor PATCH /snippets/{id} applies to a clip.
EXPORT_MIN_MS = 1_000
#: The shapes that render today. The other four are known (validation
#: accepts them as real ratios) and answer "aspect not available yet".
IMPLEMENTED_ASPECTS = ("9:16", "16:9")
OUTPUT_SIZE = {"9:16": (1080, 1920), "16:9": (1920, 1080)}
#: Largest zoom accepted; past this a 1080p source is a few dozen pixels.
ZOOM_MAX = 10.0
#: A queued/running row untouched this long is taken to be lost (the worker
#: restarted mid-render) and a new POST queues it again.
EXPORT_STALE_AFTER = timedelta(minutes=30)

DEFAULT_FRAMING = {"x": 0.5, "y": 0.5, "zoom": 1.0}

#: The ffmpeg settings the prompt fixes. Kept together so the report and the
#: argv cannot disagree.
VIDEO_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]


class ExportError(ValueError):
    """A request the API answers with 422 and this message, as it is."""


# ── Validation ─────────────────────────────────────────────────────────────


def check_aspect(aspect: str) -> None:
    if aspect not in EXPORT_ASPECTS:
        raise ExportError(f"aspect must be one of {', '.join(EXPORT_ASPECTS)}.")
    if aspect not in IMPLEMENTED_ASPECTS:
        raise ExportError("aspect not available yet")


def check_range(start_ms: int, end_ms: int, duration_ms: Optional[int]) -> None:
    if start_ms < 0:
        raise ExportError("start_ms must be 0 or more.")
    if start_ms >= end_ms:
        raise ExportError("start_ms must be before end_ms.")
    if end_ms - start_ms < EXPORT_MIN_MS:
        raise ExportError("An export must be at least 1 second long.")
    if end_ms - start_ms > EXPORT_MAX_MS:
        raise ExportError("An export may be at most 10 minutes long.")
    if duration_ms is not None and end_ms > duration_ms:
        raise ExportError("end_ms is past the end of the file.")


def normalise_framing(framing: Optional[dict]) -> dict:
    """The framing with defaults filled in and values rounded, so requests
    that differ only by float noise share a cache key."""
    f = dict(DEFAULT_FRAMING)
    if framing:
        for k in ("x", "y", "zoom"):
            if framing.get(k) is not None:
                f[k] = float(framing[k])
    if not (0.0 <= f["x"] <= 1.0 and 0.0 <= f["y"] <= 1.0):
        raise ExportError("framing x and y must be between 0 and 1.")
    if not (1.0 <= f["zoom"] <= ZOOM_MAX):
        raise ExportError(f"framing zoom must be between 1 and {ZOOM_MAX:g}.")
    return {k: round(v, 4) for k, v in f.items()}


def cache_key(asset_version_id, start_ms: int, end_ms: int, aspect: str,
              framing: dict, captions: bool, caption_style: Optional[dict]) -> str:
    """SHA-256 of everything that changes the rendered file.

    The asset VERSION, not the media file or the asset: a new upload of the
    same asset is new footage and must render again. `framing` must already
    be normalised. Keys are sorted, so dict order never matters.
    """
    payload = {
        "v": str(asset_version_id),
        "in": int(start_ms),
        "out": int(end_ms),
        "aspect": aspect,
        "framing": framing,
        "captions": bool(captions),
        "caption_style": caption_style or None,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def is_stale(updated_at: Optional[datetime], now: Optional[datetime] = None) -> bool:
    if updated_at is None:
        return True
    now = now or datetime.now(timezone.utc)
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    return now - updated_at > EXPORT_STALE_AFTER


def expires_at(retention_days: Optional[int], now: Optional[datetime] = None) -> Optional[datetime]:
    """When a finished export goes; None (the project keeps exports forever)."""
    if retention_days is None:
        return None
    return (now or datetime.now(timezone.utc)) + timedelta(days=retention_days)


# ── Input ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class InputChoice:
    s3_key: str
    reason: str


def choose_input(media_file) -> InputChoice:
    """Which stored file ffmpeg reads.

    The persisted 1080p download proxy (§57) when the file has one, else the
    original. A proxy exists exactly when the transcode found the original
    heavy (above HEAVY_BITRATE_BPS, or a long edge of HEAVY_LONG_EDGE or
    more), which is the "huge original" case: decoding a 6K/400 Mbit/s or
    an XAVC MXF original over a presigned URL for a 20-second clip costs far
    more than the clip. Everything without a proxy is a file the transcode
    already decoded with this same ffmpeg, so it is readable — MXF included.

    Never the HLS rendition: its segments are addressed relative to the
    playlist, which a presigned playlist URL cannot serve.

    Trade-off, stated: a 9:16 crop of a 16:9 1080p proxy is 608x1080,
    upscaled to 1080x1920, so it is softer than a crop of a 4K original
    would be. Ordinary footage (no proxy) is cropped from the original.
    """
    proxy = getattr(media_file, "proxy_1080p_key", None)
    if proxy:
        return InputChoice(proxy, "1080p download proxy (the original is heavy)")
    return InputChoice(media_file.s3_key_raw, "original upload (no proxy: the original is not heavy)")


# ── ffmpeg ─────────────────────────────────────────────────────────────────


def _num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:.4f}".rstrip("0").rstrip(".")


def video_filter(aspect: str, framing: dict) -> str:
    """The -vf chain. Each expression is single-quoted so its commas are not
    read as filter separators."""
    x, y, z = _num(framing["x"]), _num(framing["y"]), _num(framing["zoom"])
    square = "scale='trunc(iw*sar/2)*2':'ih',setsar=1"
    pos_x = f"x='max(0,min(iw-ow,{x}*iw-ow/2))'"
    pos_y = f"y='max(0,min(ih-oh,{y}*ih-oh/2))'"
    if aspect == "9:16":
        w, h = OUTPUT_SIZE[aspect]
        base = "min(iw,ih*9/16)"
        crop = (
            f"crop=w='trunc({base}/{z}/2)*2':h='trunc({base}/{z}*16/9/2)*2':{pos_x}:{pos_y}"
        )
        return f"{square},{crop},scale={w}:{h}:flags=lanczos,setsar=1"
    if aspect == "16:9":
        w, h = OUTPUT_SIZE[aspect]
        crop = f"crop=w='trunc(iw/{z}/2)*2':h='trunc(ih/{z}/2)*2':{pos_x}:{pos_y}"
        fit = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
        return f"{square},{crop},{fit},setsar=1"
    raise ExportError("aspect not available yet")


def ffmpeg_command(input_url: str, start_ms: int, end_ms: int, aspect: str,
                   framing: dict, output_path: str) -> list[str]:
    """The full argv.

    `-ss` BEFORE `-i` is the fast seek: ffmpeg jumps by the container index
    (an HTTP range request on a presigned URL) instead of decoding from the
    start, and because the clip is re-encoded the cut is still frame-exact.
    `-t` after `-i` is the clip length. First video and first audio stream
    only (`0:a:0?`: a silent file still exports); multi-track recordings get
    their first track. `-progress pipe:1` writes key=value lines to stdout,
    which the task turns into the row's progress.
    """
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-y",
        "-ss", f"{start_ms / 1000:.3f}",
        "-i", input_url,
        "-t", f"{(end_ms - start_ms) / 1000:.3f}",
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", video_filter(aspect, framing),
        *VIDEO_ARGS,
        *AUDIO_ARGS,
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        output_path,
    ]


_PROGRESS_RE = re.compile(r"^out_time_(?:us|ms)=(\d+)$")


def parse_progress(line: str, clip_ms: int) -> Optional[float]:
    """0..1 from one `-progress` line, or None for any other line.

    Both `out_time_us` and the older, misnamed `out_time_ms` are in
    MICROseconds. Capped below 1: only the task says a render is done.
    """
    m = _PROGRESS_RE.match(line.strip())
    if not m or clip_ms <= 0:
        return None
    return max(0.0, min(0.99, int(m.group(1)) / 1000 / clip_ms))


def render_timeout_seconds(clip_ms: int) -> int:
    """Generous: 20x real time, never under 15 minutes."""
    return max(900, int(math.ceil(clip_ms / 1000 * 20)))


def short_error(stderr_text: str, returncode: Optional[int] = None) -> str:
    """The last non-empty stderr line, trimmed: enough to say what broke
    without storing a screenful of ffmpeg."""
    lines = [ln.strip() for ln in (stderr_text or "").splitlines() if ln.strip()]
    msg = lines[-1] if lines else f"ffmpeg exited with code {returncode}"
    return msg[:300]


# ── Names and keys ─────────────────────────────────────────────────────────


def export_key(project_id, export_id) -> str:
    return f"{EXPORT_PREFIX}{project_id}/{export_id}/clip.mp4"


_UNSAFE = re.compile(r"[^\w.\-]+", re.UNICODE)


def _slug(text: Optional[str], fallback: str) -> str:
    s = _UNSAFE.sub("-", (text or "").strip()).strip("-.")
    return s[:60] or fallback


def _clock(ms: int) -> str:
    total = int(ms // 1000)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m:02d}m{s:02d}s"


def download_filename(asset_name: Optional[str], speaker_name: Optional[str],
                      start_ms: int, end_ms: int, aspect: str) -> str:
    """`{asset_name}_{speaker}_{start}-{end}_{aspect}.mp4`, filesystem-safe:
    e.g. `Interview_A-cam_Anna-Berger_00m12s-00m31s_9x16.mp4`. The asset's
    own extension is dropped (the file is an MP4 whatever the source was),
    and the colon in the ratio becomes an x.

    Stored on the row when the export is created. It is the name of a
    moment's download, and the fallback for a clip without a title (see
    `titled_download_filename`)."""
    stem = asset_name.rsplit(".", 1)[0] if asset_name and "." in asset_name else asset_name
    return "_".join([
        _slug(stem, "clip"),
        _slug(speaker_name, "unknown-speaker"),
        f"{_clock(start_ms)}-{_clock(end_ms)}",
        aspect.replace(":", "x"),
    ]) + ".mp4"


#: The title part of a titled download name, in characters.
TITLE_STEM_MAX = 80

#: Characters no file name may hold on Windows or macOS, plus C0/C1 controls.
_TITLE_FORBIDDEN = re.compile(r'[/\\:*?"<>|\x00-\x1f\x7f-\x9f]')
#: Bidirectional controls: invisible, and able to make "clip_9x16.mp4" display
#: as something else. Dropped, not replaced.
_TITLE_BIDI = re.compile("[\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_SPACES = re.compile(r"\s+")


def title_stem(title: Optional[str]) -> Optional[str]:
    """A clip title made safe as the first part of a file name, or None.

    / \\ : * ? " < > | and control characters become a space, runs of
    whitespace become one space, the ends are trimmed (and leading dots, so
    the file is not hidden), and the result is cut to TITLE_STEM_MAX
    characters. Letters outside ASCII (umlauts, accents, emoji) stay, in NFC
    so an umlaut typed on a Mac is one character, not two. None when nothing
    is left."""
    if not title:
        return None
    s = unicodedata.normalize("NFC", title)
    s = _TITLE_BIDI.sub("", s)
    s = _TITLE_FORBIDDEN.sub(" ", s)
    s = _SPACES.sub(" ", s).strip().lstrip(". ")
    s = s[:TITLE_STEM_MAX].rstrip()
    return s or None


def titled_download_filename(title: Optional[str], aspect: str) -> Optional[str]:
    """`{clip title}_{ratio}.mp4`, e.g. `Why the jump nearly failed_9x16.mp4`,
    or None when the title is empty (the caller falls back to the stored
    `download_filename`)."""
    stem = title_stem(title)
    if stem is None:
        return None
    return f"{stem}_{aspect.replace(':', 'x')}.mp4"
