"""SocialSnippet clip exports (prompt #8): rules, routes, task, sweep, purge.

Reuses tests/test_snippet_api.py's world and app fixtures, so the same two
databases apply: `db` runs on SQLite (create_all, foreign keys on) and, with
TEST_DATABASE_URL pointing at a migrated Postgres, on Postgres too — where
the table comes from the real migration, not from the model.

The render task is tested twice: with ffmpeg replaced (states, progress,
failure, cleanup), and for real on a generated 3-second video when the image
has ffmpeg. S3 is always a fake in-memory bucket.
"""
import io
import os
import shutil
import subprocess
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from apps.api.tests.test_snippet_api import (  # noqa: F401  -- fixtures
    api, build_world, db, pg_engine, world,
)

HAVE_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(
    not HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed in this image; the real render test needs them"
)

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


# ── Helpers ────────────────────────────────────────────────────────────────


class FakeBucket:
    """An S3 stand-in holding keys; records deletes."""

    def __init__(self, keys=()):
        self.keys = set(keys)
        self.deleted = []
        self.uploaded = {}

    def client(self):
        bucket = self
        c = MagicMock()

        class _Pages:
            def paginate(self, Bucket=None, Prefix=None):  # noqa: N803
                return [{"Contents": [{"Key": k} for k in sorted(bucket.keys) if k.startswith(Prefix or "")]}]

        c.get_paginator.return_value = _Pages()

        def delete_objects(Bucket=None, Delete=None):  # noqa: N803
            for o in Delete["Objects"]:
                bucket.delete(o["Key"])

        def upload_file(path, Bucket, Key, ExtraArgs=None):  # noqa: N803
            bucket.keys.add(Key)
            bucket.uploaded[Key] = os.path.getsize(path)

        c.delete_objects.side_effect = delete_objects
        c.upload_file.side_effect = upload_file
        return c

    def delete(self, key):
        self.deleted.append(key)
        self.keys.discard(key)


class _NoClose:
    """The test's session, handed to a task whose `finally` closes it."""

    def __init__(self, s):
        self._s = s

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._s, name)


def _post(api, world, user, target, **body):
    body.setdefault("aspect", "9:16")
    with patch("apps.api.routers.snippet_export.send_task_safe") as send:
        r = api.as_(user).post(f"/snippets/{target}/exports", json=body)
    return r, send


def _row(db, export_id):
    from apps.api.models.snippet_export import SnippetExport

    db.expire_all()
    return db.query(SnippetExport).filter(SnippetExport.id == uuid.UUID(str(export_id))).one()


def _make_export(db, world, *, status="done", expires_at=None, s3=True):
    from apps.api.models.snippet_export import SnippetExport
    from apps.api.services import snippet_export as rules

    eid = uuid.uuid4()
    row = SnippetExport(
        id=eid, project_id=world.A.id, snippet_id=world.SC.id, media_file_id=world.alpha_mf.id,
        asset_version_id=world.alpha_mf.version_id, start_ms=2500, end_ms=5500, aspect="9:16",
        framing=rules.DEFAULT_FRAMING, captions=False,
        cache_key=uuid.uuid4().hex, status=status,
        progress=1.0 if status == "done" else 0.0,
        s3_key=rules.export_key(world.A.id, eid) if s3 else None,
        download_filename="Alpha_Anna-Example_00m02s-00m05s_9x16.mp4",
        expires_at=expires_at,
    )
    db.add(row)
    db.commit()
    return row


# ═══ Rules (no database) ═══════════════════════════════════════════════════


def test_same_inputs_give_the_same_cache_key_and_any_change_a_new_one():
    from apps.api.services import snippet_export as rules

    v = uuid.uuid4()
    centre = rules.normalise_framing(None)
    base = rules.cache_key(v, 1000, 5000, "9:16", centre, False, None)
    assert base == rules.cache_key(v, 1000, 5000, "9:16", rules.normalise_framing({"x": 0.5}), False, None)
    assert base == rules.cache_key(str(v), 1000, 5000, "9:16", dict(reversed(list(centre.items()))), False, None)
    assert len(base) == 64
    for other in (
        rules.cache_key(uuid.uuid4(), 1000, 5000, "9:16", centre, False, None),
        rules.cache_key(v, 1001, 5000, "9:16", centre, False, None),
        rules.cache_key(v, 1000, 5001, "9:16", centre, False, None),
        rules.cache_key(v, 1000, 5000, "16:9", centre, False, None),
        rules.cache_key(v, 1000, 5000, "9:16", rules.normalise_framing({"x": 0.3}), False, None),
        rules.cache_key(v, 1000, 5000, "9:16", centre, True, None),
        rules.cache_key(v, 1000, 5000, "9:16", centre, False, {"x": 0.5, "y": 0.8, "size": 1}),
    ):
        assert other != base


