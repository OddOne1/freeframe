# Claude Code prompt — desktop: fix the finalized-checksum "skipped" reason text (§88, piece 1 only)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §88 — read it first. This is a small, precise wording fix —
NOT the FreeFrame-cascade/upload-verification architecture work §88 also
describes, which is out of scope here and not being built yet. Do not
run `npm test` or any e2e script other than `node scripts/test-copy.js`.

## Current state (confirmed, don't re-investigate)

- `copy-engine.js:747-773`, the `else if (finalizedAlgorithm)` branch,
  sets `reason: "this job has no local source to re-read (FreeFrame
  upload or project source)"` and a comment above says "a FreeFrame-
  upload-only job has no local file left to re-read once the upload
  finished."
- Both are wrong about uploads specifically. Uploading TO FreeFrame does
  not consume or remove the local source — the card is still there.
- More importantly, this code is UNREACHABLE for an upload-only job in
  the first place: `startCopy()` (`index.html:3089`) only calls
  `window.freeframe.startCopy` (which reaches `runCopyJob`) `if
  (localNodes.length)` — an all-FreeFrame-destination job has zero local
  nodes, so `runCopyJob` never runs at all, and this branch never
  executes for it. The only real triggers reaching this branch are: the
  job was cancelled, or the job's SOURCE is a FreeFrame project
  (`source` truthy — pulling FROM a project has no local origin to
  re-read, which is the one part of the old reasoning that was actually
  correct).

## Build

1. `copy-engine.js:747-751` (the comment) and `:769-773` (the `reason`
   string): remove the "FreeFrame upload" framing entirely — it
   describes a case this code path cannot reach. State only the real
   triggers: cancellation, or a job whose source is a FreeFrame project
   (pulling FROM FreeFrame, no local origin to re-read). Suggested
   wording for the reason: `"this job's source is a FreeFrame project — there is no local copy to re-read"`.
2. Leave the actual gate logic (`if (finalizedAlgorithm && sourcePath &&
   !source && !cancelled)`) untouched — it's correct, only the English
   describing it was wrong.
3. If `test-copy.js`'s §86 section asserts against the old reason string
   anywhere, update the assertion text to match, without changing what
   it's actually testing (still: a finalized pass configured with no
   local destination-side source to re-read reports a skip, not an
   error).

## Verification

Run `node scripts/test-copy.js` — confirm the §86 finalized-checksum
section still passes with the updated wording. Read the new comment and
reason string once more and confirm they no longer mention "FreeFrame
upload" as a cause, since a real upload-only job never reaches this
code at all — say so explicitly in the build report if you find any
other place in this file that repeats the old, incorrect framing.
