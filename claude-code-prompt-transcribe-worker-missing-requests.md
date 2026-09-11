# Claude Code prompt — transcribe_worker missing `requests`, all
transcription fails

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Live production
issue — transcription has never succeeded once, confirmed via
transcribe_worker logs. Skip anything not needed to ship this fast.

## Confirmed root cause, from live logs, not a guess

Every transcription attempt fails identically:

```
File "/workspace/apps/api/tasks/transcribe_tasks.py", line 143, in transcribe_asset
    model = _get_model()
File "/workspace/apps/api/tasks/transcribe_tasks.py", line 44, in _get_model
    from faster_whisper import WhisperModel
File ".../faster_whisper/utils.py", line 8, in <module>
    import requests
ModuleNotFoundError: No module named 'requests'
```

`faster_whisper` needs `requests` to download its model, and it isn't
installed in the `transcribe_worker` container's Python environment.
The task retries (`self.retry(exc=exc)` at line 210) but every retry
hits the exact same missing-module error, so it just fails repeatedly
until retries are exhausted — this is not transient, it will never
succeed as currently built.

## Fix

Find where `transcribe_worker`'s Python dependencies are declared
(requirements file, pyproject, or wherever this image's dependency
list lives — check if it's shared with or diverges from the main
`api`/`worker` image's dependency file) and add `requests` explicitly.
Check whether this is a genuinely missing top-level dependency, or a
symptom of something else — e.g. if `faster_whisper` is expected to
pull in `requests` as its own transitive dependency but something
about how this image is built (multi-stage build copying from a
different stage, a `--no-deps` install, a trimmed production
requirements file) drops transitive dependencies. Fix at the real
cause, not just by adding one missing package name if the actual
problem is that transitive deps get dropped generally — check whether
other libraries in this image have the same latent gap.

Rebuild `transcribe_worker` with `--no-cache` (plain `--build` has
silently no-op'd on this host before) and verify the new image
actually contains `requests` before considering this done — don't
just trust the build succeeded.

## Verification

Real environment: upload a fresh video, confirm transcription actually
completes this time (not just dispatches) — check the transcribe_worker
logs directly for a success line, and confirm the transcript is
retrievable via the asset's Transcript tab with real content, not just
"transcribing..." forever. Also retry the two already-failed assets
from the logs (07a62cae-81cd-491d-92a0-91a9ad000433 and
9d6395a7-ecd1-4b89-87fd-92b0ef3d6c27) if there's a way to manually
trigger a retry, since they'll otherwise sit failed. Push and report
back.