@pytest.mark.parametrize("aspect,message", [
    ("1:1", "aspect not available yet"),
    ("4:5", "aspect not available yet"),
    ("3:4", "aspect not available yet"),
    ("4:3", "aspect not available yet"),
    ("2:1", "aspect must be one of"),
    ("9x16", "aspect must be one of"),
])
def test_aspects_beyond_the_two_implemented_are_refused(aspect, message):
    from apps.api.services import snippet_export as rules

    with pytest.raises(rules.ExportError, match=message):
        rules.check_aspect(aspect)
    for ok in ("9:16", "16:9"):
        rules.check_aspect(ok)


@pytest.mark.parametrize("start,end,duration,fragment", [
    (-1, 5000, None, "0 or more"),
    (5000, 5000, None, "before end_ms"),
    (6000, 5000, None, "before end_ms"),
    (0, 999, None, "at least 1 second"),
    (0, 10 * 60 * 1000 + 1, None, "at most 10 minutes"),
    (0, 61_000, 60_000, "past the end"),
])
def test_bad_ranges(start, end, duration, fragment):
    from apps.api.services import snippet_export as rules

    with pytest.raises(rules.ExportError, match=fragment):
        rules.check_range(start, end, duration)


def test_exactly_ten_minutes_and_the_exact_file_end_are_allowed():
    from apps.api.services import snippet_export as rules

    rules.check_range(0, 10 * 60 * 1000, None)
    rules.check_range(50_000, 60_000, 60_000)


@pytest.mark.parametrize("framing,fragment", [
    ({"x": 1.2}, "between 0 and 1"),
    ({"y": -0.1}, "between 0 and 1"),
    ({"zoom": 0.5}, "zoom"),
    ({"zoom": 11}, "zoom"),
])
def test_bad_framing(framing, fragment):
    from apps.api.services import snippet_export as rules

    with pytest.raises(rules.ExportError, match=fragment):
        rules.normalise_framing(framing)


def test_the_ffmpeg_command_has_the_fixed_settings_and_a_fast_seek():
    from apps.api.services import snippet_export as rules

    cmd = rules.ffmpeg_command("https://s3/in.mov", 12_400, 31_900, "9:16", rules.normalise_framing(None), "/tmp/o.mp4")
    assert cmd.index("-ss") < cmd.index("-i"), "-ss before -i is the fast seek"
    assert cmd[cmd.index("-ss") + 1] == "12.400"
    assert cmd[cmd.index("-t") + 1] == "19.500"
    joined = " ".join(cmd)
    for part in ("-c:v libx264", "-preset veryfast", "-crf 20", "-c:a aac", "-b:a 192k",
                 "-movflags +faststart", "-progress pipe:1"):
        assert part in joined
    vf = cmd[cmd.index("-vf") + 1]
    assert "scale=1080:1920" in vf and "crop=" in vf
    vf169 = rules.video_filter("16:9", rules.normalise_framing({"zoom": 1.5, "x": 0.25}))
    assert "pad=1920:1080" in vf169 and "/1.5/" in vf169 and "0.25*iw" in vf169
    with pytest.raises(rules.ExportError):
        rules.video_filter("1:1", rules.normalise_framing(None))


def test_progress_lines_become_a_fraction_below_one():
    from apps.api.services import snippet_export as rules

    assert rules.parse_progress("out_time_us=5000000", 10_000) == 0.5
    assert rules.parse_progress("out_time_ms=5000000", 10_000) == 0.5  # older name, same unit
    assert rules.parse_progress("out_time_us=99000000", 10_000) == 0.99
    assert rules.parse_progress("progress=continue", 10_000) is None
    assert rules.parse_progress("frame=12", 10_000) is None


def test_the_download_is_named_asset_speaker_times_aspect():
    from apps.api.services import snippet_export as rules

    assert rules.download_filename("Interview A-cam.mov", "Anna Berger", 12_400, 31_900, "9:16") == \
        "Interview-A-cam_Anna-Berger_00m12s-00m31s_9x16.mp4"
    assert rules.download_filename(None, None, 3_723_000, 3_725_000, "16:9") == \
        "clip_unknown-speaker_1h02m03s-1h02m05s_16x9.mp4"
    assert "/" not in rules.download_filename("a/b\\c.mov", "x/y", 0, 1000, "9:16")


def test_a_titled_download_is_title_underscore_ratio():
    from apps.api.services import snippet_export as rules

    assert rules.titled_download_filename("Why the jump nearly failed", "9:16") == \
        "Why the jump nearly failed_9x16.mp4"
    assert rules.titled_download_filename("Why the jump nearly failed", "16:9") == \
        "Why the jump nearly failed_16x9.mp4"


