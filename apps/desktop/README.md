# FreeFrame Desktop (name TBD)

Camera/drive offload companion app for FreeFrame. Mac first, Windows to follow once the Mac app is stable. See `/ROADMAP.md` and `CLAUDE.md`'s "Roadmap" section at the repo root for the full feature plan (drive-to-drive checksummed copy, ASC MHL manifests, FreeFrame upload + verify, LAN transfer between editors, NLE detection).

Framework: **Electron**, chosen 2026-08-01 over Tauri — matches [ingesto](https://github.com/noar-justedit/ingesto) (our design reference, not a code base — it's GPL-3.0, this repo is MIT), and has the most proven signing/notarization pipeline via `electron-builder`, which matters a lot here (see below).

## Current state

This is a scaffold, not phase 1. What exists:

- App shell (`src/main/main.js`) — window, IPC, secure `contextBridge` preload (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` — the renderer has zero direct Node/fs access, everything goes through `preload.js`'s narrow bridge).
- Volume enumeration (`src/main/volumes.js`) — lists everything mounted under `/Volumes`, classified as `removable` / `internal` / `external` / `network` via `diskutil info -plist` + `plutil` (both ship on every Mac, no extra parsing dependency). Windows will need its own implementation behind the same `listVolumes()` shape later.
- Minimal renderer UI (`src/renderer/index.html`) — shows the volume list, manual refresh. No source/destination assignment, no copying, no checksums yet.
- `electron-builder.yml` — mac target (universal: arm64 + x64), hardened runtime, entitlements, and a notarization hook (`build-resources/notarize.js`) — all structured correctly but **not wired to a real signing identity yet** (see below).

Not built yet: source/destination assignment, the copy engine, checksum algorithms, ASC MHL export, copy-mode tiers (FAST/VERIFIED/SECURE/PRO), FreeFrame upload integration. Those come next, in the order laid out in `CLAUDE.md`'s "Roadmap" section.

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
