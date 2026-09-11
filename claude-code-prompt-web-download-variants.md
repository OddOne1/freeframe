# Claude Code prompt — web: download-variant matrix + per-share-link download permissions

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §30 and §30b — read both first, and read `burn_lut_export`
(`apps/api/tasks/lut_tasks.py:60-86`) before writing anything new, since
the new proxy-export work generalizes that task rather than diverging
from its shape.

**The design questions are already answered — this is a build prompt,
not an investigation prompt.** Don't re-litigate the decisions below;
they were made after tracing the actual code and are recorded in
§30/§30b with citations. Do stop and report back if something in the
real code contradicts what's written here — that's a "the spec was
wrong" situation, worth flagging, not silently overriding.

## Decisions already made (§30/§30b)

- **Six variants, not four**: Raw, Raw+LUT, Proxy 720p, Proxy 720p+LUT,
  Proxy 1080p, Proxy 1080p+LUT. Proxy resolution is user-selectable —
  reuse the existing quality ladder's own rungs verbatim
  (`packages/transcoder/ffmpeg_transcoder.py:176-180`:
  `"1080p": ("1920:1080", 20)`, `"720p": ("1280:720", 22)`, both
  `libx264`/preset `fast`) rather than inventing new encode settings.
  Add `-movflags +faststart` for the proxy output (HLS segments don't
  carry this; a downloadable single file should). Pin an explicit audio
  codec — the existing ladder has no `-c:a` flag and relies on
  ffmpeg's default for HLS/mpegts, which is not the right thing to
  inherit for a portable downloadable file. Framerate needs no
  handling — neither ladder rung touches it, so ffmpeg already
  preserves the source framerate by default; don't add an `-r` flag.
- **Re-encode from `s3_key_raw`, not remux the HLS renditions.** Decided
  because the LUT variant can't remux at all (burning a LUT requires
  decode+re-encode), and a remux/re-encode split would produce two
  "Proxy" files with different quality characteristics under one label.
  Re-encoding is also robust to an asset with a failed/partial HLS
  transcode. `burn_lut_export` already re-encodes from raw — this keeps
  one pattern instead of two.
- **Generalize `burn_lut_export` rather than adding a parallel task.**
  It already does download-from-presigned-raw → ffmpeg → upload →
  schedule-delete → SSE. A proxy export is that pipeline with a
  different filter chain (scale to the chosen rung) and an optional LUT
  step, not a new pipeline.
- **Legacy mapping**: existing `allow_download: true` → all six variants
  allowed; `allow_download: false` → none. This preserves exactly what
  every existing share link does today — verify the backfill produces
  this before it touches any live row.

## Build order (matches the go-ahead given 2026-08-18)

### Step 1 — schema, migration, server-side enforcement (do this first, verify against real Postgres)

1. Replace `allow_download: bool` in `apps/api/schemas/share.py` with a
   real permission set covering all six variants (a list of variant
   keys, or six discrete booleans — pick whichever fits the existing
   `ShareLinkAppearance`-adjacent schema shape better, and say which you
   picked and why). It appears at multiple points in that file — re-grep
   for current line numbers rather than trust old citations, other work
   has landed on this file since. **Find every place that *reads*
   `allow_download`, not just where it's declared** — trace it fully.
2. Write the migration + backfill. **Before running it against
   anything real**: back up the `share_links` table (or a full DB
   snapshot, whichever this project's standing practice is — check
   `CLAUDE.md`'s deployment/migration guidance) and verify the backfill's
   dry-run output matches the legacy mapping above on a copy of real
   data before committing it.
3. Server-side enforcement: find wherever share-token-authenticated
   download/export endpoints live and gate them on the link's actual
   stored permission set. An empty permission set must behave exactly
   like today's `allow_download: false` — downloading genuinely
   unavailable, not just hidden in the UI.
4. Verify this step fully against real Postgres before moving on —
   same standard §27's fix was held to.

### Step 2 — UIs

1. Download modal: six options (Raw / Raw+LUT / Proxy 720p / Proxy
   720p+LUT / Proxy 1080p / Proxy 1080p+LUT). Only show LUT-inclusive
   options when the asset actually has a LUT available/selected,
   matching how the current download flow already gates this. Per
   §5/§6's still-valid spec: still-frame preview and a rough waveform
   estimate if LUFS normalization has landed by the time this is built —
   skip that part if it hasn't, note it in your report, don't block on
   unrelated work.
2. Share-link creation/edit UI: six independent checkboxes (or however
   the resolution choice is best presented — e.g. proxy resolution as
   its own selector with a separate LUT toggle, rather than six flat
   checkboxes, if that reads more clearly; your call on presentation,
   not on which combinations are possible) in `share-link-detail.tsx`
   and `share-create-dialog.tsx` — the same files §21 touched. Match
   that work's existing patterns (`DEFAULT_SHARE_APPEARANCE`-style single
   source of defaults, full-object-not-partial PATCH) rather than a new
   convention.

### Step 3 — the export task itself (flagged unverified)

Build the generalized proxy/LUT export task per the decisions above.
**This cannot be verified locally** — no ffmpeg, S3, or Redis available
in this environment. It ships on the strength of following
`burn_lut_export`'s proven shape, same as the original LUT feature did.
Say this plainly in your report; don't imply it's been tested when it
hasn't.

## Verification

Steps 1-2: create a share link with only "Proxy 720p" allowed, confirm
the public viewer offers exactly that one option, and confirm directly
hitting another variant's download endpoint with that link's token
(bypassing the UI) is rejected server-side. Confirm a link with all six
allowed works for all six. Confirm an existing pre-migration link
degrades per the stated legacy mapping. Step 3: no live verification
possible — say so.
