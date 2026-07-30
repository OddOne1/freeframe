import json
import logging
import re
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional

@dataclass
class TranscodeJob:
    media_id: str
    version_id: str
    input_s3_key: str
    output_s3_prefix: str
    qualities: list[str] = field(default_factory=lambda: ["1080p", "720p", "360p"])

@dataclass
class TranscodeResult:
    success: bool
    hls_prefix: Optional[str] = None
    thumbnail_keys: list[str] = field(default_factory=list)
    waveform_key: Optional[str] = None
    error: Optional[str] = None
    # Populated from ffprobe when available — see parse_ffprobe_metadata().
    width: Optional[int] = None
    height: Optional[int] = None
    duration_seconds: Optional[float] = None
    fps: Optional[float] = None
    technical_metadata: dict = field(default_factory=dict)

@dataclass
class VideoMetadata:
    duration_seconds: float
    width: int
    height: int
    fps: float


def parse_ffprobe_metadata(probe_data: dict) -> dict:
    """Flatten an ffprobe JSON payload (from `-show_streams -show_format`)
    into a single dict covering both the plain MediaFile columns
    (width/height/duration_seconds/fps) and the Fields-tab technical_metadata
    keys: video_codec, video_bit_rate, visual_bit_depth, alpha_channel,
    color_space, dynamic_range, color_transfer, color_primaries,
    video_codec_profile, video_codec_level, field_order,
    display_aspect_ratio, timecode, rotation, camera_make, camera_model,
    creation_time, encoder, audio_codec, audio_bit_rate, audio_bit_depth,
    audio_channels, audio_sample_rate. (Expanded 2026-07-30 — see CLAUDE.md's
    "More technical metadata" note for what's still not captured here and
    why: camera-native raw formats like R3D/BRAW/ARRIRAW carry much richer
    metadata than generic ffprobe tag parsing can reach.)

    Fields are simply omitted when ffprobe doesn't report them — output shape
    varies a lot by container/codec, so this never raises on missing data.
    """
    result: dict = {}
    streams = probe_data.get("streams", []) or []
    fmt = probe_data.get("format", {}) or {}
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = None
    for src in (video_stream, audio_stream, fmt):
        if src and src.get("duration"):
            try:
                duration = float(src["duration"])
                break
            except (TypeError, ValueError):
                pass
    if duration is not None:
        result["duration_seconds"] = duration

    if video_stream:
        width = video_stream.get("width")
        height = video_stream.get("height")
        if width:
            result["width"] = int(width)
        if height:
            result["height"] = int(height)

        fps_raw = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
        if fps_raw and fps_raw != "0/0":
            try:
                num, den = fps_raw.split("/")
                if float(den) != 0:
                    result["fps"] = round(float(num) / float(den), 2)
            except (ValueError, ZeroDivisionError):
                pass

        result["video_codec"] = video_stream.get("codec_name")
        bit_rate = video_stream.get("bit_rate") or fmt.get("bit_rate")
        if bit_rate:
            try:
                result["video_bit_rate"] = int(bit_rate)
            except (TypeError, ValueError):
                pass

        pix_fmt = (video_stream.get("pix_fmt") or "").lower()
        result["alpha_channel"] = any(tag in pix_fmt for tag in ("yuva", "rgba", "bgra", "argb", "abgr"))
        depth_match = re.search(r"(10|12|16)(?:le|be)?$", pix_fmt)
        result["visual_bit_depth"] = int(depth_match.group(1)) if depth_match else 8

        color_space = video_stream.get("color_space")
        if color_space and color_space not in ("unknown", "unspecified"):
            result["color_space"] = color_space
        color_transfer = video_stream.get("color_transfer")
        if color_transfer in ("smpte2084", "arib-std-b67"):
            result["dynamic_range"] = "HDR"
        elif color_transfer and color_transfer not in ("unknown", "unspecified"):
            result["dynamic_range"] = "SDR"
        # Raw color_transfer/color_primaries, distinct from the HDR/SDR bucket
        # above -- a colorist wants to know it's specifically "smpte2084" or
        # "bt2020", not just "HDR". ffprobe already returns these in the same
        # probe call above; they just weren't being kept before.
        if color_transfer and color_transfer not in ("unknown", "unspecified"):
            result["color_transfer"] = color_transfer
        color_primaries = video_stream.get("color_primaries")
        if color_primaries and color_primaries not in ("unknown", "unspecified"):
            result["color_primaries"] = color_primaries

        profile = video_stream.get("profile")
        if profile and profile not in ("unknown",):
            result["video_codec_profile"] = profile
        level = video_stream.get("level")
        if level is not None and level != -99:  # ffprobe uses -99 for "not applicable"
            result["video_codec_level"] = level

        field_order = video_stream.get("field_order")
        if field_order and field_order != "unknown":
            result["field_order"] = field_order

        dar = video_stream.get("display_aspect_ratio")
        if dar and dar != "0:1":
            result["display_aspect_ratio"] = dar

        # Camera-originated files frequently carry make/model in stream or
        # format tags -- most reliably on QuickTime/MOV/MP4 (com.apple.quicktime.*
        # keys are a de facto standard many non-Apple cameras also write).
        # Proprietary raw formats (R3D/BRAW/ARRIRAW/MXF) often carry much richer
        # camera metadata (ISO, shutter, lens, white balance) that ffprobe's
        # generic tag parsing typically can't reach at all -- that needs a
        # dedicated tool like mediainfo/exiftool, not present in this image
        # today, and is a bigger follow-up, not part of this change.
        stream_tags = video_stream.get("tags", {}) or {}
        timecode = stream_tags.get("timecode")
        if timecode:
            result["timecode"] = timecode
        rotation = stream_tags.get("rotate")
        if rotation:
            try:
                rotation_int = int(rotation)
                if rotation_int:
                    result["rotation"] = rotation_int
            except (TypeError, ValueError):
                pass

    if audio_stream:
        result["audio_codec"] = audio_stream.get("codec_name")
        a_bit_rate = audio_stream.get("bit_rate") or fmt.get("bit_rate")
        if a_bit_rate:
            try:
                result["audio_bit_rate"] = int(a_bit_rate)
            except (TypeError, ValueError):
                pass
        sample_rate = audio_stream.get("sample_rate")
        if sample_rate:
            try:
                result["audio_sample_rate"] = int(sample_rate)
            except (TypeError, ValueError):
                pass
        channels = audio_stream.get("channels")
        if channels:
            result["audio_channels"] = int(channels)
        bits = audio_stream.get("bits_per_raw_sample") or audio_stream.get("bits_per_sample")
        if bits:
            try:
                bits_int = int(bits)
                if bits_int > 0:
                    result["audio_bit_depth"] = bits_int
            except (TypeError, ValueError):
                pass

    # Format-level tags -- camera make/model most reliably found here on
    # QuickTime-family containers (com.apple.quicktime.* keys), with a plain
    # "make"/"model" fallback some non-Apple muxers use instead. Same
    # per-format caveat as the stream-level tags above: proprietary raw
    # formats often don't populate any of this via generic ffprobe.
    fmt_tags = fmt.get("tags", {}) or {}
    camera_make = fmt_tags.get("com.apple.quicktime.make") or fmt_tags.get("make")
    if camera_make:
        result["camera_make"] = camera_make
    camera_model = fmt_tags.get("com.apple.quicktime.model") or fmt_tags.get("model")
    if camera_model:
        result["camera_model"] = camera_model
    creation_time = fmt_tags.get("creation_time")
    if creation_time:
        result["creation_time"] = creation_time
    encoder = fmt_tags.get("encoder") or fmt_tags.get("com.apple.quicktime.software")
    if encoder:
        result["encoder"] = encoder

    return result


