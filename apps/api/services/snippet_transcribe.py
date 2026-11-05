"""SocialSnippet transcription: the decisions, without Whisper, S3 or a database.

Everything here is a plain function over plain data, so it can be tested
without a model, a worker or a session. The orchestration that calls these
(downloads, ffmpeg, the model, snippet_jobs rows) lives in
tasks/transcribe_tasks.py.

Data shapes used throughout
---------------------------
An audio stream, as in ``MediaFile.technical_metadata["audio_streams"]``::

    {"stream_index": 1, "audio_index": 0, "codec": "aac", "channels": 1,
     "channel_layout": "mono", "sample_rate": 48000, "language": "deu",
     "title": "Lav A", "duration_seconds": 3601.2}

``audio_index`` is the ordinal among the file's AUDIO streams, what ffmpeg
calls ``0:a:N`` and what ``snippet_track_speakers.track_index`` stores.

A segment, as faster-whisper produces it with ``word_timestamps=True``
(times in seconds, absolute within the track)::

    {"start": 1.2, "end": 3.4, "text": " Hallo zusammen.",
     "words": [{"start": 1.2, "end": 1.6, "word": " Hallo", "probability": 0.98},
               ...]}

``track_words`` is ``{audio_index: [segment, ...]}``.
"""

from __future__ import annotations

import array
import math
import sys
import wave
from typing import Callable, Iterable, Optional

#: Whisper's own limit on the prompt is 224 tokens, half of which it reserves.
#: 200 characters stays well inside that for any script and leaves the
#: prompt short enough not to steer the model's style.
INITIAL_PROMPT_MAX_CHARS = 200

#: The level used for "no signal at all", so log10 never sees zero. -200 dBFS
#: is far below anything a 16-bit file can represent (about -96 dBFS).
_SILENCE_DB = -200.0


# ── Track selection ──────────────────────────────────────────────────────────


def _track_index_of(row) -> Optional[int]:
    """A mapped track as an int, from an int or anything with .track_index."""
    value = getattr(row, "track_index", row)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def select_tracks(audio_streams, mapped_tracks) -> tuple[list[int], str]:
    """Which audio tracks (``audio_index`` values) to transcribe, and why.

    1. Mapped tracks (rows of snippet_track_speakers for this file, or their
       track indexes) win outright: exactly those, nothing else.
    2. One audio stream: that one.
    3. Several: a stereo stream (channels >= 2) is skipped when the others
       include mono streams. On a multitrack recording the stereo track is
       the fullmix of the mono lavaliers, and transcribing it would repeat
       every word under no speaker. If nothing is left, audio_index 0.
    4. No audio streams and no mapping: nothing (an empty list).
    """
    mapped = sorted({i for i in (_track_index_of(r) for r in (mapped_tracks or [])) if i is not None})
    if mapped:
        return mapped, f"mapped tracks {mapped}"

    streams = [s for s in (audio_streams or []) if isinstance(s, dict)]
    usable = [s for s in streams if _track_index_of(s.get("audio_index")) is not None]

    if not streams:
        return [], "no audio streams"
    if len(streams) == 1:
        if usable:
            idx = usable[0]["audio_index"]
            return [idx], f"single audio stream {idx}"
        return [0], "single audio stream without an index; using audio_index 0"

    def _channels(s) -> Optional[int]:
        c = s.get("channels")
        return c if isinstance(c, int) and not isinstance(c, bool) else None

    has_mono = any(_channels(s) == 1 for s in usable)
    stereo = [s for s in usable if (_channels(s) or 0) >= 2]
    if has_mono and stereo:
        kept = [s for s in usable if not ((_channels(s) or 0) >= 2)]
        skipped = sorted(s["audio_index"] for s in stereo)
        reason = f"{len(streams)} audio streams; skipped stereo fullmix {skipped}"
    else:
        kept = usable
        reason = f"{len(streams)} audio streams"

    indexes = sorted({s["audio_index"] for s in kept})
    if not indexes:
        return [0], f"{len(streams)} audio streams, none usable; using audio_index 0"
    return indexes, f"{reason}; using {indexes}"


