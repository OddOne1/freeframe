"""Write one file's transcript out, as JSON, Markdown or a list of sentences.

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

    docker-compose exec api python -m apps.api.scripts.snippet_export \\
        --media-file-id <uuid> --format sentences --min-words 3 \\
        --out /tmp/sentences.json

`--format json` is the machine shape -- media file id, asset name,
language, and every segment with its track, speaker name and times in
milliseconds. `--format md` is for reading: one line per segment, prefixed
with [mm:ss] and the speaker's name.

`--format sentences` is for cutting clips. It is built from
`transcript_words`, not from segments, so every `start_ms` is a real word
start and every `end_ms` a real word end: a clip cut from one sentence's
start to another's end imports through snippet_import.py with nothing
snapped. Each sentence carries `i`, `track`, `speaker` (of the segment it
starts in), `start_ms`, `end_ms`, `gap_ms` (silence since the previous
sentence on the same track ended; null for a track's first),
`max_inner_gap_ms` and `text`. `--min-words N` leaves out sentences shorter
than N words ("Yes.", "Right, right."); the next one's gap is still
measured from the dropped one, since that is where the silence began. See
`split_sentences` for where a sentence ends.

A soft-deleted asset exports nothing: the transcript is reached through
`TranscriptSegment.live`, the one implementation of that rule
(models/snippet.py), and the script says so rather than printing an empty
transcript.
"""
import argparse
import json
import re
import sys
import uuid

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.snippet import SnippetSpeaker, TranscriptSegment, TranscriptWord
from apps.api.services.snippet_detect import join_words

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


def _live_media_file(db, media_file_id) -> tuple:
    """(media_file, asset). Raises ScriptError for a missing or trashed asset."""
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
    return media_file, asset


def load_transcript(db, media_file_id) -> dict:
    """Everything both formats need, in one plain dict.

    Ordered by time across tracks, then by track, so two speakers who
    overlap come out in a stable order rather than whichever row the
    database returned first.
    """
    media_file, asset = _live_media_file(db, media_file_id)

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


# ── Sentences ────────────────────────────────────────────────────────────────
#
# A splitter of its own, not services/snippet_detect.build_sentences. That
# one deliberately has no abbreviation list (an extra split only costs the
# detector a boundary) and also ends on "…". Here a sentence is an edge a
# person cuts a clip on, so a false end -- a clip stopping on "Dr." -- is
# the expensive mistake, and a missed one only makes a sentence longer.

#: Closing quotes and brackets stripped before looking for the terminator,
#: so `ready?"` ends a sentence.
_CLOSERS = "\"'»”’)]}"
#: Opening quotes and brackets stripped before matching an abbreviation.
_OPENERS = "\"'„“«‚‘([{"
_TERMINATORS = ".?!"

#: Words that end in "." but do not end a sentence, lower-case. Only forms
#: that are nearly always followed by more of the same sentence: "etc.",
#: "usw.", "Inc." and "No." are left out on purpose, because in speech they
#: usually DO close it.
ABBREVIATIONS = frozenset("""
mr. mrs. ms. dr. prof. st. mt. sr. vs. approx. ca. fig. vol. dept. cf. resp.
z.b. d.h. u.a. o.ä. bzw. evtl. ggf. bspw. inkl. exkl. vgl. sog. nr. hr. fr.
str. mio. mrd. zzgl. ggü. s.o. s.u. u.u. z.t.
""".split())
#: Dotted initials and short forms: "J.", "U.S.", "e.g.", "i.e.", "z.B.".
_DOTTED_RE = re.compile(r"^(?:[^\W\d_]\.)+$", re.UNICODE)
#: ...except these, which in speech close the sentence they are in more
#: often than not ("We started at nine a.m."; "and so did I.").
_DOTTED_SENTENCE_ENDS = frozenset({"a.m.", "p.m.", "i."})
#: A number with a trailing dot: "2." in a decimal the transcriber split
#: across two words ("2." "5"). Only a non-sentence end when the next word
#: starts with a digit -- "it took 2." at the end of a sentence still ends it.
_NUMBER_DOT_RE = re.compile(r"^\d+(?:[.,]\d+)*\.$")


def _core(text: str) -> str:
    return (text or "").strip().lstrip(_OPENERS).rstrip(_CLOSERS)


def ends_sentence(word: str, next_word=None) -> bool:
    """Does `word` end a sentence, given the word after it on its track?

    A word ends one when it ends in ".", "?" or "!" (closing quotes and
    brackets aside). A "." does not count after a common abbreviation, a
    dotted initial, or a number that the next word continues as a decimal.
    "…" is not a terminator: a trailing-off thought carries on.
    """
    core = _core(word)
    if not core or core[-1] not in _TERMINATORS:
        return False
    if core[-1] != ".":
        return True
    folded = core.lower()
    if folded in ABBREVIATIONS:
        return False
    if _DOTTED_RE.match(core) and folded not in _DOTTED_SENTENCE_ENDS:
        return False
    if _NUMBER_DOT_RE.match(core) and _core(next_word or "")[:1].isdigit():
        return False
    return True


def _word_order(word: dict) -> tuple:
    """(start_ms, idx), then segment seq so a tie is still stable."""
    return (word["start_ms"], word.get("idx", 0), word.get("seq", 0))


