# Claude Code prompt — full self-verification pass, §86 through §99

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is an audit,
not a build — make no code changes unless you find and fix a genuine
regression (see step 5). If you fix anything, say so explicitly and
separately from the audit results; don't bury a fix inside a "verified"
line.

## Why

A large batch landed in one session — `e76aa4d` through `b70a459`
(desktop) plus §99 (web, pushed separately, may or may not have a
commit yet — check). Every commit was verified individually as it
landed (git diff read, relevant test script run), but nothing has been
exercised as a WHOLE — no full regression sweep across the combined
result, and several features have never been seen running in the real
app at all. This pass is that sweep, run by you rather than assumed
clean because the pieces were each fine on their own.

## Commits in scope

```
e76aa4d  §86  Two-tier checksum
c842477  §87  Phase 1 — per-job journal
afaf7b3  §88  piece 1 — finalized-checksum skip wording
c1f4f2b  §89  cascade-narrowing duplicate destination fix
61592f4  §92  Copy & Verify icon-group display
8138df8  §93  deviceFor() project fallback fix
cf4786b  §94  jobs:changed throttle
70f1293  §95  in-session Pause/Resume
3cd2a4d  §96  "Cancelling…" indicator
a0cf4e1  §98  Pause works on upload jobs
bd469a6  §97A crash-resume upload dedup
b70a459  §87 Phase 2  resume-detection prompt
+ §99 (web, multi-select) — check `git log` for whether it has landed;
  if not yet pushed/committed, note that and skip its section below
```

## Steps

1. `git log --oneline -20` — confirm this list matches reality before
   doing anything else. If commits are missing, out of order, or
   something else landed in between that you don't recognize, stop and
   report rather than auditing a tree you don't understand.

2. Run every pure-node test script that touches these commits, in one
   pass, and report full pass/fail for each — do not sample or skip
   any:
   ```
   cd apps/desktop
   node scripts/test-job-queue.js
   node scripts/test-copy.js
   node scripts/test-naming.js
   node scripts/test-filters.js
   node scripts/test-rate-settings.js
   node scripts/test-cascade.js
   ```
   If any of these don't exist or have been renamed, find the current
   equivalents rather than reporting "not found" as a failure.

3. **Cross-commit coherence check** — the kind of thing that only shows
   up once everything is combined, not in any single commit's own
   tests:
   - §94's broadcast throttle + §95's pause/resume + §96's cancelling
     flag all touch `JobQueue`/`onChange()` — confirm a job going
     running → paused → cancelling → cancelled fires the right sequence
     of broadcasts with no duplicate or missing status label in
     `panel.js`.
   - §98 (upload pause) + §97A (upload journal) + §87 Phase 2 (resume
     detection) all touch `runUpload()`'s closure — confirm pausing a
     job that ALSO has a resume-eligible journal from a PREVIOUS run
     doesn't produce two different "this job is special" code paths
     stepping on each other. Read `runUpload()` in full as it stands
     today, not per-commit diffs, and check nothing conflicts.
   - §87 Phase 2's `discardJournal` vs §97A's `finishJournal` vs
     `releaseJournal` — confirm exactly one of these three fires for
     any given job outcome (resumed-and-completed, resumed-and-
     cancelled-again, discarded, never-interrupted) and never two.
   - §93's `deviceFor()` fix + §89's cascade-narrowing fix — both
     touched destination-node identity logic; confirm a FreeFrame
     project used as BOTH a cascade parent's narrowing target AND
     checked by `deviceFor()` still behaves correctly combined, not
     just in each commit's own isolated test.

4. **Check for dead code / orphaned scope** — anything any commit's own
   message flagged as "not yet wired," "future work," or "someone
   else's scope" that might have silently become wireable once a LATER
   commit landed. Specifically: is `job.cancelling` (§96) now also
   relevant to a job in the "paused, about to be cancelled" state in
   any way §96 didn't originally anticipate, now that more pause states
   exist than when §96 was written? Read with fresh eyes rather than
   trusting each commit's own "not my scope" note as still accurate.

5. **If you find a genuine regression** (not a style nitpick, not a
   "could be cleaner," an actual behavior break): fix it, note exactly
   what broke and why in your report, and re-run the relevant test
   script to confirm the fix. Do not fix things that are merely
   unfinished/out-of-scope-as-designed (e.g. local-copy resume-from-
   journal not existing — that's known, not a bug).

6. **List what NONE of this can verify** — be explicit and complete,
   don't let this blend into the pass/fail summary. As of this pass,
   confirmed not yet seen running in the real app: §95's Pause/Resume
   UI on a local copy job, §96's "Cancelling…" label, §98's upload
   pause, §87 Phase 2's resume prompt (either trigger) and its discard
   path, and §99's multi-select if it has landed. State this as a
   punch list the user should walk through by hand, not as "these are
   probably fine."

## Report format

Pass/fail per test script. Pass/fail per coherence check in step 3.
Any regression found and fixed, called out on its own. The step-6
unverified-in-app list, verbatim, at the end — this is the part that
matters most for the user's own manual pass.