def audio_streams_from_ffprobe(payload) -> list[dict]:
    """``ffprobe -show_streams -of json`` output -> the audio_streams shape.

    Used when a file's technical_metadata has no ``audio_streams`` key, so the
    pipeline can still choose tracks from the original it has downloaded.
    """
    out = []
    streams = (payload or {}).get("streams") if isinstance(payload, dict) else None
    for stream in streams or []:
        if not isinstance(stream, dict) or stream.get("codec_type") != "audio":
            continue
        tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}

        def _num(value, cast):
            try:
                return cast(value)
            except (TypeError, ValueError):
                return None

        out.append({
            "stream_index": _num(stream.get("index"), int),
            "audio_index": len(out),
            "codec": stream.get("codec_name"),
            "channels": _num(stream.get("channels"), int),
            "channel_layout": stream.get("channel_layout"),
            "sample_rate": _num(stream.get("sample_rate"), int),
            "language": tags.get("language"),
            "title": tags.get("title"),
            "duration_seconds": _num(stream.get("duration"), float),
        })
    return out


# ── Prompt ───────────────────────────────────────────────────────────────────


def build_initial_prompt(speaker_names: Iterable[str], max_chars: int = INITIAL_PROMPT_MAX_CHARS) -> str:
    """The project's speaker names as a Whisper ``initial_prompt``.

    The names are what Whisper is likeliest to misspell (proper nouns), and
    seeing them in the prompt is the one cheap lever for that. Names are kept
    whole: a name that does not fit is left out rather than cut, because
    half a surname would teach the model the wrong spelling. Case-insensitive
    duplicates are dropped. Empty when there are no names.
    """
    seen = set()
    names = []
    for raw in speaker_names or []:
        name = " ".join(str(raw or "").split())
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        names.append(name)

    prompt = ""
    for name in names:
        candidate = f"{prompt}, {name}" if prompt else name
        # +1 for the closing full stop.
        if len(candidate) + 1 <= max_chars:
            prompt = candidate
    return f"{prompt}." if prompt else ""


# ── Levels ───────────────────────────────────────────────────────────────────


_TYPECODES = {1: "b", 2: "h", 4: "i"}


def rms_profile(wav_path: str, frame_ms: int = 100) -> list[float]:
    """RMS per ``frame_ms`` frame of a PCM WAV, as a fraction of full scale (0..1).

    Stdlib only (wave + array): numpy is not a declared dependency of the
    API image. Reads one frame at a time, so a two-hour track never sits in
    memory as a sample list. Multichannel files are measured over all
    channels together; the pipeline only feeds it the mono 16 kHz WAVs it
    extracts itself.
    """
    if frame_ms <= 0:
        raise ValueError("frame_ms must be positive")
    with wave.open(wav_path, "rb") as wav:
        width = wav.getsampwidth()
        rate = wav.getframerate()
        if width not in _TYPECODES and width != 3:
            raise ValueError(f"unsupported sample width {width} bytes")
        per_frame = max(1, int(round(rate * frame_ms / 1000)))
        full_scale = float(1 << (8 * width - 1))
        out = []
        while True:
            chunk = wav.readframes(per_frame)
            if not chunk:
                break
            samples = _decode(chunk, width)
            if not samples:
                break
            if width == 1:
                # 8-bit WAV is unsigned, centred on 128.
                samples = [s - 128 for s in samples]
            energy = math.fsum(s * s for s in samples) / len(samples)
            out.append(math.sqrt(energy) / full_scale)
        return out


def _decode(chunk: bytes, width: int):
    if width == 3:
        # 24-bit little-endian, sign-extended by hand.
        return [
            int.from_bytes(chunk[i:i + 3], "little", signed=True)
            for i in range(0, len(chunk) - len(chunk) % 3, 3)
        ]
    if width == 1:
        return list(chunk)
    samples = array.array(_TYPECODES[width])
    samples.frombytes(chunk[: len(chunk) - len(chunk) % width])
    if sys.byteorder == "big":
        samples.byteswap()  # WAV is little-endian
    return samples


def _to_db(rms: float) -> float:
    return 20.0 * math.log10(rms) if rms > 0 else _SILENCE_DB


def span_level_db(rms: list[float], start: float, end: float, frame_ms: int = 100) -> float:
    """Level in dBFS over [start, end) seconds: the RMS of the frames it touches.

    A span shorter than one frame still reads the frame it starts in. A span
    past the end of the profile reads as silence.
    """
    if not rms:
        return _SILENCE_DB
    first = max(0, int(math.floor(start * 1000 / frame_ms)))
    last = max(first + 1, int(math.ceil(end * 1000 / frame_ms)))
    frames = rms[first:last]
    if not frames:
        return _SILENCE_DB
    return _to_db(math.sqrt(math.fsum(v * v for v in frames) / len(frames)))


