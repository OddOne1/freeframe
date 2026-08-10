# FreeFrame Desktop (name TBD)

Camera/drive offload companion app for FreeFrame. Mac first, Windows to follow once the Mac app is stable. See `/ROADMAP.md` and `CLAUDE.md`'s "Roadmap" section at the repo root for the full feature plan (drive-to-drive checksummed copy, ASC MHL manifests, FreeFrame upload + verify, LAN transfer between editors, NLE detection).

Framework: **Electron**, chosen 2026-08-01 over Tauri — matches [ingesto](https://github.com/noar-justedit/ingesto) (our design reference, not a code base — it's GPL-3.0, this repo is MIT), and has the most proven signing/notarization pipeline via `electron-builder`, which matters a lot here (see below).

## Current state

A working checksummed offload tool — one source, many destinations in parallel, optional cascading chains, every file verified. A FreeFrame project can now be either end of a job: uploaded to (unverified, see below) or pulled from (verified like any other copy). What exists:

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
- **Live volume detection** — the main process watches `/Volumes` (debounced 300 ms, since one mount fires several fs events) and pushes `volumes:changed`; the renderer re-lists. Plugging in a card needs no clicks. Verified by actually mounting and ejecting a disk image via `hdiutil` and watching the list update untouched.
- **Free/total space comes from `statfs`**, not `diskutil`. Both of the failures this fixes were real on this machine: a 52 TB SMB share reported `total=null free=null` because diskutil describes physical devices and a network share has none; and the APFS boot volume reported **0 bytes free** because free space belongs to the container shared by the System and Data volumes, not to the single volume queried. `statfs` matches `df` byte-for-byte on both. `bavail` not `bfree`, so root-reserved blocks aren't counted as space you can fill. The same failure also mis-classified the SMB share as `external`; unclassifiable-by-diskutil now reads as `network`.
- **Per-device folder picking** — the context menu on a volume offers **"Source Folder ▸"** and **"Destination Folder ▸"** submenus, each holding **Browse…** (the native dialog, rooted at that mount point), that role's own **Recent Folders:**, and **Clear Recents**. The general header buttons stay, since they're the right tool for a plain folder-to-folder move; the per-device variant is what disambiguates *which* drive a folder is on when several cards are being offloaded at once.
  - **Recents are keyed by device *and* role.** One value per device meant the last folder picked for either role overwrote the other's memory, so a drive whose source was `PROG` and destination was `Prints` offered `Prints` under both labels — wrong, not merely limited. Up to five per role per device, in `userData`, most-recent first, re-picking promotes rather than duplicates. Clearing is scoped to the one role on the one device whose submenu it sits in.
  - The legacy single-value file is **dropped rather than migrated**: which role that folder belonged to is unrecoverable, and copying it into both slots would reproduce the duplicate listing on first launch.
  - **Once a card holds a role, the opposite role's plain actions are hidden** — "Set as Destination" and the whole "Destination Folder ▸" submenu disappear from a card that is already the source, and vice versa. They were fully enabled and pure noise.
  - The same-volume-both-roles capability keeps exactly one menu path: a single **"Also use as Destination…"** (or "…as Source…") below a separator, replacing the three redundant opposite-role entries. It routes into the existing conflict modal, same as the drag path. Kept rather than left drag-only because this app's stated principle is that every drag action has a menu path — drag-only is a real precision and accessibility problem.
- **A source can be individual files, not just a folder.** The source picker accepts files as well as directories (a destination stays directory-only — it has to be somewhere to write into). One file keeps its own path as its key; several become a file-set source, which the engine serves through `localFilesSource` — a separate provider from `localSource` because hand-picked files have no common root for the nesting checks to work against. Copying a file into the directory it already lives in is refused, as is a selection containing two files with the same name.
- **Native drag-and-drop from Finder** onto Sources or Destinations, via `webUtils.getPathForFile` in the preload (the sandboxed renderer can't reach `webUtils`). Entirely separate from the in-app pointer drag, which is untouched — a non-file drag is ignored by these handlers. The window itself also swallows stray file drops, because Electron's default is to *navigate the page to the dropped file*, which makes the app vanish with no way back.
- **A volume can hold both roles.** Copying between two folders on one RAID is a real workflow, so assigning a volume as source no longer silently evicts it from Destinations (and vice versa). Instead the conflict raises a modal offering a subfolder for each role, with Cancel reverting only the assignment that caused it. The bare volume root is never allowed on both sides — that would copy a folder into itself.
- **Unassign by dragging back** to the middle column, mirroring the context menu's Remove, with the same drop-ready affordance the other two zones already had. Manually-picked folders that end up unassigned are pruned from the list rather than lingering forever; real mounted volumes never are.
- **Eject / disconnect** from the context menu — `diskutil eject` for physical media, `diskutil unmount` for network shares (Finder's own distinction). The internal drive is refused **in the main process**, and the type is re-derived there from the live volume list rather than taken from the renderer; eject is also refused outright while a copy job is active. `diskutil`'s stderr is surfaced verbatim, since "in use by PID …" names the app to quit and "eject failed" doesn't. No renderer-side refresh after success — the `/Volumes` watcher already handles it.
- **Selectable checksum algorithm** — xxHash64 (default), MD5, SHA-1 and C4, behind one streaming hasher interface so the copy-time hash and the verify-time re-hash can never disagree. C4 is the real SMPTE ST 2114 identifier (SHA-512 → base58 → 90 chars with a `c4` prefix), verified against the reference implementation's published vector rather than implemented from description. Every algorithm is checked against an independent digest and for chunk-boundary independence, because the engine hashes in 4 MiB stream chunks. The picker carries the researched strengths/weaknesses text for each option — four names alone would just get people picking the first one.
- **Overlay scrollbars** on the columns — invisible at rest, appearing on hover of the scrolling area, in the macOS convention rather than Chromium's default light bar.
- **FreeFrame account (first pass)** — sign in with email + password (`POST /auth/login`), refresh-on-401 mirroring `apps/web/lib/api.ts` so the ~15-minute access token doesn't silently start failing. **The token never crosses the contextBridge**: it lives in the main process and is persisted with Electron's `safeStorage` (OS keychain), and if `safeStorage` isn't available the session simply isn't persisted rather than being written to disk in plaintext. The sign-in screen is built against `apps/web`'s own (`app/(auth)/layout.tsx` + the classic branch of `components/auth/login-form.tsx`) — same wordmark (synced from `apps/web/public/logo.svg`), accent glow, card measurements and tagline. It adds a Server field, which the web login has no equivalent of because there the server is wherever the page came from.
  - A stored session is dropped **only** on a 401/403 from `/auth/refresh`. It used to be dropped on any non-ok response *and* the token file deleted, so a single 502 from a restarting container at launch signed the user out permanently, with no way to recover but logging in again. A network failure now leaves the session untouched entirely.
  - **The MIME type is detected from the extension, and this is load-bearing.** Uploads used to send `application/octet-stream` for everything. The API accepts it, but `mime_to_asset_type` maps it to `AssetType.video` *unconditionally* — so an image or an audio file was created as a video, `process_asset` ran the ffmpeg branch on it, that failed, and `list_assets` hides assets whose versions all failed. The bytes reached S3 and the row existed, and **nothing appeared on the site**. An unrecognised extension is now refused with a message rather than sent as octet-stream, since "uploaded successfully, invisible forever" is the worst of both.
  - **Uploads are still not verified.** The summary says `allVerified: false`, labels the count "Uploaded" rather than "Verified", and carries an upload-specific verdict — but it is not a verified copy. **Real post-upload verification (re-fetch the bytes from FreeFrame, re-hash, compare — what local destinations already do) remains unbuilt and is a genuine outstanding feature, not a closed item.** The display was made honest; the guarantee didn't change.
  - **Projects render as projects**, not as generic devices: the poster when one is set, and otherwise the project's own gradient — the same eight presets and the same `projectId` hash `apps/web/lib/gradient-utils.ts` uses, so a project is the same colour in both apps.
  - **A folder inside a project can be picked** for either direction, from the same context menu as the per-device folder pickers. Absent a choice a project means its root, which is what it always meant.
- **A FreeFrame project can be a source** — pulling a folder down to local drives, verified the same way any other copy is. The engine takes a *source provider* rather than only a directory path; the FreeFrame one fetches over HTTP and is injected from `main.js`, so `copy-engine.js` keeps its no-`electron` guarantee. Once `open()` yields a stream, the single fan-out read, the hashing and the read-back-from-disk verification are unchanged code.
  - **No backend change was needed.** `GET /projects/{id}/assets` already takes `folder_id` (`"root"` or a UUID) and `recursive`, and returns each asset's filename, byte size and processing status — the whole manifest in one request, with `recursive=true` covering a subtree.
  - **`open()` must emit chunks that own their memory.** Chunks off a TLS fetch body are views into buffers the TLS layer reuses; the engine hashes synchronously and writes asynchronously, so as soon as backpressure queues a write the bytes behind it get overwritten before they reach the disk. The result is a file of exactly the right length whose contents diverge partway through — differently on every run — while the source hash stays stable and *correct*. `openAssetStream` therefore copies every chunk. Caught by the end-to-end pull test (two pulls of one asset: identical source hashes, two different files on disk), not by reading the code.
  - **Not everything can be pulled.** `?download=true` only resolves to the original upload for **video**; `get_stream_url`'s other branch uses `s3_key_processed or s3_key_raw` even for downloads, so a processed image or audio asset serves the derivative while `file_size_bytes` still describes the original (measured: a 38.5 MB WAV came back as 1.2 MB, a 260 KB JPEG as 274 KB). Those assets are **skipped with a reason** and reported in the summary rather than silently substituted — an offload tool that swaps a proxy for the master and calls it verified is worse than one that says it couldn't get the original. Lifting this needs a backend change; the smallest safe one is an additive `original=true` parameter on `/assets/{id}/stream` that forces `s3_key_raw` for every asset type, leaving the web app's existing download behaviour untouched.
  - A project **cannot** be a cascade parent, and cannot be the source and a destination of the same job. Cascading re-reads the parent from disk to prove what landed; there is no disk to re-read for a project.
- `electron-builder.yml` — mac target (universal: arm64 + x64), hardened runtime, entitlements, and a notarization hook (`build-resources/notarize.js`) — all structured correctly but **not wired to a real signing identity yet** (see below).

**Deliberately not built yet** (each a separate follow-up, not an oversight): the FAST / VERIFIED / PRO tiers, ASC MHL manifest export, the multi-algorithm picker and its tradeoff explainer (xxHash64 is hardcoded for now), double source read, folder-naming templates, multi-level chains and fan-out in the UI (the engine already handles both), and FreeFrame upload. See `CLAUDE.md`'s "Roadmap" section for the sequencing.

### Tests

```bash
pnpm test          # engine + e2e
pnpm test:engine   # copy engine against real files in temp dirs
pnpm test:e2e      # launches Electron, drives the real UI over CDP
pnpm test:polish   # the 7 polish behaviours, incl. a real hdiutil mount cycle
pnpm test:freeframe # FreeFrame integration against the real API (no login)
pnpm test:polish2   # second polish pass, dev mode
pnpm test:subfolder # subfolder role highlighting on the parent volume
pnpm test:menu      # context menu: role gating, submenus, per-role recents
pnpm test:ff-ui     # project tiles, sign-in screen, folder picker, project-as-source
pnpm test:ff-source # pulls a real folder DOWN from the live API and verifies it
pnpm test:upload    # uploads real files and proves server-side what landed
pnpm test:packaged  # builds a real .app and runs the same suite against it
```

**`test:upload` is the one that catches "it said it worked".** It uploads a
real file per asset type and then asks the *server* what exists, because
`list_assets` hides assets whose versions all failed — which is exactly how
the octet-stream bug stayed invisible while the client reported success. It
leaves its `ffdesk-<timestamp>` assets in the project and names them at the
end; they aren't deleted, because that would mean adding a destructive
delete-asset method to the production bridge purely for a test.

**`test:ff-source` needs a signed-in session** and talks to the real server.
It is read-only there — it lists and downloads, never uploads or modifies —
and writes into a temp directory. It picks the smallest folder available so
it stays a quick check rather than a multi-GB download. Without a session it
exits 2 and says so rather than passing vacuously. This is the test that
found the TLS chunk-reuse corruption described above; nothing that stubbed
the network would have.

**`test:packaged` matters more than it looks.** A missing `#account` element
once threw in top-level script code and silently killed every statement
after it — including the bootstrap `refresh()` — so the app launched empty
and the checksum picker was inert. Every existing harness still passed,
because they injected state directly and never exercised the app's own
initialization. `e2e-polish2.js` now asserts *no uncaught exception during
page load* as its first check, and can run against a packaged `.app`, which
is where that class of bug was actually caught.

`test:polish` is deliberately **not** part of `pnpm test`: it attaches and
detaches a real disk image, which is a side effect a default test run
shouldn't have on someone's machine.

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
