# FreeFrame Roadmap

Living backlog of planned features — nothing below is built unless marked **Shipped**. This is the shareable, human-readable overview. For implementation-level detail, open technical questions, confidence-tagged research, and sourcing, see the "Roadmap: collaboration platform expansion" section of `CLAUDE.md` (that file stays local to the dev machine; this one is tracked on GitHub so it's readable by collaborators and by Claude working from any clone, including the server).

Last updated: 2026-07-31.

## Desktop capture & offload app (Mac, then Windows)

**Phase 1 — capture, upload, verify.** A native app that ingests footage from a card or drive, uploads it to FreeFrame, and verifies the upload against the source (a real checksum comparison, not just an HTTP success) before the user trusts a card is safe to wipe. Smallest useful version — ships first.

**Phase 2 — drive-to-drive checksummed offload.** Copy footage between drives directly, independent of FreeFrame: one source to one destination, one source to many destinations at once, many sources to many destinations, and chained/cascading copies (card → local drive A → then A → drive B and/or FreeFrame, each hop verified before the next starts). Verification manifests are written in **ASC MHL**, the existing open industry standard for this exact job — already used by Silverstack, Hedge, and other professional offload tools — instead of a proprietary format, so a FreeFrame offload is verifiable by tools a collaborator may already run. The checksum algorithm is chosen per copy job, not forced platform-wide — ASC MHL supports MD5, SHA-1, xxHash (64/XXH3/XXH128), and C4 — and the app shows a short strengths/weaknesses summary next to the picker so people can actually make an informed choice:

| Algorithm | Strength | Weakness | Pick it for |
|---|---|---|---|
| xxHash (64/XXH3/XXH128) | Fastest by far — the right choice on multi-hundred-GB card offloads | Not cryptographic; won't catch deliberate tampering | Default: routine "did the copy work" checks |
| MD5 | Fast, universally supported | Cryptographically broken (deliberate collisions possible) | Matching an existing MD5-based pipeline |
| SHA-1 | Common legacy default in post/broadcast | Also cryptographically broken; slower than MD5 with no real corruption-detection edge over it | Matching an existing SHA-1-based pipeline |
| C4 | Cryptographically strong (SHA-512-based); resists deliberate tampering, not just accidental corruption | Slower; long 90-character encoded identifier, awkward to eyeball or transcribe | Offloads that might need to hold up as evidence later (legal, insurance, disputed authorship) |

**Design reference**: [ingesto](https://github.com/noar-justedit/ingesto), an open-source camera-ingest app, covers a lot of this ground already (copy-mode tiers, checksum lists, MHL export, kiosk mode). It's GPL-3.0 licensed, which doesn't mix cleanly with this project's MIT license, so the plan is to build FreeFrame's own app using it as a UX/feature reference rather than forking its code — see `CLAUDE.md` for the full reasoning.

**UI color rule**: process/status indicators (verified, failed, in progress, not started) always use FreeFrame's existing status colors — the same green/amber/red/blue palette already used for approvals and upload status in the web app — so the desktop app speaks the same visual language. Everything else (buttons, highlights, general chrome) uses FreeFrame's actual brand accent color, not a default app color.

**Phase 3 — resumable uploads and full automation.** True cross-restart resume for FreeFrame uploads — an interrupted transfer picks up without re-hashing the source or re-scanning the destination — plus cascading multi-hop copy chains and automatic NLE detection with an offer to install the matching FreeFrame plugin. The hardest phase technically (new server-side upload-state tracking), so it comes last, once phases 1 and 2 are solid.

Windows port follows once the Mac app is stable across all three phases — not built in parallel from day one.

## Direct editor-to-editor transfer

Two editors sharing files directly instead of always routing through FreeFrame. Same network: the app discovers the other machine and links them directly (mDNS discovery + direct encrypted transfer, the same proven approach the open-source LocalSend app uses — no need to invent this from scratch). Different networks, or no easy direct path: fall back to pushing the file through the FreeFrame server instead, so it always works regardless of network. True internet-wide peer-to-peer (bypassing NATs/firewalls without a relay) is deliberately out of scope — it's unreliable in practice and its own fallback path ends up being "route through a server" anyway, so it doesn't earn its complexity.

## NLE integration

DaVinci Resolve first, Premiere Pro second — explicit priority order. Goal: once footage is uploaded and transcribed, the editor pulls that transcript straight into the NLE to drive captions and native AI editing features, instead of only viewing it inside FreeFrame. These are two separate builds, not one integration with two skins — Resolve's Python/Lua scripting API and Premiere's UXP/CEP plugin architecture share no code, only a common FreeFrame API to call.

## Rights & authenticity

Two different problems, kept separate on purpose:

- **Camera-verified authenticity** (Sony, Leica, and any future camera that joins the same standard): both vendors already implement the open C2PA standard, so one manifest reader covers both rather than building per-vendor integrations. Read-only and cryptographically signed at capture — FreeFrame displays it, never allows it to be edited, and flags a broken signature as a tamper signal rather than a missing-data case.
- **Usage rights / licensing** (model releases, usage windows, licensed-footage expiry): unsolved, no design yet. Needs its own scoping pass before anything gets built.

## Per-project technical QC

Admins and owners set the expected technical spec per project — codec, resolution, frame rate, color space, loudness target. A non-conforming upload gets a warning popup but isn't blocked outright: a soft gate, not a hard rejection. Built on ffprobe/ffmpeg, already in use elsewhere in this pipeline.

## Playback: LUFS normalization + waveform display

A LUFS target selector in the playback window, parallel to the existing LUT selector — pick a loudness target for real-time, non-destructive playback normalization. A waveform view below the playback bar, togglable, with adjustable track height and independent listen/mute checkboxes per track for multi-track audio.

## Download system revamp

Replace the current LUT-aware download with an export options modal: current LUT, current LUFS setting, neither, or a mixture — including the option to pick a different LUT or LUFS target than what's active in the viewer — with a still-frame preview and a rough waveform estimate before exporting.

## Transcript search + future AI

Search by spoken word across the transcripts FreeFrame already generates for every upload. Later, once the project has a defined AI strategy: auto-summarize spoken topics and highlight likely-interesting sections.

## Cam2Cloud-style live ingest

Extend beyond camera-card ingest to live productions and podcasts, with an option for live transcription during the session itself — a different technical path from today's batch (whole-file) transcription pipeline.
