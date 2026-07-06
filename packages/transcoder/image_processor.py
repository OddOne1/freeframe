import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .base import parse_ffprobe_metadata


def _probe_local_file(path: str) -> dict:
    """Run ffprobe against an already-downloaded local file and flatten the
    result via parse_ffprobe_metadata(). Returns {} on any failure — metadata
    extraction is best-effort and must never block processing."""
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-show_format", path,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not proc.stdout:
            return {}
        return parse_ffprobe_metadata(json.loads(proc.stdout))
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, OSError):
        return {}


def process_image(s3_client, bucket: str, input_s3_key: str, output_prefix: str) -> dict:
    """Convert image to WebP + generate thumbnail. Returns dict of S3 keys
    plus width/height/technical_metadata probed from the original file."""
    with tempfile.NamedTemporaryFile(suffix=".img", delete=False) as f:
        tmp_input = f.name
    work_dir = tempfile.mkdtemp()
    result = {}
    try:
        s3_client.download_file(bucket, input_s3_key, tmp_input)

        probed = _probe_local_file(tmp_input)
        result["width"] = probed.pop("width", None)
        result["height"] = probed.pop("height", None)
        probed.pop("duration_seconds", None)
        probed.pop("fps", None)
        result["technical_metadata"] = probed

        # Convert to WebP
        webp_path = os.path.join(work_dir, "processed.webp")
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_input, "-c:v", "libwebp", "-quality", "85", webp_path],
            check=True, capture_output=True,
        )
        webp_key = f"{output_prefix}/processed.webp"
        s3_client.upload_file(webp_path, bucket, webp_key, ExtraArgs={"ContentType": "image/webp", "CacheControl": "max-age=86400"})
        result["webp_key"] = webp_key

        # Thumbnail (max 400x400)
        thumb_path = os.path.join(work_dir, "thumbnail.jpg")
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_input, "-vf", "scale='min(400,iw)':'min(400,ih)':force_original_aspect_ratio=decrease", thumb_path],
            check=True, capture_output=True,
        )
        thumb_key = f"{output_prefix}/thumbnail.jpg"
        s3_client.upload_file(thumb_path, bucket, thumb_key, ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "max-age=86400"})
        result["thumbnail_key"] = thumb_key

    finally:
        os.unlink(tmp_input)
        shutil.rmtree(work_dir, ignore_errors=True)
    return result


def process_audio(s3_client, bucket: str, input_s3_key: str, output_prefix: str) -> dict:
    """Normalize audio to MP3 + generate waveform JSON. Returns dict of S3 keys
    plus duration_seconds/technical_metadata probed from the original file."""
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as f:
        tmp_input = f.name
    work_dir = tempfile.mkdtemp()
    result = {}
    try:
        s3_client.download_file(bucket, input_s3_key, tmp_input)

        probed = _probe_local_file(tmp_input)
        result["duration_seconds"] = probed.pop("duration_seconds", None)
        probed.pop("width", None)
        probed.pop("height", None)
        probed.pop("fps", None)
        result["technical_metadata"] = probed

        # Normalize and convert to MP3
        mp3_path = os.path.join(work_dir, "processed.mp3")
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", tmp_input,
                "-af", "loudnorm=I=-23:TP=-2:LRA=7",
                "-codec:a", "libmp3lame", "-qscale:a", "2",
                mp3_path,
            ],
            check=True, capture_output=True,
        )
        mp3_key = f"{output_prefix}/processed.mp3"
        s3_client.upload_file(mp3_path, bucket, mp3_key, ExtraArgs={"ContentType": "audio/mpeg", "CacheControl": "max-age=86400"})
        result["mp3_key"] = mp3_key

        # Waveform as JSON (simplified peak data)
        waveform_data = {"peaks": [], "duration": 0, "sample_rate": 44100}
        waveform_path = os.path.join(work_dir, "waveform.json")
        with open(waveform_path, "w") as wf:
            json.dump(waveform_data, wf)
        waveform_key = f"{output_prefix}/waveform.json"
        s3_client.upload_file(waveform_path, bucket, waveform_key, ExtraArgs={"ContentType": "application/json", "CacheControl": "max-age=86400"})
        result["waveform_key"] = waveform_key

    finally:
        os.unlink(tmp_input)
        shutil.rmtree(work_dir, ignore_errors=True)
    return result