# exiftool tags whose value is present but meaningless. exiftool returns a
# key with an empty or placeholder value for a tag it recognizes but has no
# real data for, rather than omitting the key -- storing those would render
# a blank row in the Fields tab, since the frontend whitelist filter only
# drops undefined/null.
_EXIFTOOL_EMPTY_VALUES = {"", "-", "n/a", "none", "undef", "unknown", "(none)"}

# EXIF tag name -> technical_metadata key. Ordering within a value tuple is
# preference order: the first tag exiftool actually reports wins.
_EXIFTOOL_FIELD_MAP: list[tuple[str, tuple[str, ...]]] = [
    # camera_make/camera_model/software deliberately OVERRIDE the ffprobe
    # values (see _merge below): exiftool reads these across far more
    # container and image types than the QuickTime-only tags ffprobe reaches.
    ("camera_make", ("Make",)),
    ("camera_model", ("Model",)),
    ("software", ("Software",)),
    # EXIF Orientation is an 8-value enum ("Horizontal (normal)",
    # "Rotate 90 CW", ...), NOT a degree value -- deliberately a separate key
    # from the video-world `rotation` degrees ffprobe fills.
    ("exif_orientation", ("Orientation",)),
    # Three genuinely distinct timestamps; not collapsed into creation_time.
    ("date_time", ("ModifyDate", "DateTime")),
    ("date_time_original", ("DateTimeOriginal",)),
    ("date_time_digitized", ("CreateDate", "DateTimeDigitized")),
    ("ycbcr_positioning", ("YCbCrPositioning",)),
    ("compression", ("Compression",)),
    ("x_resolution", ("XResolution",)),
    ("y_resolution", ("YResolution",)),
    ("resolution_unit", ("ResolutionUnit",)),
    ("exposure_time", ("ExposureTime", "ShutterSpeedValue")),
    ("f_number", ("FNumber", "ApertureValue")),
    ("exposure_program", ("ExposureProgram",)),
    ("exif_version", ("ExifVersion",)),
    ("components_configuration", ("ComponentsConfiguration",)),
    ("compressed_bits_per_pixel", ("CompressedBitsPerPixel",)),
    ("exposure_bias", ("ExposureCompensation", "ExposureBiasValue")),
    ("max_aperture_value", ("MaxApertureValue",)),
    ("metering_mode", ("MeteringMode",)),
    ("flash", ("Flash",)),
    ("focal_length", ("FocalLength",)),
    ("flashpix_version", ("FlashpixVersion",)),
    # EXIF ColorSpace means sRGB/Uncalibrated -- a different concept from the
    # video YUV/Rec.709 `color_space` ffprobe fills, hence its own key.
    ("exif_color_space", ("ColorSpace",)),
    ("file_source", ("FileSource",)),
    ("interoperability_index", ("InteroperabilityIndex",)),
    ("interoperability_version", ("InteroperabilityVersion",)),
    # Captured but deliberately absent from the frontend whitelist -- see
    # CLAUDE.md: stored, never lost, not shown by default.
    ("gps_latitude", ("GPSLatitude",)),
    ("gps_longitude", ("GPSLongitude",)),
    ("gps_altitude", ("GPSAltitude",)),
]

