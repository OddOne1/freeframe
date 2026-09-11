# Claude Code prompt — transcribe_worker: PermissionError writing to
/home/appuser during model download

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Live production
issue, second round on transcription — the missing `requests`/
`huggingface-hub` dependency from the last round (4aa6d44) is
confirmed fixed; this is a new, different failure that only appeared
once that one was resolved.

## Confirmed error, from live logs

```
File ".../huggingface_hub/file_download.py", line 1131, in _hf_hub_download_to_cache_dir
    os.makedirs(os.path.dirname(blob_path), exist_ok=True)
PermissionError: [Errno 13] Permission denied: '/home/appuser'
```

`huggingface_hub.snapshot_download` (triggered by
`faster_whisper.WhisperModel(...)` downloading its model) defaults to
caching under the user's home directory (`~/.cache/huggingface` unless
overridden by `HF_HOME`/`HUGGINGFACE_HUB_CACHE`/`XDG_CACHE_HOME`). The
container's runtime user (`appuser`) cannot write to `/home/appuser` —
either that directory doesn't exist with correct ownership in the
running container, a volume mount is overriding its permissions, or a
cache-directory environment variable that should point somewhere
writable isn't actually set in this image.

## Investigate, don't guess which

- Check the `transcribe_worker` Dockerfile/image: does it create
  `/home/appuser` with `appuser` ownership (`chown`), or does the user
  get created without a properly initialized, writable home directory?
- Check whether `HF_HOME` or `HUGGINGFACE_HUB_CACHE` is set anywhere in
  this image's build (builder stage vs. runner stage — this project
  has had multi-stage Docker builds silently drop env vars that were
  only declared in the builder stage before, confirmed in project
  history, so check whether that's happening again here) and whether
  it points to a directory that actually exists and is writable at
  runtime.
- Check whether a volume mount for this container overrides
  `/home/appuser` with something that doesn't have the right
  permissions, independent of what the image itself sets up.
- Confirm with `sudo docker compose -p freeframe exec transcribe_worker whoami` and `id`
  what user is actually running, and `ls -la /home/` inside the
  container to see the actual ownership/permissions state, before
  deciding on a fix.

## Fix

Once the real cause is found: either fix the ownership/creation of the
home directory in the image, or explicitly set a cache directory env
var to a location that's guaranteed writable (and make sure it's
declared in the final runner stage, not just a builder stage). Prefer
whichever fix addresses the actual root cause found above rather than
just pointing the cache somewhere convenient without understanding why
the default location was broken.

Rebuild `transcribe_worker` with `--no-cache` and verify inside the
running container that the model can actually download successfully,
not just that the build succeeded.

## Verification

Real environment: trigger a transcription (either a fresh upload, or
re-dispatch the two previously-failed assets:
`transcribe_asset.delay(asset_id, version_id)` for
`07a62cae-81cd-491d-92a0-91a9ad000433` / `c73f3190-930d-4a12-9da0-d73626ee8a2e`
if that asset hasn't since been deleted — check first, it may have
been — and `9d6395a7-ecd1-4b89-87fd-92b0ef3d6c27` /
`97300740-3ca7-455d-8d50-017199904923`, which is confirmed still
live). Watch `transcribe_worker` logs for an actual success line, not
just absence of the permission error, and confirm real transcript
content shows up in the asset's Transcript tab. Push and report back.
