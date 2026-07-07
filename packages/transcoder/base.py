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
    keys (video_codec, video_bit_rate, visual_bit_depth, alpha_channel,
    color_space, dynamic_range, audio_codec, audio_bit_rate, audio_bit_depth,
    audio_channels, audio_sample_rate).

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