@pytest.mark.parametrize("title, stem", [
    # Separators and the rest of what Windows/macOS refuse become spaces,
    # and the spaces they leave collapse.
    ("AC/DC: live", "AC DC live"),
    ("back\\slash", "back slash"),
    ('He said "jump" <now>?*|', "He said jump now"),
    ("Is it 50:50?", "Is it 50 50"),
    # Control characters (C0, DEL, C1) and runs of whitespace.
    ("tab\there\nnew\x00null\x7fdel\x85nel", "tab here new null del nel"),
    ("  lots    of   space  ", "lots of space"),
    # Umlauts and other letters stay, in NFC.
    ("Über die Brücke, ß und Éclair", "Über die Brücke, ß und Éclair"),
    (unicodedata.normalize("NFD", "Brücke"), "Brücke"),
    # Emoji stay, a joined family included.
    ("Jump 🔥 day 👨‍👩‍👧", "Jump 🔥 day 👨‍👩‍👧"),
    # No hidden file, and no bidi trick ("clip\u202egnp.exe" shows as "clipexe.png").
    ("..hidden", "hidden"),
    ("clip\u202egnp.exe", "clipgnp.exe"),
])
def test_the_title_is_made_safe_for_a_file_name(title, stem):
    from apps.api.services import snippet_export as rules

    assert rules.title_stem(title) == stem


def test_a_long_title_is_cut_to_80_characters():
    from apps.api.services import snippet_export as rules

    assert rules.TITLE_STEM_MAX == 80
    assert rules.title_stem("x" * 300) == "x" * 80
    assert rules.title_stem("ü" * 300) == "ü" * 80
    # A cut that lands after a space does not leave it dangling.
    assert rules.title_stem("a" * 79 + " " + "b" * 50) == "a" * 79
    name = rules.titled_download_filename("Lange " * 40, "9:16")
    assert name == ("Lange " * 13) + "La" + "_9x16.mp4"


@pytest.mark.parametrize("title", [None, "", "   ", "///", '"?*', "...", "\u202e\x00"])
def test_an_empty_title_gives_no_titled_name(title):
    from apps.api.services import snippet_export as rules

    assert rules.title_stem(title) is None
    assert rules.titled_download_filename(title, "9:16") is None


def test_the_input_is_the_proxy_when_there_is_one():
    from apps.api.services import snippet_export as rules

    heavy = MagicMock(proxy_1080p_key="proxies/p/a/v/1080p.mp4", s3_key_raw="raw/p/a/v/original.mxf")
    light = MagicMock(proxy_1080p_key=None, s3_key_raw="raw/p/a/v/original.mov")
    assert rules.choose_input(heavy).s3_key == "proxies/p/a/v/1080p.mp4"
    assert rules.choose_input(light).s3_key == "raw/p/a/v/original.mov"


def test_the_exports_live_under_their_own_prefix():
    from apps.api.services import snippet_export as rules

    p, e = uuid.uuid4(), uuid.uuid4()
    assert rules.export_key(p, e) == f"snippet-exports/{p}/{e}/clip.mp4"


# ═══ Schema ════════════════════════════════════════════════════════════════


def test_the_migration_and_the_model_list_the_same_statuses_and_the_id_fits():
    import ast

    from apps.api.models.snippet_export import EXPORT_STATUSES

    src = (VERSIONS / "add_snippet_exports.py").read_text()
    tree = ast.parse(src)
    values = {
        t.id: ast.literal_eval(node.value)
        for node in tree.body if isinstance(node, ast.Assign)
        for t in node.targets if isinstance(t, ast.Name) and t.id in ("_STATUSES", "revision", "down_revision")
    }
    assert values["_STATUSES"] == EXPORT_STATUSES
    assert len(values["revision"]) <= 32
    assert values["down_revision"] == "add_socialsnippet_data"
    # SET NULL, never CASCADE, towards the asset side.
    for table in ("snippets", "media_files", "asset_versions"):
        assert f'"{table}.id", ondelete="SET NULL"' in src


# ═══ Routes (SQLite, and Postgres when available) ══════════════════════════


def test_an_editor_queues_an_export_and_the_same_request_reuses_it(db, world, api):
    r, send = _post(api, world, world.editor, world.SC.id)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "queued"
    send.assert_called_once()
    assert send.call_args.args[1] == body["export_id"]

    row = _row(db, body["export_id"])
    assert (row.start_ms, row.end_ms) == (2500, 5500), "a snippet defaults to its saved in/out"
    assert row.download_filename == "Alpha_Anna-Example_00m02s-00m05s_9x16.mp4"
    assert row.asset_version_id == world.alpha_mf.version_id

    again, send2 = _post(api, world, world.owner, world.SC.id, start_ms=2500, end_ms=5500,
                         framing={"x": 0.5, "y": 0.5, "zoom": 1})
    assert again.status_code == 200
    assert again.json() == {"export_id": body["export_id"], "status": "queued"}
    send2.assert_not_called()


