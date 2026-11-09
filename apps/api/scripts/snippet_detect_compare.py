"""Show what clip detection v2 changed for one file: old and new, side by side.

Reads the file's stored transcript and runs BOTH detectors on it -- the
frozen "tfidf-v1" (services/snippet_detect_v1.py) and the current
"keyword-v2" (services/snippet_detect.py) -- then prints their clips next
to each other, v2's score and reason codes, and why v2 left the other
windows out. Nothing is written: no `snippets` row, no job row. No model
and no network either.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_detect_compare \\
        --asset-id <uuid>

The file is the asset's latest live version, as scripts/snippet_detect.py
picks it. Exit status: 0 printed, 2 nothing to compare (no such live asset,
no media file, no transcript).

Reading the reason codes: "+x" raised v2's score, "-x" lowered it, "!x"
rejected the window outright; services/snippet_detect.py documents each.
"""
import argparse
import sys
import uuid
from collections import Counter

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset
from apps.api.services import snippet_detect as v2
from apps.api.services import snippet_detect_v1 as v1

# The same no-traceback error type the other snippet scripts use.
from apps.api.scripts.snippet_set_track_speaker import ScriptError

COLUMN = 52


def _clock(ms) -> str:
    seconds = int(ms) / 1000
    return f"{int(seconds // 60):02d}:{seconds % 60:04.1f}"


def _span(row) -> str:
    return f"{_clock(row['start_ms'])}-{_clock(row['end_ms'])}"


def _fit(text: str, width: int) -> str:
    text = text or ""
    return text if len(text) <= width else text[:width - 1] + "…"


def compare(media_file: dict) -> dict:
    """Both detectors over one plain media-file dict. Pure; writes nothing."""
    words_by_track = {int(k): (v.get("words") or []) for k, v in media_file["tracks"].items()}
    windows = v2.evaluate_windows(words_by_track)
    return {
        "v1": sorted(v1.detect_snippets(media_file), key=lambda r: (r["start_ms"], r["track_index"])),
        "v2": v2.detect_snippets(media_file),
        "windows": len(windows),
        "rejected": Counter(
            reason[1:] for w in windows for reason in w["reasons"] if reason.startswith("!")
        ),
        "cap": v2.max_clips_for(
            media_file.get("duration_ms")
            or max((w["end_ms"] for ws in words_by_track.values() for w in ws), default=0)
        ),
    }


def render(title: str, media_file: dict, result: dict) -> str:
    """The report, as text."""
    tracks = media_file["tracks"]
    duration = media_file.get("duration_ms")
    old, new = result["v1"], result["v2"]
    lines = [
        title,
        f"media file {media_file['media_file_id']}  "
        + (f"{duration / 60000:.1f} min, " if duration else "")
        + f"{len(tracks)} track(s), "
        + f"{sum(len(t.get('words') or []) for t in tracks.values())} word(s)",
        "",
        f"    {_fit(f'OLD {v1.GENERATOR}: {len(old)} clip(s)', COLUMN):<{COLUMN}} | "
        f"NEW {v2.GENERATOR}: {len(new)} clip(s), cap {result['cap']}",
    ]
    for index in range(max(len(old), len(new))):
        left = right = ""
        if index < len(old):
            left = f"{_span(old[index])}  {old[index]['title']}"
        if index < len(new):
            right = f"{_span(new[index])}  {new[index]['quality_score']:.3f}  {new[index]['title']}"
        lines.append(f"{index + 1:>3} {_fit(left, COLUMN):<{COLUMN}} | {right}")

    lines += ["", f"v2 looked at {result['windows']} window(s); left out by rule:"]
    if result["rejected"]:
        for code, count in sorted(result["rejected"].items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f"    {count:>5}  {code}")
    else:
        lines.append("    none")

    lines += ["", "NEW clips in detail:"]
    for row in new:
        lines.append(f"  {_span(row)}  track {row['track_index']}  score "
                     f"{row['quality_score']:.3f}  {row['title']}")
        lines.append(f"      topics: {', '.join(row['topics']) or '-'}")
        lines.append(f"      why:    {' '.join(row['reasons'])}")
        lines.append(f"      \"{_fit(row['quote'], 110)}\"")
    lines += ["", "OLD clips in detail:"]
    for row in old:
        lines.append(f"  {_span(row)}  track {row['track_index']}  {row['title']}")
        lines.append(f"      topics: {', '.join(row['topics']) or '-'}")
        lines.append(f"      \"{_fit(row['quote'], 110)}\"")
    lines += ["", "Nothing written."]
    return "\n".join(lines)


def load(db, asset_id) -> tuple:
    """(title line, media-file dict) for an asset's latest live version.

    Raises ScriptError when there is nothing to compare.
    """
    from apps.api.models.asset import MediaFile
    from apps.api.scripts.snippet_detect import _latest_live_version
    from apps.api.tasks.transcribe_tasks import snippet_detect_input

    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if asset is None:
        raise ScriptError(f"no live asset {asset_id}")
    version = _latest_live_version(db, asset.id)
    media_file = (
        db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if version is not None else None
    )
    if media_file is None:
        raise ScriptError(f"asset {asset_id} ({asset.name}) has no media file")
    data = snippet_detect_input(db, media_file.id)
    if not data["tracks"]:
        raise ScriptError(f"asset {asset_id} ({asset.name}) has no transcript yet")
    return f"asset {asset.id}  {asset.name}", data


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--asset-id", type=uuid.UUID, required=True)
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        title, media_file = load(db, args.asset_id)
        print(render(title, media_file, compare(media_file)))
        return 0
    except ScriptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        # Only ever read; roll back anyway so nothing can be left behind.
        db.rollback()
        db.close()


if __name__ == "__main__":
    sys.exit(main())
