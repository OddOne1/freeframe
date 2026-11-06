"""Say who is on which audio track of a SocialSnippet file.

The track decides the speaker: a mapped track's transcript segments carry
that speaker. Mapping also decides WHICH tracks are transcribed: once any
track of a file is mapped, exactly the mapped tracks are transcribed and the
rest are left out. So map every track that has someone on it.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_set_track_speaker \\
        --media-file-id <uuid> --list

    docker-compose exec api python -m apps.api.scripts.snippet_set_track_speaker \\
        --media-file-id <uuid> --track 0 --name "Anna Example"

`--track` is the audio-track ordinal (ffmpeg's `a:N`), as `--list` shows it,
not the container's stream number. `--name` creates the speaker in the
file's project if no speaker of that name exists (case-insensitive), then
maps the track to them, replacing any earlier mapping of that track.

Segments already transcribed on that track are relabelled to the new
speaker at the same time (speaker only; their text is not touched). Which
tracks get transcribed changes only on the next run -- see
snippet_reprocess.py.
"""
import argparse
import sys
import uuid

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.snippet import SnippetSpeaker, SnippetTrackSpeaker
from apps.api.services import snippet_admin
from apps.api.services.snippet_admin import SnippetAdminError
from apps.api.services.snippet_transcribe import select_tracks

#: The no-traceback error every SocialSnippet script prints. The same class
#: as the service's, so a rule refused in services/snippet_admin.py reaches
#: the operator as a message, and the routes answer it as a 422.
ScriptError = SnippetAdminError


def _media_file_and_project(db, media_file_id):
    media_file = db.query(MediaFile).filter(MediaFile.id == media_file_id).first()
    if media_file is None:
        raise ScriptError(f"No media file {media_file_id}.")
    version = db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    asset = db.query(Asset).filter(Asset.id == version.asset_id).first() if version else None
    if asset is None:
        raise ScriptError(f"Media file {media_file_id} has no asset.")
    return media_file, asset.project_id


def _audio_streams(media_file):
    return snippet_admin.audio_streams(media_file)


def find_or_create_speaker(db, project_id, name: str):
    """(speaker, created). Same project, same name ignoring case = same speaker.

    The rule itself is services/snippet_admin.py's; the routes call it too.
    """
    return snippet_admin.find_or_create_speaker(db, project_id, name)


def set_track_speaker(db, media_file_id, track: int, name: str) -> dict:
    if track < 0:
        raise ScriptError("--track must be 0 or more.")
    media_file, project_id = _media_file_and_project(db, media_file_id)
    # Checked before the speaker is created, so a wrong --track leaves no
    # new speaker behind in the roster.
    known = snippet_admin.known_audio_tracks(media_file)
    if known is not None and track not in known:
        raise ScriptError(f"This file's audio tracks are {known}; there is no track {track}.")

    speaker, created = find_or_create_speaker(db, project_id, name)
    result = snippet_admin.assign_track_speaker(db, media_file, track, speaker)
    previous = result["previous_speaker_id"]
    db.commit()
    return {
        "media_file_id": str(media_file.id),
        "track": track,
        "speaker_id": str(speaker.id),
        "speaker_name": speaker.name,
        "speaker_created": created,
        "previous_speaker_id": str(previous) if previous else None,
        "segments_relabelled": result["segments_relabelled"],
    }


def list_tracks(db, media_file_id) -> dict:
    media_file, project_id = _media_file_and_project(db, media_file_id)
    streams = _audio_streams(media_file)
    rows = (
        db.query(SnippetTrackSpeaker, SnippetSpeaker)
        .join(SnippetSpeaker, SnippetSpeaker.id == SnippetTrackSpeaker.speaker_id)
        .filter(SnippetTrackSpeaker.media_file_id == media_file.id)
        .order_by(SnippetTrackSpeaker.track_index)
        .all()
    )
    mapping = {m.track_index: s.name for m, s in rows}
    selected, reason = (
        select_tracks(streams, list(mapping)) if (streams is not None or mapping) else (None, None)
    )
    return {
        "media_file_id": str(media_file.id),
        "project_id": str(project_id),
        "audio_streams": streams,
        "mapping": mapping,
        "would_transcribe": selected,
        "reason": reason,
    }


def _print_list(info: dict) -> None:
    print(f"Media file {info['media_file_id']} (project {info['project_id']})")
    streams = info["audio_streams"]
    mapping = info["mapping"]
    if streams is None:
        print("  Audio streams: not recorded in technical_metadata "
              "(the pipeline probes the file itself when it runs).")
    elif not streams:
        print("  Audio streams: none.")
    shown = set()
    for s in streams or []:
        idx = s.get("audio_index")
        shown.add(idx)
        layout = s.get("channel_layout") or (f"{s.get('channels')} ch" if s.get("channels") else "?")
        title = f" title={s.get('title')!r}" if s.get("title") else ""
        lang = f" lang={s.get('language')}" if s.get("language") else ""
        who = mapping.get(idx, "-")
        print(f"  track {idx}: stream #{s.get('stream_index')} {s.get('codec')} {layout} "
              f"{s.get('sample_rate')} Hz{lang}{title}  -> {who}")
    for idx, name in sorted(mapping.items()):
        if idx not in shown:
            print(f"  track {idx}: (not in recorded streams)  -> {name}")
    if info["would_transcribe"] is not None:
        print(f"  Next run transcribes: {info['would_transcribe']} ({info['reason']})")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--media-file-id", required=True, type=uuid.UUID)
    parser.add_argument("--list", action="store_true", help="show tracks and their speakers")
    parser.add_argument("--track", type=int, help="audio-track ordinal (a:N)")
    parser.add_argument("--name", help="speaker name; created in the project if new")
    args = parser.parse_args(argv)

    if not args.list and (args.track is None or args.name is None):
        parser.error("give --list, or both --track and --name")

    db = SessionLocal()
    try:
        if args.track is not None and args.name is not None:
            result = set_track_speaker(db, args.media_file_id, args.track, args.name)
            verb = "created and mapped" if result["speaker_created"] else "mapped"
            print(f"Track {result['track']} -> {result['speaker_name']} ({verb}, "
                  f"speaker {result['speaker_id']}); "
                  f"{result['segments_relabelled']} existing segment(s) relabelled.")
        if args.list:
            _print_list(list_tracks(db, args.media_file_id))
        return 0
    except ScriptError as exc:
        db.rollback()
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