def test_a_finished_export_is_returned_instead_of_rendering_again(db, world, api):
    r, _ = _post(api, world, world.editor, world.SC.id)
    row = _row(db, r.json()["export_id"])
    row.status, row.progress, row.s3_key = "done", 1.0, "snippet-exports/x/y/clip.mp4"
    db.commit()

    again, send = _post(api, world, world.editor, world.SC.id)
    assert again.status_code == 200
    assert again.json()["status"] == "done"
    send.assert_not_called()


@pytest.mark.parametrize("state", ["failed", "expired", "stale"])
def test_a_failed_expired_or_lost_export_is_queued_again_under_the_same_id(db, world, api, state):
    r, _ = _post(api, world, world.editor, world.SC.id)
    eid = r.json()["export_id"]
    row = _row(db, eid)
    if state == "stale":
        row.updated_at = datetime.now(timezone.utc) - timedelta(hours=2)
    else:
        row.status, row.error = state, "boom"
    db.commit()

    again, send = _post(api, world, world.editor, world.SC.id)
    assert again.status_code == 202
    assert again.json() == {"export_id": eid, "status": "queued"}
    send.assert_called_once()
    row = _row(db, eid)
    assert row.status == "queued" and row.error is None


def test_different_framing_or_aspect_is_a_different_export(db, world, api):
    a, _ = _post(api, world, world.editor, world.SC.id)
    b, _ = _post(api, world, world.editor, world.SC.id, framing={"x": 0.2})
    c, _ = _post(api, world, world.editor, world.SC.id, aspect="16:9")
    assert len({a.json()["export_id"], b.json()["export_id"], c.json()["export_id"]}) == 3


def test_a_moment_id_exports_with_the_speaker_under_its_start(db, world, api):
    r, send = _post(api, world, world.editor, f"moment:{world.alpha_mf.id}:6000", end_ms=9000)
    assert r.status_code == 202, r.text
    row = _row(db, r.json()["export_id"])
    assert row.snippet_id is None
    assert (row.start_ms, row.end_ms) == (6000, 9000)
    assert row.download_filename.startswith("Alpha_Anna-Example_00m06s-00m09s")

    missing_end, _ = _post(api, world, world.editor, f"moment:{world.alpha_mf.id}:6000")
    assert missing_end.status_code == 422
    assert "end_ms is required" in missing_end.json()["detail"]


@pytest.mark.parametrize("body,detail", [
    ({"captions": True}, "captions not available yet"),
    ({"aspect": "1:1"}, "aspect not available yet"),
    ({"aspect": "4:3"}, "aspect not available yet"),
    ({"aspect": "2:1"}, "aspect must be one of"),
    ({"start_ms": 5000, "end_ms": 4000}, "before end_ms"),
    ({"start_ms": 0, "end_ms": 121_000}, "past the end"),
    ({"framing": {"zoom": 0.5}}, "zoom"),
])
def test_validation_errors_are_422_with_the_reason(db, world, api, body, detail):
    r, send = _post(api, world, world.editor, world.SC.id, **body)
    assert r.status_code == 422
    assert detail in r.json()["detail"]
    send.assert_not_called()


def test_audio_only_is_refused(db, world, api):
    r, send = _post(api, world, world.editor, f"moment:{world.beta_mf.id}:0", end_ms=5000)
    assert r.status_code == 422
    assert r.json()["detail"] == "audio-only export not supported yet"
    send.assert_not_called()


def test_longer_than_ten_minutes_is_refused(db, world, api):
    from apps.api.models.asset import MediaFile

    mf = db.query(MediaFile).filter(MediaFile.id == world.alpha_mf.id).one()
    mf.duration_seconds = 3600.0
    db.commit()
    r, _ = _post(api, world, world.editor, f"moment:{world.alpha_mf.id}:0", end_ms=600_001)
    assert r.status_code == 422
    assert "at most 10 minutes" in r.json()["detail"]


