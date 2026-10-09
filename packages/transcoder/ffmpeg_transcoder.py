import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional
import boto3
from botocore.config import Config
from .base import (
    BaseTranscoder, TranscodeJob, TranscodeResult, VideoMetadata,
    parse_ffprobe_metadata, probe_exiftool, merge_exiftool_metadata,
)

logger = logging.getLogger(__name__)

#: How much of ffmpeg's stderr travels with an error or a log line. ffmpeg
#: puts its actual complaint in the LAST few lines -- everything before it is
#: stream banners -- so the tail is the part worth keeping, and 1500
#: characters is enough to hold it without burying a log file.
FFMPEG_STDERR_TAIL_CHARS = 1500

#: generate_thumbnails' contract: one frame per this many seconds.
THUMBNAIL_INTERVAL_SECONDS = 10.0

#: Below this, `fps=1/INTERVAL` emits NO FRAMES AT ALL. The filter rounds
#: duration/INTERVAL to a whole number of output frames, so anything under
#: half an interval rounds to zero -- and an ffmpeg output stream that
#: receives no frames opens its encoder on an unconverted pixel format and
#: dies with the thoroughly misleading "Non full-range YUV is non-standard
#: ... Error while opening encoder", exit 234.
#:
#: Measured, not inferred, against real ffmpeg 7.1.5 (2026-10-09): 4.0 s and
#: 4.9 s clips produce 0 frames and exit 234; 5.0 s produces 1 frame. The
#: boundary is 5 s, not the ~10 s the symptom suggests. A limited-range
#: ("tv") 4 s clip fails identically, which is what rules colour range out
#: as the cause -- it is only ever the error TEXT, never the reason.
MIN_DURATION_FOR_INTERVAL_SECONDS = THUMBNAIL_INTERVAL_SECONDS / 2

#: Matches the query string of any http(s) URL.
_URL_QUERY_RE = re.compile(r"""(https?://[^\s"'<>]+?)\?[^\s"'<>]*""")


class FFmpegError(RuntimeError):
    """An ffmpeg/ffprobe run that failed, carrying ffmpeg's own words.

    Exists because the alternative -- `subprocess.CalledProcessError` from a
    `check=True` call whose output was captured and then dropped -- reports
    an exit code and nothing else. Exit 234 was all this module said about
    the short-clip thumbnail failure; ffmpeg had explained itself in a
    stderr nobody kept.
    """


def redact_presigned_urls(text: str) -> str:
    """Strip the query string off every URL in `text`.

    Every input this module hands ffmpeg is a PRESIGNED URL, and ffmpeg
    echoes its input back into stderr -- so the signature, the credential
    and (on AIStor) the session token are in every message it produces. The
    query string is where all of it lives and none of it is worth logging.

    Deliberately removes the WHOLE query rather than matching the known AWS
    parameter names: a signing scheme this function has not heard of, or an
    AIStor-specific parameter, would otherwise walk straight into a log
    file. Nothing is lost -- the path is what identifies the object.
    """
    if not text:
        return ""
    return _URL_QUERY_RE.sub(r"\1?<redacted>", text)


def stderr_tail(raw) -> str:
    """The last FFMPEG_STDERR_TAIL_CHARS of `raw`, redacted.

    Redacts BEFORE trimming, deliberately. Trimming first can cut a URL in
    half and leave a bare, still-valid signature at the start of the tail
    with no `?` in front of it for the pattern to anchor on.
    """
    if raw is None:
        return ""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    return redact_presigned_urls(str(raw))[-FFMPEG_STDERR_TAIL_CHARS:]


def run_ffmpeg_checked(cmd: list[str], *, timeout: int, what: str) -> subprocess.CompletedProcess:
    """Run `cmd`, and on failure raise an error that says WHY.

    Replaces `subprocess.run(..., capture_output=True, check=True)`, which
    captures ffmpeg's explanation and then throws it away.
    """
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(
            f"{what} timed out after {timeout}s: "
            f"{stderr_tail(exc.stderr) or '<no stderr before the timeout>'}"
        ) from exc
    if proc.returncode != 0:
        raise FFmpegError(
            f"{what} failed (exit {proc.returncode}): "
            f"{stderr_tail(proc.stderr) or '<no stderr>'}"
        )
    return proc


