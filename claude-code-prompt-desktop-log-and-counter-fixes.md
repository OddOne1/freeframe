# Claude Code prompt — desktop: conditional date/time rows, per-folder counter, log visibility + readability

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §81, §82, §83, §84 — read all four first. Build AFTER
`claude-code-prompt-desktop-offshoot-suffix-and-date-override.md`
(§77/§78/§79/§80) if that hasn't landed yet — §81 depends on §78's
Date row existing, §82 touches the same `naming.js` functions §77
just changed. Four otherwise-independent changes combined into one
build. Do not run `npm test` or any e2e script other than
`node scripts/test-naming.js` (pure logic, no Electron) — see
CLAUDE.md's standing rule about `apps/desktop`'s test suite being
unscoped and focus-stealing.

## Part A — §81: Date/Time rows only show when the pattern uses those tokens

### Current state (confirmed, don't re-investigate)

- §78 shipped the Date row unconditionally in the naming card.
- `tokensIn(template)` (`naming.js`) does token detection main-side;
  confirmed via `grep` that nothing in `apps/desktop/src/renderer/`
  currently calls it — it's not exposed to the renderer today.
- Date tokens: `{date}`, `{YYYY}`, `{YY}`, `{MM}`, `{DD}`. Time tokens:
  `{hh}`, `{mm}` (lowercase, per §65's case-sensitive date/time split —
  don't confuse `{MM}` month with `{mm}` minutes).

### Build

1. Expose token detection to the renderer for the active preset's
   `folderTemplate`/`fileTemplate` — reuse an existing IPC round trip
   if one already carries this (check what `presets:preview` already
   returns before adding a new channel).
2. Gate §78's Date row: visible only when a date token is present in
   either template.
3. New Time row, directly below Date, same visual family (input +
   "Now"/"Clear", matching §78's control): visible only when a time
   token is present. Both rows edit the SAME underlying `Date`/
   `dateOverride` value from §78 — Date edits the calendar-day parts,
   Time edits the hour/minute parts, both feed the one `now` value
   `buildRelMapper()` receives. Not two independent overrides.
4. Neither row joins `preset.fields` — same "control outside the
   per-field list" placement §78 established.

### Verification

Activate a preset whose patterns use no date/time tokens — confirm
neither row appears. Add a date token to the pattern — confirm the
Date row appears (and only Date, not Time). Add a time token too —
confirm the Time row also appears. Set both overrides — confirm a
real job renders the overridden date AND time. Remove the time token
from the pattern (keep the date token) — confirm the Time row
disappears again without losing whatever the Date override was set to.

## Part B — §82: auto-counter resets per destination folder

### Current state (confirmed, don't re-investigate)

- `prepare(relFiles)` (`naming.js:390-431`) assigns `indexFor` as ONE
  running sequence across the whole job, with no awareness of which
  destination folder a file lands in.
- `mapRel()` (`:454-486`) computes a file's destination folder as
  `prefix` (from `renderTemplate(folder, values, ctx)`) + `keepDir`
  (from `flatten`/`path.dirname(rel)`, `:463-469`) — this exact
  computation needs to be available to `prepare()` too, ideally via a
  shared helper rather than two copies.
- Folder patterns can't contain `{counter}` (rejected by §65c's
  `folderPatternError()`), so a file's destination-folder key can be
  computed before any index exists — no circular dependency.
- The auto-suffix's counter mode (§77, `pad(ctx.index, 4)`,
  `naming.js:442-449`) reads from the same `ctx.index` as the
  `{counter}` token — fixing `indexFor`'s assignment fixes both
  automatically.

### Build

1. Factor the destination-folder-key computation out of `mapRel()`
   into a shared helper, callable from `prepare()` too.
2. In `prepare()`: group `relFiles` (excluding sidecars via
   `followsMedia`, unchanged) by that folder key. Within each group,
   assign `indexFor` starting at 1, independent of every other group.
3. No changes needed in `renderBaseFor()`/`mapRel()` themselves beyond
   what already reads from `indexFor`.

### Verification

Build a job whose files span two different rendered destination
folders (e.g. via preserved source directory structure, `keepDir`
non-empty for some files). Confirm EACH folder's files number
`_0001`, `_0002`, ... independently — the second folder must NOT
continue from where the first left off. Confirm sidecar files still
correctly follow their media file's number (§23d pairing unaffected).
Confirm a single-folder job (the common case) is unchanged —
`_0001`-`_0013` for 13 files, nothing different from before this
build. Re-run the real "TEST" pattern from earlier reports and confirm
the specific confusion reported (`_0016`-`_0020` continuing into an
unrelated sidecar folder) no longer happens.

## Part C — §83: "Open Log" button visibility

### Current state (confirmed, don't re-investigate)

`panel.css:58-63`, `.job-log` — `border: 1px solid var(--border)`,
`color: var(--text-secondary)`. `var(--accent)` is this app's blue
(`index.html:22,135,146,345,388-389`).

### Build

Change `.job-log`'s border and/or text color to `var(--accent)`.
Check the result against the actual dark background rather than
assuming — pick border-blue+text-blue or text-blue+neutral-border,
whichever is legibly higher-contrast in practice. Ensure `:hover`
stays clearly distinguishable from resting state, not just marginally
brighter.

### Verification

Open the running app, find a finished job's "Open Log" button, confirm
it reads clearly against the panel background at rest and on hover.

## Part D — §84: per-file log entries show source/dest names + a rename flag; readable content first

### Current state (confirmed, don't re-investigate)

- "Open Log" (`main.js:1150-1152`) opens the log JSON file directly
  via `shell.openPath()` — there is no in-app log viewer, so the FILE
  itself is what a user reads.
- `buildJobLog()` (`main.js:61-80`) currently returns
  `{ freeframeTransferLog, job: {...}, summary: job.summary }`.
- `job.summary.nodes[].files[]` (`copy-engine.js:681-686`, survives
  through `publicNode()` at `:755-768`) already has per-file `file`
  (source rel path), `bytes`, `sourceHash`, `ok` — but NOT the
  rendered destination path. That data exists one level up, in
  `runLeg()`'s `entry.destinations[i].path` (`copy-engine.js:309-324`),
  and needs to survive the trim at `:681-686` instead of being
  dropped.

### Build

1. `copy-engine.js:681-686`: extend each `n.files` entry with the
   destination path/filename for THIS node (`n.path`) — read it from
   `f.destinations.find((d) => d.destRoot === n.path)?.path`, same
   pattern `summarizeRoot()` already uses a few lines above at
   `:352-355` to find a node's own destination entry within a file's
   `destinations` array.
2. `main.js`'s `buildJobLog()`: restructure into two clearly-labeled
   sections. A `readable` section first: job label, source,
   destination(s), safe-to-wipe verdict, and a per-file list showing
   source filename → destination filename, with a `renamed: true/false`
   flag (`path.basename(sourcePath) !== path.basename(destPath)`,
   computed here or in copy-engine — your call which layer owns it).
   A `technical` section after it: everything currently in `job`/
   `summary`, unchanged in content, just moved under this key. Decide
   whether `freeframeTransferLog` needs a version bump for this shape
   change and say which you chose in the build report.

### Verification

Run a job WITH a renaming preset active — open its log file, confirm
each entry shows source filename, destination filename, and
`renamed: true` where they differ. Run a plain copy with NO renaming
preset — confirm entries show `renamed: false` with identical source/
destination names. Confirm the readable section reads sensibly on its
own without needing the technical section, and the technical section
still has everything it had before (nothing lost, just relocated).
Confirm a mismatched/failed file still shows correctly in the readable
section, not just buried in the technical mismatches array.