def split_sentences(words, *, min_words: int = 1) -> list:
    """Sentences from word dicts, every track on its own.

    Each word is ``{"track", "start_ms", "end_ms", "word"}`` plus, from the
    database, ``"speaker"`` (its segment's speaker name, or None), ``"idx"``
    and ``"seq"``. A track's words are ordered by (start_ms, idx); a
    sentence closes on a word for which `ends_sentence` holds, and a last
    run without a terminator closes at the end of its track.

    `gap_ms` is the silence since the previous sentence on the same track
    ended (None for a track's first), `max_inner_gap_ms` the longest
    silence between two consecutive words inside it (0 for one word). Both
    are floored at 0: Whisper's word times can overlap by a few ms, and an
    overlap is not a negative pause. Both are measured BEFORE `min_words`
    drops anything, so dropping a "Yes." never invents a silence.

    The result is ordered by start, then track, and numbered `i` from 0
    after dropping.
    """
    by_track: dict = {}
    for word in words or []:
        by_track.setdefault(int(word["track"]), []).append(word)

    sentences = []
    for track in sorted(by_track):
        ordered = sorted(by_track[track], key=_word_order)
        previous_end = None
        current: list = []
        for pos, word in enumerate(ordered):
            current.append(word)
            following = ordered[pos + 1]["word"] if pos + 1 < len(ordered) else None
            if following is not None and not ends_sentence(word["word"], following):
                continue
            # Here: a terminator, or the last word of the track.
            sentence = _sentence(track, current, previous_end)
            previous_end = sentence["end_ms"]
            if len(current) >= min_words:
                sentences.append(sentence)
            current = []

    sentences.sort(key=lambda s: (s["start_ms"], s["track"]))
    return [{"i": i, **sentence} for i, sentence in enumerate(sentences)]


def _sentence(track: int, words: list, previous_end) -> dict:
    start_ms = int(words[0]["start_ms"])
    end_ms = int(words[-1]["end_ms"])
    return {
        "track": track,
        "speaker": words[0].get("speaker"),
        "start_ms": start_ms,
        "end_ms": end_ms,
        "gap_ms": None if previous_end is None else max(0, start_ms - previous_end),
        "max_inner_gap_ms": max(
            (max(0, int(b["start_ms"]) - int(a["end_ms"])) for a, b in zip(words, words[1:])),
            default=0,
        ),
        "text": join_words(words),
    }


def load_words(db, media_file_id) -> dict:
    """The file's header and every live word, for `split_sentences`.

    Words are read through `TranscriptSegment.live`, like everything else
    here, and carry the name of the speaker of the segment they belong to.
    """
    media_file, asset = _live_media_file(db, media_file_id)
    names = {
        speaker_id: name
        for speaker_id, name in db.query(SnippetSpeaker.id, SnippetSpeaker.name).all()
    }
    segments = {
        segment.id: segment
        for segment in TranscriptSegment.live(db)
        .filter(TranscriptSegment.media_file_id == media_file_id)
        .all()
    }
    rows = (
        db.query(TranscriptWord)
        .filter(TranscriptWord.segment_id.in_(list(segments)))
        .order_by(TranscriptWord.start_ms, TranscriptWord.idx)
        .all()
    ) if segments else []
    return {
        "media_file_id": str(media_file.id),
        "asset_name": asset.name,
        "language": media_file.transcript_language,
        "words": [
            {
                "track": segments[row.segment_id].track_index,
                "speaker": names.get(segments[row.segment_id].speaker_id),
                "seq": segments[row.segment_id].seq,
                "idx": row.idx,
                "start_ms": row.start_ms,
                "end_ms": row.end_ms,
                "word": row.word,
            }
            for row in rows
        ],
    }


def build_sentences_json(loaded: dict, *, min_words: int = 1) -> tuple:
    """(JSON text, sentence count) for `--format sentences`."""
    sentences = split_sentences(loaded["words"], min_words=min_words)
    payload = {
        "media_file_id": loaded["media_file_id"],
        "asset_name": loaded["asset_name"],
        "language": loaded["language"],
        "sentences": sentences,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2), len(sentences)


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be 1 or more, got {number}")
    return number


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--media-file-id", required=True, type=uuid.UUID)
    parser.add_argument("--format", choices=("json", "md", "sentences"), default="json")
    parser.add_argument("--out", metavar="FILE",
                        help="write here instead of stdout")
    parser.add_argument("--min-words", metavar="N", type=_positive_int, default=None,
                        help="with --format sentences: leave out sentences of fewer "
                             "than N words (default 1, keep all)")
    args = parser.parse_args(argv)
    if args.min_words is not None and args.format != "sentences":
        parser.error("--min-words only applies to --format sentences")

    db = SessionLocal()
    try:
        if args.format == "sentences":
            text, count = build_sentences_json(
                load_words(db, args.media_file_id), min_words=args.min_words or 1,
            )
            noun = "sentence(s)"
        else:
            transcript = load_transcript(db, args.media_file_id)
            text = build_json(transcript) if args.format == "json" else build_markdown(transcript)
            count, noun = len(transcript["segments"]), "segment(s)"
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text if text.endswith("\n") else text + "\n")
            print(f"Wrote {count} {noun} to {args.out}", file=sys.stderr)
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
