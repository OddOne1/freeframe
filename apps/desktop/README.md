# FreeFrame Desktop (name TBD)

Camera/drive offload companion app for FreeFrame. Mac first, Windows to follow once the Mac app is stable. See `/ROADMAP.md` and `CLAUDE.md`'s "Roadmap" section at the repo root for the full feature plan (drive-to-drive checksummed copy, ASC MHL manifests, FreeFrame upload + verify, LAN transfer between editors, NLE detection).

Framework: **Electron**, chosen 2026-08-01 over Tauri — matches [ingesto](https://github.com/noar-justedit/ingesto) (our design reference, not a code base — it's GPL-3.0, this repo is MIT), and has the most proven signing/notarization pipeline via `electron-builder`, which matters a lot here (see below).

## Current state

A working checksummed offload tool — one source, many destinations in parallel, optional cascading chains, every file verified. Not yet phase 1 (no FreeFrame upload). What exists:

- App shell (`src/main/main.js`) — window, IPC, secure `contextBridge` preload (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — the renderer has zero direct Node/fs access, everything goes through `preload.js`'s narrow bridge).
- Volume enumeration (`src/main/volumes.js`) — lists everything mounted under `/Volumes`, classified as `removable` / `internal` / `external` / `network` via `diskutil info -plist` + `plutil` (both ship on every Mac, no extra parsing dependency). Windows will need its own implementation behind the same `listVolumes()` shape later.
- **Copy engine (`src/main/copy-engine.js`) — SECURE tier, cascading-aware.** Takes a **tree** of destinations, not a flat list: each node has an optional `parentId`, where `null` means "copies from the original source" and a parentId means "cascades from that destination." Properties worth knowing:
  - **The source is read exactly once per leg regardless of how wide that leg is.** One read stream fans out to N write streams and feeds the hasher simultaneously, with explicit backpressure (a slow destination pauses the source rather than buffering the difference in RAM).
  - **Execution is by dependency wave.** Nodes whose parent has copied *and verified* become ready, ready nodes are grouped by the root they read from, and each group runs as one fan-out — so independent groups run in parallel while a cascade waits its turn. **A node whose parent failed is marked `skipped` and never copies**: cascading from an unverified copy would propagate corruption while reporting success, which is the one thing this tool must not do.
  - **Verification re-reads the destination from disk**, rather than re-hashing the buffer already in memory — that's the difference between proving the bytes landed and proving we can hash our own variable. Size is checked alongside the hash, since an empty file has a perfectly valid hash of its own.
  - **Cascaded legs copy *this job's* file list, not the parent's whole contents.** If destination A already held unrelated footage, cascading A → B passes the offload onward rather than mirroring the drive.
  - The tree supports fan-out (several nodes sharing a parentId) and multiple independent groups for free. Neither is exposed in the UI yet — v1 is single-chain — but the data model doesn't need revisiting to add them.
  - Per-file failures don't abort the run; one unreadable file still yields everything else, recorded as an error.
  - No `electron` import anywhere in it, on purpose — it runs under plain `node` so it can be tested without booting a window.
- **Three-zone interaction model (`src/renderer/index.html`)**, per the ingesto/Hedge-derived spec in the roadmap: a center column of every mounted volume, a **Sources** zone left and a **Destinations** zone right. Drag a volume into either zone to assign it; **drop a destination directly onto an existing destination to create a cascading group**, with a blue-outline indicator on the valid target while hovering and directional arrows (`source → A`, `A → B`) once created. A right-click menu offers **Set as Source / Set as Destination / Cascade from…** as a full non-drag path — drag-only is a real accessibility and precision problem, so both exist. "Choose folder…" sits in both zones, since offloading into a dated subfolder is the normal case, not whole-volume assignment.
  - Drag is implemented with **pointer events, not HTML5 drag-and-drop**. HTML5 DnD can't be driven by synthetic events, which would make the cascade interaction untestable, and it behaves inconsistently in Electron. Pointer events give the same UX with full control of the drop indicator — and are directly exercisable by the e2e test.
  - Per-node status dots and progress bars use the roadmap's **semantic color mapping** (verified → success green, failed → error red, in-progress → info blue, waiting → neutral), reusing the web app's existing tokens rather than inventing a parallel vocabulary.
  - **Line / square view toggle on the Volumes column only** — Sources and Destinations always stay as lists. Square tiles are matched to `apps/web/components/projects/asset-card.tsx` numerically, not approximately: `rounded-lg` 8px, `border-2` 2px with `border-transparent → hover:border-border-focus`, an `aspect-[16/10]` `bg-bg-tertiary` media area, and the same `h-14 w-14 rounded-2xl bg-bg-hover` fallback tile holding an `h-7 w-7` icon. Volumes have no thumbnail, so that fallback tile *is* the media area, carrying a per-type icon.
  - When the primary leg verifies, the UI says so explicitly — **the card can be ejected before the cascade finishes**, which is the actual point of cascading rather than a cosmetic detail.
- **Colors and icons come from the web app, not hand-copies.**
  - `packages/design-tokens/tokens.css` is the single source for every CSS custom property, consumed by `apps/web` via a plain `@import` in `globals.css` and copied into this app's renderer by `scripts/sync-tokens.js` on `predev`/`prebuild`/`pretest`. This renderer has no bundler, so a copy step is the honest alternative to adding one for one file. **`src/renderer/tokens.css` is generated and gitignored** — edit the package.
  - This mattered more than it sounds: the two had already drifted. The desktop copy carried `--bg-secondary #17171c` against the web's `#16161a`, a single `--border` where the web has three real border tokens, and text colors that were close but wrong. Divergence you can't see side by side is exactly the kind that survives review.
  - `scripts/sync-icons.js` generates `src/renderer/icons.js` from the `lucide` package pinned at **0.511.0** — the same release `apps/web` pins via `lucide-react ^0.511.0`, so the icon family is provably identical rather than drifting from whatever version a path was copied from. Generated rather than imported because the renderer runs `sandbox: true` / `nodeIntegration: false` and cannot `require()` anything, and a sandboxed preload can only require a small allow-list. Where `apps/web` already uses an icon for the same concept (`RefreshCw`, `List`/`LayoutGrid`, `X`, `AlertTriangle`, `FolderOpen`, `HardDrive`) the same one is used here.
- `electron-builder.yml` — mac target (universal: arm64 + x64), hardened runtime, entitlements, and a notarization hook (`build-resources/notarize.js`) — all structured correctly but **not wired to a real signing identity yet** (see below).

**Deliberately not built yet** (each a separate follow-up, not an oversight): the FAST / VERIFIED / PRO tiers, ASC MHL manifest export, the multi-algorithm picker and its tradeoff explainer (xxHash64 is hardcoded for now), double source read, folder-naming templates, multi-level chains and fan-out in the UI (the engine already handles both), and FreeFrame upload. See `CLAUDE.md`'s "Roadmap" section for the sequencing.

### Tests

```bash
pnpm test          # both suites
pnpm test:engine   # copy engine against real files in temp dirs
pnpm test:e2e      # launches Electron, drives the real UI over CDP
```

`test:engine` covers multi-destination copies, structure/unicode preservation, progress monotonicity, the guard rails (destination inside source, etc.), and — most importantly — that a corrupted or truncated destination is actually *caught*, and that `allVerified` goes false when a file genuinely can't be written. A verifier that always passes is worse than no verifier, so that case is asserted explicitly rather than assumed.

`test:e2e` launches the real app, attaches over the Chrome DevTools Protocol, and dispatches **real mouse events** — dragging a volume into Sources, two into Destinations, then dropping one destination onto the other to form a cascade — before running the copy and reading the result out of the real DOM. It asserts the blue-outline indicator appears on the valid target mid-drag, that the arrows label the real flow direction, and, most importantly, that **the cascaded leg only starts after its parent verifies** (checked against the ordering of `node-status` events, not by timing). It also asserts the live renderer's security posture: no `window.require`, no `window.process`, no raw `ipcRenderer`, and exactly the intended five bridge methods.

Both suites passed on macOS as of 2026-08-10 (52 engine checks, 34 e2e checks). Neither has been run on Windows — there is no Windows implementation of `volumes.js` yet. Nothing has been tested against a real camera card over USB, which is where macOS's removable-volume permission prompt first fires and where slow-device backpressure actually gets stressed.

## Dev setup

```bash
cd apps/desktop
pnpm install
pnpm dev
```

Runs unsigned, locally — this is fine and normal for development. Gatekeeper only blocks apps that have been *downloaded* (carry the quarantine flag); a local dev build launched via `pnpm dev` never hits that at all.

**If `pnpm dev` fails with `Electron failed to install correctly, please delete node_modules/electron and try installing again`** — this isn't Electron actually being broken. pnpm blocks dependency postinstall scripts by default (a supply-chain-safety default, since pnpm 9), and Electron's own postinstall script is what downloads the real Electron binary — skip that script and `node_modules/electron` never gets the binary, hence the error. `package.json`'s `pnpm.onlyBuiltDependencies` field pre-approves `electron`/`electron-builder`/`app-builder-bin` so a fresh `pnpm install` shouldn't hit this at all going forward. If it still does (e.g. an older pnpm that predates this config field, or the lockfile already has the packages marked skipped from a prior install): run `pnpm approve-builds`, select `electron` (and `electron-builder` if it's also listed), confirm, then `pnpm install` again before retrying `pnpm dev`.

## Before this can ship to anyone else — real blocker, not a formality

**User requirement (2026-08-01): install and launch on any Mac with zero admin password and zero trip to System Settings.** Since macOS Sequoia removed the old Control-click Gatekeeper bypass, the *only* way to meet that is Apple code signing + notarization. There is no packaging trick around it — ingesto's own README documents the exact `xattr -cr` / Settings-dialog workaround required for its unsigned builds, which is precisely what this app must avoid.

Checklist, in order:

1. **YON.Studio enrolls in the Apple Developer Program** (developer.apple.com, $99/year). Not done as of this scaffold (2026-08-01) — this is a real account/payment action a person at the company has to do, not something that can be scripted or done on your behalf.
2. Generate a **Developer ID Application** certificate under that account, and an app-specific password for notarization (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
3. Set `mac.identity` in `electron-builder.yml` (currently commented out on purpose) to the real certificate name.
4. Set three env vars before running `npm run build` for a real release: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `build-resources/notarize.js` picks them up automatically via electron-builder's `afterSign` hook.
5. `npm run build:mac` (universal, signed, notarized) — the resulting `.dmg` is what actually satisfies the "no admin, no Settings" requirement. `npm run build:mac:unsigned` exists for local testing only; never hand that build to anyone else.

Until step 1 happens, real feature work (volume detection, copy engine, checksums) can and should continue — none of it depends on having a signing identity. Signing/notarization is the last-mile step before the first build leaves this machine, not a blocker on writing the app itself.
