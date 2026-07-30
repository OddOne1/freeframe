import re
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