def test_export_permissions(db, world, api):
    for user, code in ((world.viewer, 403), (world.reviewer, 403), (world.outsider, 404)):
        r, send = _post(api, world, user, world.SC.id)
        assert r.status_code == code, (user.first_name, r.text)
        send.assert_not_called()
    off, _ = _post(api, world, world.owner, world.C1.id)
    assert off.status_code == 409
    gone, _ = _post(api, world, world.owner, world.G1.id)
    assert gone.status_code == 404, "a soft-deleted asset's clip is invisible"
    for bad in ("not-a-uuid", str(uuid.uuid4()), "moment:nope:1", f"moment:{world.alpha_mf.id}:x"):
        r, _ = _post(api, world, world.owner, bad)
        assert r.status_code == 404, bad
    unauth = api.as_(None).post(f"/snippets/{world.SC.id}/exports", json={"aspect": "9:16"})
    assert unauth.status_code == 401


def test_get_export_status_and_download(db, world, api):
    r, _ = _post(api, world, world.editor, world.SC.id)
    eid = r.json()["export_id"]

    queued = api.as_(world.viewer).get(f"/exports/{eid}")
    assert queued.status_code == 200
    assert queued.json() == {"status": "queued", "progress": 0.0, "download_url": None, "error": None}

    row = _row(db, eid)
    row.status, row.progress, row.s3_key = "done", 1.0, f"snippet-exports/{world.A.id}/{eid}/clip.mp4"
    db.commit()
    done = api.as_(world.viewer).get(f"/exports/{eid}").json()
    assert done["status"] == "done" and done["progress"] == 1.0
    assert done["download_url"].startswith("/stream/hls/clip.mp4?token=")
    assert "download=River%20talk_9x16.mp4" in done["download_url"], "named from the clip's title"

    row.status, row.progress, row.s3_key, row.error = "failed", 0.0, None, "ffmpeg: Invalid data"
    db.commit()
    failed = api.as_(world.viewer).get(f"/exports/{eid}").json()
    assert failed == {"status": "failed", "progress": 0.0, "download_url": None, "error": "ffmpeg: Invalid data"}

    assert api.as_(world.outsider).get(f"/exports/{eid}").status_code == 404
    assert api.as_(world.viewer).get(f"/exports/{uuid.uuid4()}").status_code == 404


# ── The download's name: the clip's title when the download starts ────────


def _finish(db, world, eid):
    row = _row(db, eid)
    row.status, row.progress, row.s3_key = "done", 1.0, f"snippet-exports/{world.A.id}/{eid}/clip.mp4"
    db.commit()


def _download_url(api, user, eid):
    url = api.as_(user).get(f"/exports/{eid}").json()["download_url"]
    assert url
    return url


def _download_name(api, user, eid):
    from urllib.parse import parse_qs, urlparse

    return parse_qs(urlparse(_download_url(api, user, eid)).query)["download"][0]


def _fetch(api, user, url):
    """Follow a download_url through the real /stream/hls proxy; S3 faked."""
    s3 = MagicMock()
    s3.get_object.return_value = {"Body": io.BytesIO(b"mp4"), "ContentLength": 3}
    with patch("apps.api.routers.hls_proxy.get_s3_client", return_value=s3):
        return api.as_(user).get(url)


def _set_title(db, snippet_id, title):
    from apps.api.models.snippet import Snippet

    db.query(Snippet).filter(Snippet.id == snippet_id).update({"title": title}, synchronize_session=False)
    db.commit()


def test_the_download_is_named_from_the_title_at_download_time(db, world, api):
    r, _ = _post(api, world, world.editor, world.SC.id)
    eid = r.json()["export_id"]
    _finish(db, world, eid)
    assert _download_name(api, world.viewer, eid) == "River talk_9x16.mp4"

    # Renamed after the render (and through the real PATCH): the very next
    # download carries the new title. The row keeps the name it was created
    # with, as the fallback.
    renamed = api.as_(world.editor).patch(f"/snippets/{world.SC.id}", json={"title": "Why the jump nearly failed"})
    assert renamed.status_code == 200, renamed.text
    url = _download_url(api, world.viewer, eid)
    assert _download_name(api, world.viewer, eid) == "Why the jump nearly failed_9x16.mp4"
    assert _row(db, eid).download_filename == "Alpha_Anna-Example_00m02s-00m05s_9x16.mp4"

    got = _fetch(api, world.viewer, url)
    assert got.status_code == 200, got.text
    assert got.content == b"mp4"
    assert got.headers["content-disposition"] == 'attachment; filename="Why the jump nearly failed_9x16.mp4"'

    # Asking for the same export again after a rename is a cache hit, and
    # still downloads under the title as it is now.
    _set_title(db, world.SC.id, "Second name")
    again, send = _post(api, world, world.editor, world.SC.id)
    assert again.status_code == 200 and again.json()["export_id"] == eid
    send.assert_not_called()
    assert _download_name(api, world.viewer, eid) == "Second name_9x16.mp4"