def thumbnail_cmd(
    input_url: str,
    output_pattern: str,
    *,
    interval: Optional[float] = None,
    limit: Optional[int] = None,
    fallback: bool = False,
) -> list[str]:
    """The ONE thumbnail command this module runs, for both call sites.

    Shared so the two cannot drift: they already had, and the single-frame
    one carried an `fps` filter that could only ever hurt it.

    `interval=None` means no fps filter at all -- the clip's FIRST frame.
    This is the only form that works on a clip shorter than
    MIN_DURATION_FOR_INTERVAL_SECONDS.

    `interval=N` keeps the historical sampling, `fps=1/N`.

    **The two forms do not produce the same picture, even when only one
    frame is kept.** Measured against ffmpeg 7.1.5 on a 64.9 s clip:
    `fps=0.1 -frames:v 1` yields the frame at t=4.96 s -- the centre of the
    first 10 s slot, which is where the filter places its first output --
    while no filter yields t=0. So dropping the filter outright would
    silently restyle every thumbnail in the library, which is why the
    choice is the caller's and why transcode() keeps the filter for any
    clip long enough to survive it.

    `fallback=True` is the retry form: no filter, an explicitly chosen
    video stream, every non-video stream ignored, and a pixel format mjpeg
    is guaranteed to accept. Fewer moving parts, for the case where the
    primary command has already failed for a reason we do not know.
    """
    cmd = ["ffmpeg", "-y", "-i", input_url]
    if fallback:
        # An explicit first video stream rather than ffmpeg's default
        # choice, and nothing else mapped: a camera original (MXF
        # especially) can carry several audio and data tracks, and none of
        # them has any business in a jpeg.
        cmd += ["-map", "0:v:0", "-an", "-sn", "-dn"]
    if interval is not None:
        cmd += ["-vf", f"fps={1.0 / interval:g}"]
    if fallback:
        # mjpeg's own complaint in the reported failure was about an
        # unconverted full-range YUV format. With frames actually flowing
        # ffmpeg negotiates this itself, so this is belt-and-braces for a
        # source whose format it cannot -- not the fix for the short-clip
        # bug, which is the absent fps filter above.
        cmd += ["-pix_fmt", "yuvj420p"]
    cmd += ["-q:v", "2"]
    if limit is not None:
        cmd += ["-frames:v", str(limit)]
    cmd.append(output_pattern)
    return cmd


