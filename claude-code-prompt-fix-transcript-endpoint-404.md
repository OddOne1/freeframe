# Claude Code prompt — fix transcript endpoint 404, transcripts don't
work at all currently

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Likely `apps/api`
and possibly `apps/web`. Run backend tests and `npx vitest run` at the
end.

## Confirmed symptom

`GET /api/assets/{id}/transcript?version_id=...` returns `404`,
confirmed live in Safari's console during unrelated testing this
session (asset `4876b3cf-b1d4-45f7-a253-6bce8e1134ad`,
`version_id=85e017bb-2b58-4a98-aa67-ffa285685154`). This is not new —
it's listed as pre-existing and unrelated to today's other outages.
Transcripts do not currently work end to end for users.

Auto-transcription + captions already shipped as a feature (scoped and
built earlier in this project). So this is likely NOT "transcription
was never implemented" — it's more likely one of:

- Transcription genuinely never runs for some/most assets (a dispatch
  gap, similar in shape to the `process_asset` Celery decorator bug
  found earlier today — check whether transcription is even being
  triggered on upload/processing completion).
- Transcription runs and produces a real transcript record, but the
  fetch endpoint is querying the wrong thing (wrong version_id
  resolution, wrong foreign key, a route that assumes a shape the data
  doesn't have) — a genuine mismatch between what's stored and what's
  requested, the same class of bug as today's normal-player version
  mismatch (Bug A from the urgent playback fixes).
- The endpoint exists and 404s correctly because no transcript was ever
  generated for that specific asset/version, in which case the real bug
  is upstream (transcription never dispatched or never completed) and
  this 404 is just the honest symptom of that.

Don't guess which — trace an actual asset through the whole pipeline:
confirm whether transcription was ever dispatched for it, whether a
transcript record exists in the database, and only then look at
whether the fetch endpoint can find and return it correctly.

## Fix

Once the real root cause is identified (dispatch gap vs. fetch-path
bug vs. genuinely-never-generated), fix it at the actual point of
failure. If this turns out to be a dispatch gap similar to the
`process_asset` decorator bug from earlier today, apply the same
rigor: check for other functions with the same bug shape nearby before
calling it done.

## Verification

Real environment, not just code inspection: pick an asset that should
have a transcript (or upload a fresh one), confirm a transcript is
actually generated and stored, then confirm `GET /api/assets/{id}/
transcript?version_id=...` returns it correctly (200, real transcript
content) rather than 404. Confirm the Transcript tab in the asset
review UI actually renders it. If transcription generation itself was
broken (not just the fetch), also confirm existing assets that were
supposed to have transcripts but don't — note whether they need
reprocessing, the same way stuck-processing assets did earlier today,
and report that gap explicitly rather than silently leaving it. Run
backend tests and `npx vitest run` for the whole app at the end —
report pass/fail counts, flag anything not already a documented
pre-existing failure.