def test_a_title_with_umlauts_and_emoji_is_sent_as_rfc_5987(db, world, api):
    from urllib.parse import unquote

    r, _ = _post(api, world, world.editor, world.SC.id)
    eid = r.json()["export_id"]
    _finish(db, world, eid)
    _set_title(db, world.SC.id, 'Über "die" Brücke: 🔥')

    assert _download_name(api, world.viewer, eid) == "Über die Brücke 🔥_9x16.mp4"
    got = _fetch(api, world.viewer, _download_url(api, world.viewer, eid))
    assert got.status_code == 200, got.text
    cd = got.headers["content-disposition"]
    plain, star = cd.split("; filename*=")
    assert plain == 'attachment; filename="Uber die Brucke _9x16.mp4"'
    assert star.startswith("UTF-8''%C3%9Cber%20die%20Br%C3%BCcke%20%F0%9F%94%A5")
    assert unquote(star[len("UTF-8''"):], encoding="utf-8") == "Über die Brücke 🔥_9x16.mp4"


@pytest.mark.parametrize("title", [None, "", "  /  "])
def test_without_a_usable_title_the_download_keeps_the_old_pattern(db, world, api, title):
    row = _make_export(db, world)  # snippet SC, stored name in the old pattern
    _set_title(db, world.SC.id, title)
    assert _download_name(api, world.viewer, row.id) == "Alpha_Anna-Example_00m02s-00m05s_9x16.mp4"
    got = _fetch(api, world.viewer, _download_url(api, world.viewer, row.id))
    assert got.headers["content-disposition"] == 'attachment; filename="Alpha_Anna-Example_00m02s-00m05s_9x16.mp4"'


def test_a_moment_downloads_under_the_old_pattern(db, world, api):
    r, _ = _post(api, world, world.editor, f"moment:{world.alpha_mf.id}:6000", end_ms=9000)
    eid = r.json()["export_id"]
    _finish(db, world, eid)
    assert _download_name(api, world.viewer, eid) == "Alpha_Anna-Example_00m06s-00m09s_9x16.mp4"


def test_a_shared_render_is_named_for_whoever_asked_last(db, world, api):
    """The cache key has no clip in it: a moment over a clip's exact range
    gets the clip's render. Each POST points the row at whoever asked, so a
    moment downloads under the old pattern and the clip under its title, and
    the lost-worker clock (updated_at) is not reset by it."""
    r, _ = _post(api, world, world.editor, world.SC.id)
    eid = r.json()["export_id"]
    _finish(db, world, eid)
    before = _row(db, eid).updated_at

    moment, _ = _post(api, world, world.editor, f"moment:{world.alpha_mf.id}:2500", end_ms=5500)
    assert moment.status_code == 200 and moment.json()["export_id"] == eid
    row = _row(db, eid)
    assert row.snippet_id is None
    assert row.updated_at == before
    assert _download_name(api, world.viewer, eid) == "Alpha_Anna-Example_00m02s-00m05s_9x16.mp4"

    clip, _ = _post(api, world, world.editor, world.SC.id)
    assert clip.json()["export_id"] == eid
    assert _row(db, eid).snippet_id == world.SC.id
    assert _download_name(api, world.viewer, eid) == "River talk_9x16.mp4"


def test_get_export_answers_409_once_the_project_turns_it_off(db, world, api):
    from apps.api.models.snippet import SnippetProjectSettings

    r, _ = _post(api, world, world.editor, world.SC.id)
    db.query(SnippetProjectSettings).filter(SnippetProjectSettings.project_id == world.A.id).update({"enabled": False})
    db.commit()
    assert api.as_(world.viewer).get(f"/exports/{r.json()['export_id']}").status_code == 409


# ═══ Purge leaves exports ══════════════════════════════════════════════════


def test_purging_the_asset_keeps_the_export_row_and_its_object(db, world):
    from apps.api.models.asset import Asset
    from apps.api.services import purge_service

    row = _make_export(db, world)
    other = f"raw/{world.A.id}/{world.alpha.id}/v/original.mov"
    bucket = FakeBucket([row.s3_key, other])

    with patch("apps.api.services.s3_service.get_s3_client", side_effect=bucket.client), \
         patch("apps.api.services.s3_service.delete_object", side_effect=bucket.delete):
        asset = db.query(Asset).filter(Asset.id == world.alpha.id).one()
        purge_service.purge_asset(db, asset)
        db.commit()

    assert row.s3_key in bucket.keys, "purge must never touch snippet-exports/"
    assert not any(k.startswith("snippet-exports/") for k in bucket.deleted)
    survivor = _row(db, row.id)
    assert survivor.status == "done" and survivor.s3_key
    assert survivor.media_file_id is None and survivor.asset_version_id is None
    assert survivor.snippet_id is None, "the snippet went with its media file; the export stays"