# ── Bleed gate ───────────────────────────────────────────────────────────────


def _join_words(words: list[dict]) -> str:
    # faster-whisper's words carry their own leading space.
    return "".join(str(w.get("word") or "") for w in words).strip()


def gate_words_by_track(
    track_words: dict,
    track_rms: dict,
    margin_db: float,
    min_keep_ratio: float,
    frame_ms: int = 100,
) -> dict:
    """Drop words a track only heard as bleed from another speaker's mic.

    With two or more tracks, a word on track T is kept only if T's level over
    the word's span is within ``margin_db`` of the loudest track over that
    same span. The speaker whose microphone it is will be the loudest; the
    others hear them several dB down. A segment is dropped when fewer than
    ``min_keep_ratio`` of its words survive; a kept segment that lost words
    has its text rebuilt from the words that remain, and its start/end
    narrowed to them. A segment without word timings is gated as one word
    over its own span.

    With one track there is nothing to compare against and the input is
    returned unchanged. The input is never mutated.
    """
    if len(track_words) < 2:
        return track_words

    def _loudest(start: float, end: float) -> float:
        return max(
            (span_level_db(track_rms.get(t) or [], start, end, frame_ms) for t in track_words),
            default=_SILENCE_DB,
        )

    def _keep(track, start: float, end: float) -> bool:
        own = span_level_db(track_rms.get(track) or [], start, end, frame_ms)
        return own >= _loudest(start, end) - margin_db

    out = {}
    for track, segments in track_words.items():
        kept_segments = []
        for seg in segments or []:
            words = [w for w in (seg.get("words") or []) if isinstance(w, dict)]
            if not words:
                if _keep(track, float(seg["start"]), float(seg["end"])):
                    kept_segments.append(dict(seg))
                continue
            kept = [w for w in words if _keep(track, float(w["start"]), float(w["end"]))]
            if not kept or len(kept) / len(words) < min_keep_ratio:
                continue
            new_seg = dict(seg)
            new_seg["words"] = [dict(w) for w in kept]
            if len(kept) != len(words):
                new_seg["text"] = _join_words(kept)
                new_seg["start"] = float(kept[0]["start"])
                new_seg["end"] = max(float(kept[-1]["end"]), new_seg["start"])
            kept_segments.append(new_seg)
        out[track] = kept_segments
    return out


# ── Scope ────────────────────────────────────────────────────────────────────


def folder_in_scope(
    folder_id,
    source_folder_id,
    parent_of: Callable[[object], object],
    max_depth: int = 256,
) -> bool:
    """Is ``folder_id`` the source folder or one of its descendants?

    ``source_folder_id`` None means the whole project is in scope.
    ``parent_of(folder_id)`` returns the parent's id, or None at the root.
    The walk is bounded and remembers where it has been, so a corrupt
    parent cycle ends as "not in scope" instead of hanging the worker.
    """
    if source_folder_id is None:
        return True
    seen = set()
    current = folder_id
    for _ in range(max_depth):
        if current is None or current in seen:
            return False
        if current == source_folder_id:
            return True
        seen.add(current)
        current = parent_of(current)
    return False


# ── Output ───────────────────────────────────────────────────────────────────


def combined_segments(gated: dict) -> list[dict]:
    """Every track's segments in one list, ordered by time (then track).

    The shape transcript.json and captions.vtt have always had, so the
    existing transcript panel reads a multitrack file like any other:
    ``{"id", "start", "end", "text"}``, ids renumbered from 0.
    """
    flat = []
    for track, segments in gated.items():
        for seg in segments or []:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            flat.append((float(seg["start"]), int(track), float(seg["end"]), text))
    flat.sort(key=lambda row: (row[0], row[1]))
    return [
        {"id": i, "start": start, "end": end, "text": text}
        for i, (start, _track, end, text) in enumerate(flat)
    ]


def dominant_language(tracks: dict, gated: dict) -> tuple[Optional[str], Optional[float]]:
    """The language of the track with the most surviving words.

    ``tracks`` is ``{audio_index: {"language": ..., "language_probability": ...}}``.
    transcript.json and MediaFile.transcript_language hold one language; per
    segment the language is kept on transcript_segments.
    """
    best = None
    best_count = -1
    for track, segments in gated.items():
        count = sum(len(s.get("words") or []) or 1 for s in segments or [])
        if count > best_count:
            best, best_count = track, count
    if best is None:
        return None, None
    info = tracks.get(best) or {}
    return info.get("language"), info.get("language_probability")