# Tags exiftool always emits that describe the file rather than the shot, or
# that duplicate data already captured from ffprobe. Skipped when harvesting
# manufacturer-decoded MakerNote tags below.
_EXIFTOOL_STRUCTURAL_TAGS = {
    "SourceFile", "ExifToolVersion", "FileName", "Directory", "FileSize",
    "FileModifyDate", "FileAccessDate", "FileInodeChangeDate", "FilePermissions",
    "FileType", "FileTypeExtension", "MIMEType", "ImageWidth", "ImageHeight",
    "ImageSize", "Megapixels", "EncodingProcess", "BitsPerSample",
    "ColorComponents", "YCbCrSubSampling", "Duration", "VideoFrameRate",
    "AvgBitrate", "ExifByteOrder", "Warning",
}


def _exiftool_value(raw):
    """Normalize one exiftool value, or None if it carries no real data."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return raw
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (list, dict)):
        # Structured values (rare outside MakerNote groups) are stringified
        # rather than dropped -- better a readable row than a lost field.
        text = str(raw).strip()
        return text or None
    text = str(raw).strip()
    if not text or text.lower() in _EXIFTOOL_EMPTY_VALUES:
        return None
    # "(Binary data 432 bytes, use -b option to extract)" and friends: a
    # placeholder standing in for a blob, not a value worth storing.
    if text.startswith("(Binary data") or "use -b option" in text:
        return None
    return text


def probe_exiftool(path: str) -> dict:
    """Run `exiftool -j` against a LOCAL file and return parsed metadata.

    Local path, not a URL -- this is the one tool in the pipeline that
    cannot read from a presigned URL, which is why callers now download the
    source first. Returns {} on any failure: metadata extraction is
    best-effort and must never block processing (or fail an upload) just
    because exiftool is missing or choked on an exotic format.
    """
    try:
        # -n keeps numeric tags numeric where sensible; -api largefilesupport
        # matters for the multi-GB camera originals this app accepts.
        proc = subprocess.run(
            ["exiftool", "-j", "-api", "largefilesupport=1", path],
            capture_output=True, text=True, timeout=180,
        )
        if proc.returncode != 0 or not proc.stdout:
            return {}
        payload = json.loads(proc.stdout)
        if not isinstance(payload, list) or not payload:
            return {}
        return parse_exiftool_metadata(payload[0])
    except FileNotFoundError:
        logging.getLogger(__name__).warning(
            "exiftool not installed — skipping EXIF pass. "
            "Add libimage-exiftool-perl to the image."
        )
        return {}
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError, ValueError):
        return {}


def parse_exiftool_metadata(exiftool_json: dict) -> dict:
    """Flatten one `exiftool -j <path>` record into technical_metadata keys.

    Complements parse_ffprobe_metadata rather than replacing it: exiftool
    reaches EXIF-class data (exposure, aperture, GPS, orientation, the three
    distinct EXIF timestamps) that ffprobe's generic tag parsing does not,
    across images as well as video.

    Two rules that matter more than the field list:

    - **Empty and placeholder values are skipped entirely**, not stored.
      exiftool returns a key with "" or "-" for a tag it recognizes but has
      no value for; storing that renders a blank row, because the frontend
      whitelist only filters undefined/null.
    - **Raw `MakerNote` is never stored** -- it is an undecoded proprietary
      binary blob, pure bloat with no display value. Manufacturer-decoded
      tags that exiftool *does* understand (white balance, AF points,
      picture style, lens data, and so on, varying by camera) are kept under
      their own snake_cased names, since those are real, readable metadata.

    Never raises: exiftool's output shape varies enormously by file type.
    """
    if not exiftool_json:
        return {}

    result: dict = {}

    for key, candidates in _EXIFTOOL_FIELD_MAP:
        for tag in candidates:
            value = _exiftool_value(exiftool_json.get(tag))
            if value is not None:
                result[key] = value
                break

    # Manufacturer-decoded MakerNote tags. exiftool surfaces these as ordinary
    # named tags (it only leaves "MakerNote" itself as an opaque blob when it
    # has no decoder), so anything left over that isn't structural, isn't
    # already mapped above, and isn't the raw blob is worth keeping.
    mapped_tags = {tag for _, candidates in _EXIFTOOL_FIELD_MAP for tag in candidates}
    for tag, raw in exiftool_json.items():
        if tag in mapped_tags or tag in _EXIFTOOL_STRUCTURAL_TAGS:
            continue
        # The raw undecoded blob, and the GPS composites that duplicate the
        # individual keys already captured above.
        if tag == "MakerNote" or tag.startswith("MakerNote"):
            continue
        if tag.startswith("GPS") and tag not in ("GPSLatitude", "GPSLongitude", "GPSAltitude"):
            continue
        value = _exiftool_value(raw)
        if value is None:
            continue
        result.setdefault(_snake_case_tag(tag), value)

    return result


def _snake_case_tag(tag: str) -> str:
    """"WhiteBalance" -> "white_balance"; "AFPointsUsed" -> "af_points_used"."""
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", tag)
    out = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "_", out)
    return re.sub(r"[^a-zA-Z0-9]+", "_", out).strip("_").lower()


def merge_exiftool_metadata(ffprobe_result: dict, exif_result: dict) -> dict:
    """Merge exiftool output over ffprobe output.

    exiftool wins for camera_make/camera_model/software because it reads
    them from far more formats than ffprobe's QuickTime-tag path. Everything
    else only fills gaps -- ffprobe stays authoritative for codec/stream
    facts, which exiftool reports less precisely.
    """
    merged = dict(ffprobe_result or {})
    if not exif_result:
        return merged

    for key in ("camera_make", "camera_model"):
        if exif_result.get(key):
            merged[key] = exif_result[key]
    # `software` is exiftool's equivalent of ffprobe's QuickTime-only
    # `encoder`; keep it under its own key and let it also override encoder
    # when ffprobe found nothing.
    if exif_result.get("software"):
        merged["software"] = exif_result["software"]
        merged.setdefault("encoder", exif_result["software"])

    for key, value in exif_result.items():
        merged.setdefault(key, value)

    # For image assets, "when was this actually shot" is DateTimeOriginal --
    # a more meaningful creation_time than any container mtime ffprobe saw.
    if exif_result.get("date_time_original"):
        merged["creation_time"] = merged.get("creation_time") or exif_result["date_time_original"]

    return merged


class BaseTranscoder(ABC):
    @abstractmethod
    async def transcode(
        self,
        job: TranscodeJob,
        progress_callback: Optional[Callable[[int], None]] = None,
    ) -> TranscodeResult:
        pass

    @abstractmethod
    async def get_video_metadata(self, s3_key: str) -> VideoMetadata:
        pass

    @abstractmethod
    async def generate_thumbnails(self, s3_key: str, count: int) -> list[str]:
        pass

    @abstractmethod
    async def generate_waveform(self, s3_key: str) -> dict:
        pass
