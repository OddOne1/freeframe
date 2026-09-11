# Claude Code prompt — web: LUT reference-image thumbnails

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §35 — read it first. This is entirely a client-side
feature; no backend work is needed, every fetch/parse/render piece it
needs already exists elsewhere in the codebase, this is assembly, not
new infrastructure.

## What to reuse (read these before writing anything new)

- `apps/web/lib/lut/webgl-lut.ts` — `LutRenderer.render(source, width,
  height)` draws any image source through a parsed LUT via WebGL2.
  This is the actual rendering step; don't reimplement LUT application.
- `apps/web/hooks/use-lut.ts:66-106` — the fetch/parse/cache pattern
  for a LUT's `.cube`: `fetch(resolveApiMediaUrl(lut.file_url))` →
  `.text()` → `parseCube()`, cached in a module-level `Map<string,
  ParsedCube>` keyed by LUT id (`cubeCache`). Reuse this shape (either
  literally share `cubeCache`, or mirror it) rather than writing a
  second fetch/parse path.
- `Lut.file_url` (`apps/web/types/index.ts:778`) is already present on
  every LUT object from both `/me/luts` and `/luts/platform` — no API
  change needed.

## Build

1. **Reference image**: bundle one static image as a public asset.
   Needs to be something you can legally ship (self-generated /
   public-domain — not a scraped stock photo) with a reasonable mix of
   tones to grade against (skin tone, sky or shadow, a saturated
   color) — the same spirit as the reference images DaVinci
   Resolve/Premiere's LUT browsers use. State in your report what you
   used and how you sourced/generated it, so it's easy to swap later
   if it's not a good fit.
2. **Thumbnail renderer**: for a given LUT id, fetch+parse its `.cube`
   (reusing/sharing the `cubeCache` pattern above), load the reference
   image once (module-level, not per-LUT), render it through
   `LutRenderer` at a small size (something like 96×64 — this is a
   glance-preview, not a full image), and cache the output (canvas or
   dataURL) per LUT id in a second module-level `Map`, mirroring
   `cubeCache`'s lifetime/invalidation story: a LUT's `.cube` content
   never changes after upload, so once rendered, cache for the
   session.
3. **Wire into both places LUTs are listed**:
   - `apps/web/app/(dashboard)/settings/luts/page.tsx`'s `LutRow`
     (`:327` on) — thumbnail next to the name.
   - `apps/web/components/review/lut-picker.tsx`'s `renderItem`
     (`:66-82`) — thumbnail in each dropdown row (may need to shrink
     further given the dropdown's compact width; use your judgment on
     sizing there, it just needs to read as a distinct color swatch,
     not a detailed photo, at that scale).
4. **Don't block the list on this.** Text (name, size) should render
   immediately as it does today; thumbnails fill in as each LUT's
   `.cube` is fetched/parsed/rendered — lazily (e.g. only for rows
   currently visible, if that's easy with what's already in this repo)
   or simply asynchronously or item-by-item is fine, your call, as
   long as a library with many LUTs doesn't visibly stall before
   showing anything.

## Verification

Open Settings → LUTs with several LUTs in your library and confirm
each row gets a distinct-looking thumbnail (not all identical — a
strong color-shift LUT and a subtle one should visibly differ). Open
the `LutPicker` dropdown in the video review toolbar and confirm the
same. Confirm a freshly-uploaded LUT's thumbnail appears without a
full page reload. Confirm this doesn't regress the actual grading
preview (the real `LutRenderer` instance applied to video/image
playback) — this feature should be additive, using its own renderer
instance(s) for thumbnails, not fighting over the same canvas/GL
context as the live preview.
