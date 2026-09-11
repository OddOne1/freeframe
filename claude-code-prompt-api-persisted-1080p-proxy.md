# Claude Code prompt — Persisted 1080p proxy for heavy sources, chained 720p downloads

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §57 — read it first. Backend-heavy: new model field +
migration, transcode task change, download export logic change.

## Current state (confirmed, don't re-investigate)

- Playback: `_process_video` (`apps/api/tasks/transcode_tasks.py:110-146`)
  builds an unconditional 3-rung HLS ladder (1080p/720p/360p),
  stored as `MediaFile.s3_key_processed`. **Not touched by this
  prompt** — playback stays exactly as it is.
- Downloads: EVERY variant, including plain `proxy_720p`/`proxy_1080p`
  (no LUT), is a fresh ffmpeg re-encode from the original raw file on
  every request, via `burn_lut_export`
  (`apps/api/tasks/lut_tasks.py`) → `_build_export_command`
  (`:73-126`, docstring at `:76-79` states this is deliberate — "never
  a remux of the HLS renditions"). Exports are disposable, 1-hour TTL
  (`EXPORT_TTL_SECONDS`).
- `MediaFile` (`apps/api/models/asset.py:100-144`) has `s3_key_raw`
  and `s3_key_processed` only — no field for a standalone persisted
  proxy file.
- ffprobe metadata (bitrate, resolution) is already computed once per
  upload in the transcode pipeline (`packages/transcoder/base.py`,
  `parse_ffprobe_metadata`) — reuse it, don't re-run ffprobe.

## Build

1. **Migration**: add `proxy_1080p_key` (nullable string) to
   `MediaFile`. Follow this codebase's existing S3 key-naming
   convention (check how `s3_key_processed` paths are built before
   inventing a new pattern) — something like
   `proxies/{project_id}/{asset_id}/{version_id}/1080p.mp4`.
2. **Condition, checked once at upload processing time**, reusing the
   ffprobe metadata `_process_video` already has: build the persisted
   proxy when source bitrate > 100 Mbit/s OR source resolution is
   4K+ (≥3840 on either dimension, to catch portrait/anamorphic
   sources too). Wire this into `process_asset`
   (`transcode_tasks.py`), alongside the existing HLS ladder work —
   not a new manual trigger, not a separate endpoint.
3. **When the condition is met**: transcode a standalone 1080p MP4
   (a plain file, not HLS-segmented — this is for downloads/NLE
   ingest) from the original, upload it, store the key on
   `proxy_1080p_key`. When not met, leave it null — every download
   for that asset behaves exactly as it does today, zero behavior
   change for lightweight sources.
4. **`_build_export_command`'s input selection**
   (`lut_tasks.py:73-126`):
   - `proxy_720p`, `proxy_720p_lut`, `proxy_1080p_lut`: when
     `proxy_1080p_key` is set, use it as ffmpeg's input instead of
     the raw source (downscale and/or burn LUT from the smaller
     file). When null, unchanged — input is raw, exactly as today.
   - Plain `proxy_1080p` (no LUT): when `proxy_1080p_key` is set,
     **skip the export pipeline entirely** and serve the persisted
     file directly — no disposable re-encode of a file that already
     exists permanently and unmodified. When null, unchanged.
   - `raw` and `raw_lut`: completely untouched, always from the
     original.
5. Storage cleanup: since this is a new permanent file per qualifying
   asset (not TTL'd), make sure whatever deletes an asset's other S3
   objects on asset/project deletion also deletes `proxy_1080p_key`
   when set — check the existing asset-deletion cleanup path and add
   this alongside it rather than leaving an orphaned S3 object.

## Verification

Upload a 4K/low-bitrate source and a 1080p/>100Mbit source — confirm
both get `proxy_1080p_key` populated (one via resolution, one via
bitrate), and a normal 1080p/moderate-bitrate source gets none.
Request `proxy_720p` on a qualifying asset — confirm (via logs or a
test assertion) the ffmpeg input is the persisted proxy, not the
original, and that it's measurably faster than a same-length
non-qualifying asset's 720p export. Request plain `proxy_1080p` twice
on a qualifying asset — confirm the second request doesn't invoke
ffmpeg at all. Request `proxy_720p_lut` on a qualifying asset —
confirm the resulting grade is correct by actually inspecting a
decoded frame, not just checking the job succeeded (this codebase's
own LUT work treats "looks plausible but is wrong" as the failure
mode that matters). Delete a qualifying asset — confirm its
`proxy_1080p_key` object is actually removed from S3, not orphaned.