# ═══ The render task ═══════════════════════════════════════════════════════


def _render(db, export_id, fake_run=None, bucket=None):
    from apps.api.tasks import snippet_export_tasks as t

    bucket = bucket or FakeBucket()
    patches = [
        patch.object(t, "SessionLocal", lambda: _NoClose(db)),
        patch.object(t, "_presigned_input_url", lambda key: f"/fake/{key}"),
        patch("apps.api.services.s3_service.get_s3_client", side_effect=bucket.client),
        patch("apps.api.services.s3_service.delete_object", side_effect=bucket.delete),
    ]
    if fake_run is not None:
        patches.append(patch.object(t, "_run_ffmpeg", fake_run))
    for p in patches:
        p.start()
    try:
        t.render_snippet_export.run(str(export_id))
    finally:
        for p in reversed(patches):
            p.stop()
    return bucket


def _queued(db, world, api, **body):
    r, _ = _post(api, world, world.editor, world.SC.id, **body)
    assert r.status_code == 202, r.text
    return r.json()["export_id"]


def test_the_task_renders_uploads_and_finishes_the_row(db, world, api):
    eid = _queued(db, world, api)
    seen = {}

    def fake_run(cmd, clip_ms, on_progress, timeout_s):
        seen["cmd"], seen["clip_ms"] = cmd, clip_ms
        on_progress(0.5)
        Path(cmd[-1]).write_bytes(b"\0" * 2048)
        return 0, ""

    bucket = _render(db, eid, fake_run)
    row = _row(db, eid)
    assert row.status == "done" and row.progress == 1.0 and row.error is None
    assert row.s3_key == f"snippet-exports/{world.A.id}/{eid}/clip.mp4"
    assert bucket.uploaded[row.s3_key] == 2048 and row.size_bytes == 2048
    assert row.expires_at is not None, "the default retention is 30 days"
    assert seen["clip_ms"] == 3000
    assert seen["cmd"][seen["cmd"].index("-i") + 1] == f"/fake/{world.alpha_mf.s3_key_raw}"
    assert not os.path.exists(os.path.dirname(seen["cmd"][-1])), "the work dir is removed"


def test_a_project_that_keeps_exports_forever_gets_no_expiry(db, world, api):
    from apps.api.models.snippet import SnippetProjectSettings

    db.query(SnippetProjectSettings).filter(SnippetProjectSettings.project_id == world.A.id).update(
        {"export_retention_days": None})
    db.commit()
    eid = _queued(db, world, api)

    def fake_run(cmd, *a):
        Path(cmd[-1]).write_bytes(b"x")
        return 0, ""

    _render(db, eid, fake_run)
    row = _row(db, eid)
    assert row.status == "done" and row.expires_at is None


def test_an_ffmpeg_failure_marks_the_row_failed_and_leaves_nothing(db, world, api):
    eid = _queued(db, world, api)
    seen = {}

    def fake_run(cmd, *a):
        seen["dir"] = os.path.dirname(cmd[-1])
        Path(cmd[-1]).write_bytes(b"partial")
        return 1, "frame=1\nhttps://s3/in.mov: Invalid data found when processing input\n"

    bucket = _render(db, eid, fake_run)
    row = _row(db, eid)
    assert row.status == "failed"
    assert row.error == "https://s3/in.mov: Invalid data found when processing input"
    assert row.s3_key is None and not bucket.keys
    assert not os.path.exists(seen["dir"])


def test_an_upload_failure_cleans_up_and_a_new_post_retries(db, world, api):
    eid = _queued(db, world, api)
    bucket = FakeBucket()
    broken = bucket.client()
    broken.upload_file.side_effect = OSError("connection reset")

    def fake_run(cmd, *a):
        Path(cmd[-1]).write_bytes(b"x")
        return 0, ""

    from apps.api.tasks import snippet_export_tasks as t

    with patch.object(t, "SessionLocal", lambda: _NoClose(db)), \
         patch.object(t, "_presigned_input_url", lambda key: key), \
         patch.object(t, "_run_ffmpeg", fake_run), \
         patch("apps.api.services.s3_service.get_s3_client", return_value=broken):
        t.render_snippet_export.run(eid)
    row = _row(db, eid)
    assert row.status == "failed" and "connection reset" in row.error

    again, send = _post(api, world, world.editor, world.SC.id)
    assert again.json() == {"export_id": eid, "status": "queued"}
    send.assert_called_once()


def test_a_finished_or_vanished_row_is_left_alone(db, world, api):
    row = _make_export(db, world, status="done")
    ran = MagicMock()
    _render(db, row.id, ran)
    ran.assert_not_called()
    _render(db, uuid.uuid4(), ran)
    ran.assert_not_called()


