# Claude Code prompt — per-file transcription toggle (start/stop),
folder/project default, and live progress bar

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Touches
`apps/api` and `apps/web`. Run backend tests and `npx vitest run` at
the end.

## Context — transcription itself now works

As of today (commits 4aa6d44, 714457c, 13d6fb5), transcription is
confirmed working end to end in production via `transcribe_worker`
(faster-whisper). This prompt builds the control surface around it,
not the transcription pipeline itself.

## Feature 1 — per-file transcription toggle (start/stop switch)

Every file gets one toggle, not a one-shot "transcribe" button:

- Turning it on: if no transcript exists (never attempted, previously
  failed, or the asset predates auto-transcription), start
  transcription. If a transcript already exists, this is a no-op — the
  toggle reflects "should this file end up transcribed," not "trigger
  a fresh run."
- Turning it off while transcription is actively running (task
  dispatched, in progress) must cancel that specific in-progress run.
  This needs real Celery task cancellation, not just ignoring the
  eventual result. `transcribe_worker` runs `concurrency=1` — think
  through what a forced task termination mid-run does to the asset's
  stored state (transcription_status, any partial data) so it doesn't
  end up stuck "processing" forever afterward, the same failure shape
  as earlier stuck-processing bugs found today. Store whatever's
  needed (the Celery task ID at minimum) to make cancellation possible
  — revoke with terminate, and make sure the task itself either checks
  for a cancellation signal periodically or handles being killed
  cleanly at the process level.
- Turning it off when nothing is running (no transcript exists yet)
  just means "don't auto-attempt," nothing to cancel.

## Feature 2 — folder/project default for the toggle

Setting an auto-transcription default at the folder or project level
does not touch any existing file. It only determines what a new file's
per-file toggle starts as when that file is added after the setting
was made. A file's individual toggle (Feature 1) can always be flipped
regardless of its folder/project default — the default only decides
the starting state, not an ongoing link back to the folder/project
setting.

Scope the actual UI/data model for where this setting lives (folder
metadata? project settings?) and how it's presented, but the behavior
above is fixed, not up for reinterpretation.

## Feature 3 — live progress bar for in-progress transcription

`faster_whisper`'s `transcribe()` call yields segments incrementally,
each carrying a start/end timestamp. Compute
`(latest segment's end time / total audio duration)` as a live
percentage while a transcription is running, and publish/persist it
the same way video-processing progress already works (`processing_progress`
mechanism built earlier today for video transcode progress — reuse
that pattern rather than building a second one). Expect and account
for a flat/slow start in the UI: model loading and the VAD pre-filter
pass happen before the first segment is ever yielded, so the
percentage will sit at or near 0 for a while before moving — don't let
that read as stuck/broken.

## Verification

Real environment, not just code inspection:

- Turn on the toggle for a file with no transcript — confirm
  transcription actually starts and a progress bar appears and
  advances.
- Turn the toggle off mid-run — confirm the task is actually cancelled
  (check transcribe_worker logs for the task stopping, not completing),
  and confirm the asset's state afterward is clean, not stuck.
- Set a folder-level default on, then add a new file to that folder —
  confirm its toggle starts on and transcription begins automatically.
  Confirm a file already in that folder before the setting was changed
  is unaffected.
- Confirm a file's individual toggle can still be flipped against its
  folder/project default in either direction.
- Confirm the progress bar reaches 100% and clears/updates correctly
  when a transcription completes normally (not just when cancelled).

Run backend tests and `npx vitest run` for the whole app at the end —
report pass/fail counts, flag anything not already a documented
pre-existing failure.