class FFmpegTranscoder(BaseTranscoder):
    def __init__(self, s3_client, bucket: str, s3_endpoint: str = None):
        self.s3 = s3_client
        self.bucket = bucket
        self.s3_endpoint = s3_endpoint
    
    def _get_presigned_url(self, s3_key: str, expires_in: int = 7200) -> str:
        """Generate a presigned URL for streaming input to FFmpeg."""
        return self.s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": s3_key},
            ExpiresIn=expires_in,
        )

    async def get_video_metadata(self, s3_key: str) -> VideoMetadata:
        """Get video metadata using streaming (no full download)."""
        input_url = self._get_presigned_url(s3_key)
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-select_streams", "v:0", input_url,
        ]
        result = run_ffmpeg_checked(cmd, timeout=120, what="ffprobe metadata")
        data = json.loads(result.stdout)
        stream = data["streams"][0]
        fps_parts = stream.get("r_frame_rate", "30/1").split("/")
        fps = float(fps_parts[0]) / float(fps_parts[1])
        return VideoMetadata(
            duration_seconds=float(stream.get("duration", 0)),
            width=int(stream.get("width", 0)),
            height=int(stream.get("height", 0)),
            fps=fps,
        )

    async def generate_thumbnails(self, s3_key: str, count: int) -> list[str]:
        """Thumbnails at one per THUMBNAIL_INTERVAL_SECONDS, streaming input.

        A clip shorter than half an interval still owes ONE frame. `fps=0.1`
        alone cannot deliver it -- it emits nothing and ffmpeg exits 234 --
        so an empty result is retried without the filter. The retry is
        driven by what the first run actually produced rather than by a
        duration this function does not have: it would need its own ffprobe
        pass to learn one, and the file is the authority either way.

        The returned paths live in a directory the CALLER now owns and must
        remove. They used to be deleted by this function's own `finally`
        before it returned them, which made every path it handed back point
        at nothing.
        """
        input_url = self._get_presigned_url(s3_key)
        thumb_dir = tempfile.mkdtemp()
        pattern = f"{thumb_dir}/thumb_%04d.jpg"
        try:
            # Not check-raising: for a short clip this run FAILS, and that
            # failure is expected and recoverable. A source that is broken
            # for some other reason still raises -- from the retry below,
            # which does check, and whose stderr is the useful one.
            subprocess.run(
                thumbnail_cmd(input_url, pattern, interval=THUMBNAIL_INTERVAL_SECONDS),
                capture_output=True, timeout=600,
            )
            frames = sorted(Path(thumb_dir).glob("thumb_*.jpg"))
            if not frames:
                run_ffmpeg_checked(
                    thumbnail_cmd(input_url, pattern, interval=None, limit=1),
                    timeout=600, what="single-frame thumbnail",
                )
                frames = sorted(Path(thumb_dir).glob("thumb_*.jpg"))
            if not frames:
                raise FFmpegError(
                    "thumbnail generation produced no frames and reported no error"
                )
            return [str(p) for p in frames]
        except Exception:
            # Only on the failure path: on success these are the return
            # value, and the caller owns them.
            shutil.rmtree(thumb_dir, ignore_errors=True)
            raise

    async def generate_waveform(self, s3_key: str) -> dict:
        """Generate waveform data for audio visualization using streaming."""
        input_url = self._get_presigned_url(s3_key)
        # Simplified waveform: just return peak data (full waveform extraction is complex)
        return {"samples": [], "peak": 1.0, "source": s3_key}

    @staticmethod
    def _run_ffmpeg_with_progress(
        cmd: list[str],
        total_duration: float,
        progress_callback: Optional[Callable[[int], None]],
        timeout: int,
        heartbeat_callback: Optional[Callable[[int], None]] = None,
    ) -> None:
        """Run an ffmpeg command that already has `-progress pipe:1` appended,
        streaming percent-complete to progress_callback as ffmpeg reports
        out_time_ms= lines. Capped at 99% — the caller sets 100 only once the
        HLS files are actually uploaded, so the bar can't lie about being done
        while upload is still in flight. Falls back to no callbacks (transcode
        still completes normally) when total_duration is 0/unknown.

        stderr goes to a TEMPORARY FILE rather than being captured or
        discarded. This used to be DEVNULL, which meant the one failure that
        costs the most -- the ladder itself, after minutes of encoding -- was
        reported as a bare exit code. It cannot be a pipe: this loop reads
        stdout to completion, and a parallel stderr pipe filling its buffer
        would deadlock the pair. A file has no such limit, and only its tail
        is ever read."""
        stderr_file = tempfile.NamedTemporaryFile(
            mode="w+", suffix=".ffmpeg.log", prefix="hls_", delete=False,
        )
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=stderr_file, text=True, bufsize=1,
        )
        deadline = time.monotonic() + timeout
        last_reported = -1
        timed_out = False
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if time.monotonic() > deadline:
                    process.kill()
                    timed_out = True
                    break
                line = line.strip()
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                # §219 — the third silent phase, and the one that hides.
                #
                # Everything below is gated on `total_duration > 0`, so an
                # encode whose duration ffprobe could not read (a tolerated,
                # non-fatal outcome just above) reports NO percent for its
                # entire run -- up to the four-hour timeout -- and the
                # version row is never touched. The heartbeat is fired from
                # the progress line itself instead, which is unconditional
                # and is still real evidence of life: a wedged ffmpeg stops
                # writing lines, so the beats stop with it.
                if key == "out_time_ms" and heartbeat_callback:
                    heartbeat_callback(1)
                if key == "out_time_ms" and total_duration > 0 and progress_callback:
                    try:
                        out_seconds = int(value) / 1_000_000
                    except ValueError:
                        continue
                    percent = max(0, min(99, int((out_seconds / total_duration) * 100)))
                    if percent != last_reported:
                        last_reported = percent
                        progress_callback(percent)
            if not timed_out:
                process.wait(timeout=max(0, deadline - time.monotonic()))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            # Read the tail before the file is unlinked -- it is the whole
            # point of writing one.
            try:
                stderr_file.flush()
                stderr_file.seek(0)
                tail = stderr_tail(stderr_file.read())
            except Exception:  # noqa: BLE001
                tail = ""
            stderr_file.close()
            try:
                os.unlink(stderr_file.name)
            except OSError:
                pass
        if timed_out:
            raise FFmpegError(
                f"HLS transcode timed out after {timeout}s: {tail or '<no stderr>'}"
            )
        if process.returncode != 0:
            raise FFmpegError(
                f"HLS transcode failed (exit {process.returncode}): {tail or '<no stderr>'}"
            )

    def _make_thumbnail(
        self, input_url: str, work_dir: Path, duration_seconds: float
    ) -> Optional[Path]:
        """One thumbnail frame, or None. NEVER raises.

        Step 5 of transcode() runs AFTER the whole ladder has been encoded
        and uploaded, so anything that escapes from here throws away work
        that is already finished and correct: process_asset marks the
        version `failed` and retries the entire transcode from scratch. That
        is what a 4 s clip cost -- minutes to hours of encoding, repeatedly,
        for a missing jpeg.

        A missing thumbnail is a cosmetic gap every consumer already
        handles: `s3_key_thumbnail` is nullable, both asset serializers
        default `thumbnail_url` to None and test the key before using it,
        and every web surface falls back to a type icon.

        Two attempts, then give up:

        1. The historical sampling (`fps`) when the clip is long enough for
           it, so a normal clip's thumbnail stays byte-identical to the one
           it has today. Short clips skip straight past it -- that filter is
           exactly what breaks them -- and so does a clip whose duration is
           unknown, which is the one case where the filter form is tried
           first on the chance the probe was simply unavailable.
        2. The fallback: no filter, one explicitly mapped video stream, a
           pixel format mjpeg accepts.
        """
        pattern = str(work_dir / "thumb_%04d.jpg")
        known = duration_seconds or 0
        if 0 < known < MIN_DURATION_FOR_INTERVAL_SECONDS:
            primary = thumbnail_cmd(input_url, pattern, interval=None, limit=1)
        else:
            primary = thumbnail_cmd(
                input_url, pattern, interval=THUMBNAIL_INTERVAL_SECONDS, limit=1,
            )
        attempts = [
            primary,
            thumbnail_cmd(input_url, pattern, interval=None, limit=1, fallback=True),
        ]

        last_detail = "<no stderr>"
        for attempt_no, cmd in enumerate(attempts, start=1):
            # Clear any partial file the previous attempt left behind, so
            # "did this attempt produce a frame" cannot be answered by the
            # last one's wreckage.
            for stale in work_dir.glob("thumb_*.jpg"):
                try:
                    stale.unlink()
                except OSError:
                    pass
            try:
                proc = subprocess.run(cmd, capture_output=True, timeout=600)
                returncode, detail = proc.returncode, stderr_tail(proc.stderr)
            except subprocess.TimeoutExpired as exc:
                returncode, detail = None, stderr_tail(exc.stderr) or "<timed out>"
            except OSError as exc:
                # ffmpeg missing from the image, or no room to fork.
                returncode, detail = None, f"could not run ffmpeg: {exc}"
            # What was WRITTEN decides, not just the exit code: the reported
            # failure exits non-zero having produced nothing, and a run that
            # exits 0 having produced nothing is just as useless.
            produced = sorted(work_dir.glob("thumb_*.jpg"))
            if returncode == 0 and produced:
                return produced[0]
            last_detail = detail or "<no stderr>"
            logger.info(
                "Thumbnail attempt %d/%d produced no usable frame (exit %s)",
                attempt_no, len(attempts), returncode,
            )

        logger.warning(
            "Thumbnail generation failed for %s after %d attempts; the "
            "transcode itself is complete and is NOT being discarded. This "
            "asset will have no thumbnail. ffmpeg stderr tail: %s",
            work_dir.name, len(attempts), last_detail,
        )
        return None

    async def transcode(
        self,
        job: TranscodeJob,
        progress_callback: Optional[Callable[[int], None]] = None,
        heartbeat_callback: Optional[Callable[[int], None]] = None,
    ) -> TranscodeResult:
        """
        Transcode video using streaming input from S3.
        FFmpeg reads directly from presigned URL - no full download needed.
        Only output files are written to disk, reducing disk usage by ~2/3.
        """
        work_dir = Path(tempfile.mkdtemp(prefix=f"transcode_{job.version_id}_"))
        
        # Generate presigned URL for streaming input (2 hour expiry for large files)
        input_url = self._get_presigned_url(job.input_s3_key, expires_in=7200)

        try:
            # 1. Probe metadata via streaming (no download) — feeds both the
            # Fields tab technical_metadata persisted onto MediaFile below,
            # and (indirectly) confirms the input is readable before we
            # commit to a full transcode.
            probe_cmd = [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", input_url,
            ]
            probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=120)
            probed: dict = {}
            if probe_result.returncode == 0 and probe_result.stdout:
                try:
                    probed = parse_ffprobe_metadata(json.loads(probe_result.stdout))
                except (json.JSONDecodeError, KeyError):
                    logger.warning(
                        "ffprobe output for %s could not be parsed; continuing "
                        "without technical metadata", job.input_s3_key, exc_info=True,
                    )
                    probed = {}
            else:
                # Deliberately not fatal -- the transcode below can still
                # succeed without metadata -- but it used to be entirely
                # silent, and it is also what leaves duration unknown, which
                # step 5 now reads to pick its thumbnail command.
                logger.warning(
                    "ffprobe failed for %s (exit %s); continuing without "
                    "technical metadata. stderr tail: %s",
                    job.input_s3_key, probe_result.returncode,
                    stderr_tail(probe_result.stderr) or "<no stderr>",
                )

            # EXIF pass. This is the only step in the whole pipeline that
            # needs the source on local disk -- exiftool cannot read the
            # presigned URL everything else streams from -- so the file is
            # pulled down, read, and deleted again immediately rather than
            # being kept for the duration of the transcode. On multi-GB
            # camera originals that download is a real added cost; it buys
            # EXIF/camera data that ffprobe's tag parsing cannot reach.
            # Wrapped so a download or exiftool failure degrades to
            # ffprobe-only metadata instead of failing the transcode.
            #
            # §219 — and it is the longest silent phase in the pipeline. On a
            # 95 GiB master this download runs for tens of minutes before the
            # first progress percent is ever committed, which the
            # stuck-processing sweeper reads as a hang. `heartbeat_callback`
            # is handed to boto3 as its transfer `Callback`, so the beat is
            # driven by bytes that actually arrived: a stalled read produces
            # no callbacks and therefore no beats, which is the behaviour the
            # sweeper needs to stay useful.
            exif_path = work_dir / f"exifsrc_{job.version_id}"
            try:
                self.s3.download_file(
                    self.bucket, job.input_s3_key, str(exif_path),
                    # Spread rather than passed as Callback=None: a caller
                    # with no heartbeat must reach boto3 with exactly the
                    # arguments it always did.
                    **({"Callback": heartbeat_callback} if heartbeat_callback else {}),
                )
                probed = merge_exiftool_metadata(probed, probe_exiftool(str(exif_path)))
            except Exception:
                pass
            finally:
                # work_dir is rmtree'd in the outer finally regardless; this
                # just avoids holding a second full-size copy on disk for the
                # entire encode.
                try:
                    if exif_path.exists():
                        exif_path.unlink()
                except OSError:
                    pass

            # 3. Build quality ladder based on available qualities
            QUALITY_MAP = {
                "1080p": ("1920:1080", 20),
                "720p": ("1280:720", 22),
                "360p": ("640:360", 26),
            }
            qualities = [q for q in job.qualities if q in QUALITY_MAP]

            hls_dir = work_dir / "hls"
            hls_dir.mkdir()

            # Build filter_complex and map args
            # Use force_original_aspect_ratio=decrease to preserve aspect ratio,
            # then pad to even dimensions required by libx264
            split_outputs = "".join(f"[v{i}]" for i in range(len(qualities)))
            filter_complex = f"[v:0]split={len(qualities)}{split_outputs};"
            filter_complex += ";".join(
                f"[v{i}]scale={QUALITY_MAP[q][0]}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2[{q}]"
                for i, q in enumerate(qualities)
            )

            ffmpeg_cmd = [
                "ffmpeg", "-y", "-i", input_url,
                "-filter_complex", filter_complex,
            ]

            for i, quality in enumerate(qualities):
                scale, crf = QUALITY_MAP[quality]
                ffmpeg_cmd += [
                    "-map", f"[{quality}]", "-map", "a:0",
                    f"-c:v:{i}", "libx264", f"-crf", str(crf), "-preset", "fast",
                    # §117 — PIN 8-BIT 4:2:0. Without this x264 inherits the
                    # SOURCE pixel format, so a 10-bit or 4:2:2 master (ProRes
                    # 422, Log, essentially any professional camera) produces
                    # High 10 or High 4:2:2 renditions. Chromium software-
                    # decodes those, which is why playback looked fine there,
                    # but Apple's video decoder does not: Safari plays the AAC
                    # track and shows no picture at all.
                    #
                    # These are delivery renditions, not masters -- the
                    # original is kept untouched as s3_key_raw and is what any
                    # download or NLE round-trip uses -- so there is nothing to
                    # preserve by carrying 10-bit through to HLS.
                    f"-pix_fmt:v:{i}", "yuv420p",
                    # Pinned for the same reason: an unconstrained profile/level
                    # can still emit something a hardware decoder refuses.
                    f"-profile:v:{i}", "high",
                    f"-level:v:{i}", "4.1",
                    "-force_key_frames", "expr:gte(t,n_forced*2)",
                ]

            segment_dir = hls_dir / "%v"
            ffmpeg_cmd += [
                "-f", "hls",
                "-hls_time", "2",
                "-hls_playlist_type", "vod",
                "-hls_flags", "independent_segments",
                "-hls_segment_type", "mpegts",
                "-master_pl_name", "master.m3u8",
                "-var_stream_map", " ".join(f"v:{i},a:{i}" for i in range(len(qualities))),
                "-hls_segment_filename", str(hls_dir / "%v" / "seg_%03d.ts"),
                str(hls_dir / "%v" / "playlist.m3u8"),
            ]

            # Create per-quality directories
            for q in qualities:
                (hls_dir / q).mkdir(exist_ok=True)

            ffmpeg_cmd += ["-progress", "pipe:1", "-nostats"]

            # Timeout scales with expected duration - 4 hours for very large files.
            # Streamed via Popen (see _run_ffmpeg_with_progress) instead of a single
            # blocking subprocess.run, so real percent-complete can be reported while
            # the transcode is still running rather than only success/failure at the end.
            total_duration = probed.get("duration_seconds") or 0
            self._run_ffmpeg_with_progress(
                ffmpeg_cmd, total_duration, progress_callback, timeout=14400,
                heartbeat_callback=heartbeat_callback,
            )

            # 4. Upload HLS files to S3
            uploaded_keys = []
            for f in hls_dir.rglob("*"):
                if f.is_file():
                    relative = f.relative_to(hls_dir)
                    s3_key = f"{job.output_s3_prefix}/{relative}"
                    content_type, cache_control = self._get_content_type(f.name)
                    self.s3.upload_file(
                        str(f), self.bucket, s3_key,
                        ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
                        # §219 — the second silent phase. The encode's last
                        # progress report is 99%, and the ladder for a long
                        # source is then many GB pushed object by object with
                        # nothing touching the version row.
                        **({"Callback": heartbeat_callback} if heartbeat_callback else {}),
                    )
                    uploaded_keys.append(s3_key)

            # 5. Generate and upload thumbnail (using streaming URL).
            #
            # Nothing in this step may fail the transcode. The ladder above
            # is encoded AND uploaded by now; raising here would have
            # process_asset mark the version `failed` and re-run all of it.
            thumbnail_keys: list[str] = []
            thumb_path = self._make_thumbnail(
                input_url, work_dir, probed.get("duration_seconds") or 0,
            )
            if thumb_path is not None:
                thumbnail_key = f"{job.output_s3_prefix}/thumbnail.jpg"
                try:
                    self.s3.upload_file(
                        str(thumb_path), self.bucket, thumbnail_key,
                        ExtraArgs={"ContentType": "image/jpeg", "CacheControl": "max-age=86400"},
                    )
                    thumbnail_keys = [thumbnail_key]
                except Exception:
                    # Same reasoning as the generation step: the HLS objects
                    # are already in the bucket, and one failed PUT of a
                    # jpeg is not worth re-encoding them for.
                    logger.warning(
                        "Thumbnail upload failed for %s; the transcode is "
                        "complete and is NOT being discarded",
                        job.output_s3_prefix, exc_info=True,
                    )

            dims = {
                k: probed.pop(k, None)
                for k in ("width", "height", "duration_seconds", "fps")
            }
            return TranscodeResult(
                success=True,
                hls_prefix=job.output_s3_prefix,
                thumbnail_keys=thumbnail_keys,
                width=dims["width"],
                height=dims["height"],
                duration_seconds=dims["duration_seconds"],
                fps=dims["fps"],
                technical_metadata=probed,
            )

        except Exception as e:
            return TranscodeResult(success=False, error=str(e))
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def build_download_proxy(self, input_s3_key: str, output_s3_key: str) -> None:
        """Transcode one standalone 1080p MP4 and upload it (§57).

        A plain file, NOT an HLS ladder: this is what downloads and NLE
        ingest consume, and a segmented stream is the wrong shape for both.
        `transcode()` above stays untouched — playback is unchanged.

        The encode settings deliberately match the 1080p rung of
        QUALITY_MAP and lut_tasks' own export ladder (scale to fit, pad to
        even, libx264, crf 20), so a download derived from this file is the
        same picture a download re-encoded from the original would have
        been. If those two ever diverge, a "1080p" download would silently
        mean two different things depending on how heavy the source was.

        Extra beyond the ladder, and needed because this is a file someone
        downloads rather than a segment a player consumes: an explicit audio
        codec (the ladder inherits ffmpeg's mpegts default, which is wrong
        for MP4) and +faststart, so it plays before it has fully arrived.
        """
        work_dir = Path(tempfile.mkdtemp(prefix="proxy1080_"))
        try:
            output_path = work_dir / "proxy_1080p.mp4"
            cmd = [
                "ffmpeg", "-y", "-i", self._get_presigned_url(input_s3_key),
                "-vf",
                "scale=1920:1080:force_original_aspect_ratio=decrease,"
                "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                # No -r, matching the ladder: ffmpeg keeps the source's rate.
                str(output_path),
            ]
            run_ffmpeg_checked(cmd, timeout=14400, what="1080p download proxy")
            self.s3.upload_file(
                str(output_path), self.bucket, output_s3_key,
                ExtraArgs={"ContentType": "video/mp4", "CacheControl": "max-age=31536000"},
            )
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    @staticmethod
    def _get_content_type(filename: str) -> tuple[str, str]:
        ext = Path(filename).suffix.lower()
        MAP = {
            ".m3u8": ("application/vnd.apple.mpegurl", "no-cache"),
            ".ts": ("video/mp2t", "max-age=31536000"),
            ".jpg": ("image/jpeg", "max-age=86400"),
        }
        return MAP.get(ext, ("application/octet-stream", "no-cache"))
