"""Write one file's transcript out, as JSON or as a readable Markdown script.

For handing a transcript to someone who is not going to open the app: a
reviewer, a translator, or a model you are running yourself and then
feeding back through snippet_import.py.

NOTHING here calls an external service. It reads the database, formats
text, and prints it (or writes --out). There is no model, no S3 and no
network: the transcript already lives in `transcript_segments`.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_export \\
        --media-file-id <uuid> --format md

    docker-compose exec api python -m apps.api.scripts.snippet_export \\
        --media-file-id <uuid> --format json --out /tmp/transcript.json

`--format json` is the machine shape -- media file id, asset name,
language, and every segment with its track, speaker name and times in
milliseconds. `--format md` is for reading: one line per segment, prefixed
with [mm:ss] and the speaker's name.

A soft-deleted asset exports nothing: the transcript is reached through
`TranscriptSegment.live`, the one implementation of that rule
(models/snippet.py), and the script says so rather than printing an empty
transcript.
"""
import argparse
import json
import sys
import uuid

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.snippet import SnippetSpeaker, TranscriptSegment

from apps.api.scripts.snippet_set_track_speaker import ScriptError

#: Shown in both formats where a segment's speaker was never named. A track
#: with nobody mapped to it is normal (see snippet_set_track_speaker.py), so
#: this is not an error.
UNKNOWN_SPEAKER = "Unknown"


def _timestamp(ms: int) -> str:
    """[mm:ss], or [h:mm:ss] past an hour.

    Floor, not round: a reader scrubbing to the stamp must land at or before
    the words, never after them.
    """
    total = max(0, int(ms)) // 1000
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"[{hours}:{minutes:02d}:{seconds:02d}]"
    return f"[{minutes:02d}:{seconds:02d}]"


def load_transcript(db, media_file_id) -> dict:
    """Everything both formats need, in one plain dict.

    Ordered by time across tracks, then by track, so two speakers who
    overlap come out in a stable order rather than whichever row the
    database returned first.
    """
    media_file = db.query(MediaFile).filter(MediaFile.id == media_file_id).first()
    if media_file is None:
        raise ScriptError(f"No media file {media_file_id}.")

    version = (
        db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    )
    asset = (
        db.query(Asset).filter(Asset.id == version.asset_id).first()
        if version is not None else None
    )
    if asset is None:
        raise ScriptError(f"Media file {media_file_id} has no asset.")
    if asset.deleted_at is not None:
        raise ScriptError(
            f"The asset of media file {media_file_id} ({asset.name!r}) is in the trash. "
            f"Restore it before exporting its transcript."
        )

    names = {
        speaker_id: name
        for speaker_id, name in db.query(SnippetSpeaker.id, SnippetSpeaker.name).all()
    }
    segments = (
        TranscriptSegment.live(db)
        .filter(TranscriptSegment.media_file_id == media_file_id)
        .order_by(TranscriptSegment.start_ms, TranscriptSegment.track_index,
                  TranscriptSegment.seq)
        .all()
    )
    return {
        "media_file_id": str(media_file.id),
        "asset_name": asset.name,
        "language": media_file.transcript_language,
        "segments": [
            {
                "track": segment.track_index,
                "speaker": names.get(segment.speaker_id),
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "text_current": segment.text_current,
            }
            for segment in segments
        ],
    }


def build_json(transcript: dict) -> str:
    """The machine shape. `ensure_ascii=False` so names stay readable."""
    return json.dumps(transcript, ensure_ascii=False, indent=2)


def build_markdown(transcript: dict) -> str:
    """A transcript to read: a short header, then [mm:ss] Speaker: text.

    The speaker's name is repeated on every line rather than only when it
    changes. Two speakers on two tracks can overlap in time, so "the last
    name you saw" is not reliably whose line this is.
    """
    language = transcript.get("language") or "unknown"
    lines = [
        f"# {transcript['asset_name']}",
        "",
        f"- Media file: `{transcript['media_file_id']}`",
        f"- Language: {language}",
        f"- Segments: {len(transcript['segments'])}",
        "",
    ]
    if not transcript["segments"]:
        lines.append("_No transcript segments._")
        return "\n".join(lines) + "\n"

    for segment in transcript["segments"]:
        speaker = segment["speaker"] or UNKNOWN_SPEAKER
        text = " ".join((segment["text_current"] or "").split())
        lines.append(f"{_timestamp(segment['start_ms'])} **{speaker}:** {text}")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--media-file-id", required=True, type=uuid.UUID)
    parser.add_argument("--format", choices=("json", "md"), default="json")
    parser.add_argument("--out", metavar="FILE",
                        help="write here instead of stdout")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        transcript = load_transcript(db, args.media_file_id)
        text = build_json(transcript) if args.format == "json" else build_markdown(transcript)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text if text.endswith("\n") else text + "\n")
            print(f"Wrote {len(transcript['segments'])} segment(s) to {args.out}",
                  file=sys.stderr)
        else:
            print(text)
        return 0
    except ScriptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