def test_the_source_gone_before_the_render_fails_cleanly(db, world, api):
    eid = _queued(db, world, api)
    row = _row(db, eid)
    row.media_file_id = None
    db.commit()
    _render(db, eid, MagicMock())
    assert _row(db, eid).status == "failed"
    assert "no longer exists" in _row(db, eid).error


# ═══ The sweep ═════════════════════════════════════════════════════════════


def test_the_sweep_expires_old_exports_and_respects_forever(db, world):
    from apps.api.tasks import snippet_export_tasks as t

    now = datetime.now(timezone.utc)
    old = _make_export(db, world, expires_at=now - timedelta(hours=1))
    fresh = _make_export(db, world, expires_at=now + timedelta(days=3))
    forever = _make_export(db, world, expires_at=None)
    failed = _make_export(db, world, status="failed", expires_at=now - timedelta(days=9), s3=False)
    old_key = old.s3_key
    bucket = FakeBucket([old_key, fresh.s3_key, forever.s3_key])

    with patch.object(t, "SessionLocal", lambda: _NoClose(db)), \
         patch("apps.api.services.s3_service.delete_object", side_effect=bucket.delete):
        result = t.sweep_snippet_exports.run()

    assert result == {"expired": 1}
    assert bucket.deleted == [old_key]
    assert _row(db, old.id).status == "expired" and _row(db, old.id).s3_key is None
    assert _row(db, fresh.id).status == "done"
    assert _row(db, forever.id).status == "done", "expires_at NULL means keep forever"
    assert _row(db, failed.id).status == "failed"


def test_the_sweep_refuses_a_key_outside_its_prefix(db, world):
    from apps.api.tasks import snippet_export_tasks as t

    row = _make_export(db, world, expires_at=datetime.now(timezone.utc) - timedelta(days=1))
    row.s3_key = "raw/somebody/else.mov"
    db.commit()
    deleted = []
    with patch.object(t, "SessionLocal", lambda: _NoClose(db)), \
         patch("apps.api.services.s3_service.delete_object", side_effect=deleted.append):
        assert t.sweep_snippet_exports.run() == {"expired": 0}
    assert deleted == [] and _row(db, row.id).status == "done"


# ═══ Real ffmpeg ═══════════════════════════════════════════════════════════


def _probe(path):
    import json

    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def _test_video(path, seconds):
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=25:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(path),
    ], check=True)


@needs_ffmpeg
@pytest.mark.parametrize("aspect,size,framing", [
    ("9:16", (1080, 1920), None),
    ("9:16", (1080, 1920), {"x": 0.1, "y": 0.9, "zoom": 2}),
    ("16:9", (1920, 1080), None),
    ("16:9", (1920, 1080), {"x": 0.8, "zoom": 1.5}),
])
def test_real_ffmpeg_renders_a_three_second_video(tmp_path, aspect, size, framing):
    """The argv itself, run for real: a 3 s 1280x720 test pattern with a tone,
    cut 0.5-2.5 s, comes out H.264 + AAC at the target size and 2 s long."""
    from apps.api.services import snippet_export as rules

    src = tmp_path / "src.mp4"
    _test_video(src, 3)
    out = tmp_path / "clip.mp4"
    cmd = rules.ffmpeg_command(str(src), 500, 2500, aspect, rules.normalise_framing(framing), str(out))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    assert any(rules.parse_progress(ln, 2000) is not None for ln in proc.stdout.splitlines())

    info = _probe(str(out))
    streams = {s["codec_type"]: s for s in info["streams"]}
    assert streams["video"]["codec_name"] == "h264"
    assert (streams["video"]["width"], streams["video"]["height"]) == size
    assert streams["audio"]["codec_name"] == "aac"
    assert abs(float(info["format"]["duration"]) - 2.0) < 0.15


@needs_ffmpeg
def test_real_ffmpeg_through_the_task(db, world, api, tmp_path):
    """The whole task with only S3 faked: real ffmpeg reads a generated file
    (standing in for the presigned URL) and the row finishes."""
    src = tmp_path / "src.mp4"
    _test_video(src, 6)
    eid = _queued(db, world, api, start_ms=1000, end_ms=4000)

    from apps.api.tasks import snippet_export_tasks as t

    bucket = FakeBucket()
    with patch.object(t, "SessionLocal", lambda: _NoClose(db)), \
         patch.object(t, "_presigned_input_url", lambda key: str(src)), \
         patch("apps.api.services.s3_service.get_s3_client", side_effect=bucket.client):
        t.render_snippet_export.run(eid)
    row = _row(db, eid)
    assert row.status == "done", row.error
    assert row.size_bytes and bucket.uploaded[row.s3_key] == row.size_bytes
