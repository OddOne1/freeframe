/**
 * §228c — the rules themselves: the phone density (items 3, 4) and the
 * compact-landscape mode (item 6).
 *
 * These assert the CSS and the media queries as TEXT, the same way
 * viewer-bar-overflow.test.tsx does for §228 and §228b, and for the same
 * reason: jsdom applies no media queries and performs no layout, so a
 * component test can show that the hooks are on the right elements but
 * never that the rule reading them says the right thing. The pixels are
 * measured in Chromium instead — row heights, pairwise gaps, pill insets
 * and the landscape columns — and those numbers are in the §228c report.
 *
 * What is worth pinning here is the SHAPE of the decisions, because each
 * one has a specific wrong version that looks identical in a diff:
 *
 *   - the capability query, which must not be a width;
 *   - the two `md`+ steps of the touch ladder, which must not fire on a
 *     short screen;
 *   - the density selectors, which must be two classes deep so they beat
 *     a Tailwind utility whatever order the two end up in;
 *   - the phone queries, which must be `max-width: 767px` — the same line
 *     `useIsPhone` draws — so a 768px touch tablet is untouched.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) =>
  fs.readFileSync(path.join(process.cwd(), p), 'utf8')

/** The rules without the prose, for assertions about what a block MATCHES
 *  rather than what it explains. Every block in globals.css is commented at
 *  length, and those comments name the very features the rules must not
 *  use. */
const rulesOnly = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const CSS = read('app/globals.css')
const HOOK = read('hooks/use-media-query.ts')
const PAGE = read('app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx')
const SHELL = read('components/layout/dashboard-shell.tsx')
const TRANSCRIPT = read('components/review/transcript-panel.tsx')

// ─── item 6: the query ──────────────────────────────────────────────────

describe('§228c item 6 — compact landscape is a capability, not a width', () => {
  it('the hook asks for a coarse pointer, no hover and a short screen', () => {
    expect(HOOK).toContain(
      "'(hover: none) and (pointer: coarse) and (max-height: 500px)'",
    )
  })

  it('and asks nothing about width, which is what broke landscape', () => {
    const i = HOOK.indexOf('export const COMPACT_LANDSCAPE')
    const decl = HOOK.slice(i, HOOK.indexOf('\n\n', i))
    expect(decl).not.toContain('width:')
  })

  it('the CSS half of it is written the same way, feature for feature', () => {
    expect(CSS).toContain(
      '@media (hover: none) and (pointer: coarse) and (max-height: 500px) {',
    )
  })

  it('the layout branch tests it BEFORE the width breakpoint', () => {
    // At 667x375 both match. Stacking into 375px of height is the problem,
    // so the landscape answer has to win.
    const landscape = PAGE.indexOf('compactLandscape ? (')
    const portrait = PAGE.indexOf('portraitPhone ? (')
    expect(landscape).toBeGreaterThan(-1)
    expect(portrait).toBeGreaterThan(landscape)
    expect(PAGE).toContain('const portraitPhone = useIsPhone() && !compactLandscape')
  })

  it('and the shell reads the SAME hook, so they cannot disagree', () => {
    expect(SHELL).toContain('useCompactLandscape')
    expect(SHELL).toContain('const viewerOwnsScreen = isAssetViewer && compactLandscape')
  })
})

describe('§228c item 6 — the bar in compact landscape', () => {
  const block = CSS.slice(
    CSS.indexOf('@media (hover: none) and (pointer: coarse) and (max-height: 500px) {'),
  )

  it('is 40px tall, not the desktop 48 or the portrait 44', () => {
    expect(block).toMatch(/:root \.viewer-topbar \{\s*min-height: 40px;/)
  })

  it('and wins on SPECIFICITY, because order cannot beat a variant utility', () => {
    // Measured in the production bundle: Tailwind emits `max-md:`,
    // `hover-none:` and `md:` utilities after everything in globals.css,
    // so `.viewer-topbar` alone lost to `max-md:min-h-11` and the bar was
    // 44px at 667x375. `:root` is (0,1,1) against the utility's (0,1,0).
    for (const sel of [
      ':root .viewer-topbar',
      ':root .vbar-back-label',
      ':root .viewer-topbar .viewer-tap',
    ]) {
      expect(block).toContain(sel)
    }
  })

  /**
   * §232 item 3 — the safe area, REDUCED, and on text and controls only.
   *
   * §228c padded this bar and `.viewer-landscape` by the full
   * `env(safe-area-inset-*)`, untested, because Chromium reports 0 for
   * every inset. On a real iPhone in landscape that is ~59pt on the
   * Dynamic-Island side and ~47pt on the other, and the owner's
   * screenshot shows the result: ~65pt of black down each side of the
   * screen with the content squeezed between them.
   *
   * The contract this asserts is the one §232 asks for by name: a
   * `max(12px, calc(inset - 24px))` per side, no FULL-inset side padding
   * left on either class, and the insets reached through
   * `--safe-area-*` so a test can set them (the `env()` definition is in
   * `@layer base`, outside this block).
   *
   * §230 — the arithmetic now has ONE home, `--compact-inset-*`, because
   * Settings and the project view need the identical reduced inset and a
   * second copy of it further down globals.css is how the two would
   * drift. `--viewer-inset-*` is an alias of it, so every §232 rule below
   * still reads exactly as it was written. Both halves are asserted:
   * where the arithmetic lives, and that the viewer's name still reaches
   * it.
   */
  it('reduces the side inset rather than using all of it', () => {
    expect(block).toMatch(
      /--compact-inset-left: max\(12px, calc\(var\(--safe-area-left\) - 24px\)\);/,
    )
    expect(block).toMatch(
      /--compact-inset-right: max\(12px, calc\(var\(--safe-area-right\) - 24px\)\);/,
    )
  })

  it('and the viewer reaches that one definition rather than restating it', () => {
    expect(block).toMatch(/--viewer-inset-left: var\(--compact-inset-left\);/)
    expect(block).toMatch(/--viewer-inset-right: var\(--compact-inset-right\);/)
    // Exactly one place in the whole stylesheet carries the constants.
    const CSS = block
    expect(CSS.match(/max\(12px, calc\(var\(--safe-area-/g)?.length).toBe(2)
  })

  it('the bar keeps text and controls clear of the cutout with that reduced inset', () => {
    expect(block).toMatch(
      /:root \.viewer-topbar \{[^}]*padding-left: var\(--viewer-inset-left\);/,
    )
    expect(block).toMatch(
      /:root \.viewer-topbar \{[^}]*padding-right: var\(--viewer-inset-right\);/,
    )
  })

  it('and NEITHER class pads by the full inset any more', () => {
    // The mutation this is here to catch: putting `env(safe-area-inset-*)`
    // back on the padding of either class.
    const topbar = /:root \.viewer-topbar \{[^}]*\}/.exec(block)?.[0] ?? ''
    const landscape = /\n  \.viewer-landscape \{[^}]*\}/.exec(block)?.[0] ?? ''
    expect(topbar).not.toContain('env(safe-area-inset-left)')
    expect(topbar).not.toContain('env(safe-area-inset-right)')
    expect(landscape).not.toContain('env(safe-area-inset-left)')
    expect(landscape).not.toContain('env(safe-area-inset-right)')
  })

  it('the two-column layout itself has NO side padding, so nothing is letterboxed', () => {
    expect(block).toMatch(
      /\n  \.viewer-landscape \{\s*padding-left: 0;\s*padding-right: 0;/,
    )
    // The home indicator is real and ~21pt, and was not what was
    // reported: the bottom inset is unchanged.
    expect(block).toMatch(/\.viewer-landscape \{[^}]*padding-bottom: max\(0px, var\(--safe-area-bottom\)\);/)
  })

  it('the transport row and the panel’s children carry the inset instead', () => {
    expect(block).toMatch(
      /\[data-testid='viewer-landscape-media'\] \[data-testid='video-transport-compact'\] \{\s*padding-left: var\(--viewer-inset-left\);/,
    )
    // The panel's CHILDREN, not the panel: padding on the panel would
    // shorten its border-left and the composer's border-top.
    expect(block).toMatch(
      /\[data-testid='viewer-landscape-panel'\] > \* \{\s*padding-right: var\(--viewer-inset-right\);/,
    )
  })

  it('and the insets are reachable from a stylesheet, which is the only way to test them', () => {
    // Chromium has no notch. `env()` cannot be overridden; a custom
    // property can, which is what the Playwright run does.
    expect(CSS).toMatch(/--safe-area-left: env\(safe-area-inset-left\);/)
    expect(CSS).toMatch(/--safe-area-right: env\(safe-area-inset-right\);/)
    expect(CSS).toMatch(/--safe-area-bottom: env\(safe-area-inset-bottom\);/)
  })

  it('the composer shortens its placeholder in compact landscape only', () => {
    // At 16px (§228b's iOS no-zoom floor) "Leave your comment..." is
    // wider than the ~160px of field a 300px panel leaves once the
    // timecode chip is in it, so it wrapped to a second line that a 36px
    // field then clipped. The text is what gives way — not the height,
    // and not the font size.
    const INPUT = read('components/review/comment-input.tsx')
    expect(INPUT).toContain('const compactLandscape = useCompactLandscape()')
    expect(INPUT).toMatch(/compactLandscape\s*\?\s*replyToId \? "Reply…" : "Comment…"/)
    // Portrait and desktop keep the long one.
    expect(INPUT).toContain('"Leave your comment..."')
  })

  it('brings both target floors in the bar down to 36, together', () => {
    // Together, or the taller one sets the row and the bar is not 40: a
    // 40px bar has a 39px content box once its 1px border is counted.
    expect(block).toMatch(
      /:root \.viewer-topbar \.viewer-tap,\s*:root \.viewer-topbar \.viewer-tap-36 \{\s*min-height: 36px;\s*\}/,
    )
  })

  it('and the transport row fits inside the viewport', () => {
    // Measured at 844x390 before this rule: the timecode chip's box ran to
    // y=393 against a 390px viewport, because its buttons were still 44.
    expect(block).toMatch(
      /\[data-testid='video-transport-compact'\] \{\s*height: 40px;/,
    )
    expect(block).toMatch(
      /\[data-testid='video-transport-compact'\] button \{\s*height: 36px;\s*min-height: 36px;/,
    )
  })

  it('drops the filter/sort/search row while the keyboard is open', () => {
    // 844x390 with a 200px keyboard leaves 190px: the 40px bar, the 43px
    // tab row and the 99px composer are 182 of it, and the 40px toolbar
    // overflowed its own 8px container — box to y=123 against a composer
    // starting at 91. Measured, both before and after.
    expect(block).toMatch(
      /\[data-testid='viewer-landscape-layout'\]\[data-keyboard='open'\][\s\S]*?\[data-testid='comment-panel-toolbar'\] \{\s*display: none;/,
    )
  })

  it('but keeps the tab switch, which is the way out of the composer', () => {
    expect(block).not.toContain("[data-testid='viewer-panel-tabs'] {")
  })

  it('and brings back the word "Back", which `md:hidden` would hide', () => {
    expect(block).toMatch(/:root \.vbar-back-label \{\s*display: inline;/)
    expect(PAGE).toContain('vbar-back-label md:hidden')
  })
})

describe('§228c item 6 — the two-row bar steps stay off a short screen', () => {
  it('the nav group only takes its own row on a screen over 500px tall', () => {
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(min-height: 501px\) \{\s*\.vbar-nav \{/,
    )
  })

  it('and so does the left/right split below it', () => {
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(min-height: 501px\) \{\s*\.vbar-left \{/,
    )
  })

  it('both guards are inside the touch ladder, so no mouse can reach them', () => {
    // A 1000x480 DESKTOP window must behave exactly as it did: these two
    // steps live under `@media (hover: none)`, and the mouse ladder above
    // them is untouched.
    const touchLadder = CSS.slice(
      CSS.indexOf('@media (hover: none) {'),
      CSS.indexOf('/* ─── A 44px minimum'),
    )
    expect(touchLadder).toContain('(min-width: 768px) and (min-height: 501px)')
    const mouseLadder = CSS.slice(
      CSS.indexOf('@container viewerbar (max-width: 904px)'),
      CSS.indexOf('/* ─── The same four steps'),
    )
    expect(rulesOnly(mouseLadder)).not.toContain('min-height: 501px')
  })

  it('and the 44px bump for touch tablets carries the same guard', () => {
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(min-height: 501px\) \{\s*\.viewer-tap-36 \{\s*min-height: 44px/,
    )
  })
})

// ─── item 3: the Fields rows ────────────────────────────────────────────

describe('§228c item 3 — the Fields rows, phones only', () => {
  const block = CSS.slice(
    CSS.indexOf('/* ─── Fields tab, phones'),
    CSS.indexOf('/* ─── Transcript, phones'),
  )

  it('is scoped to `max-width: 767px`, the line `useIsPhone` draws', () => {
    expect(block).toContain('@media (max-width: 767px) {')
    // A touch tablet keeps the 44px controls §228 gave it: no `hover`
    // feature in any RULE here, or it would catch one.
    expect(rulesOnly(block)).not.toContain('hover:')
  })

  it('takes the row padding to 4px and the controls to 36', () => {
    expect(block).toMatch(
      /\.viewer-fields \.viewer-field-row \{\s*padding-top: 0\.25rem;\s*padding-bottom: 0\.25rem;/,
    )
    expect(block).toMatch(
      /\.viewer-fields \.viewer-field-control \{\s*height: 2\.25rem;\s*min-height: 2\.25rem;/,
    )
  })

  it('4 + 36 + 4 is 44 — the top of the band this item asks for', () => {
    const control = /height: (\d+\.?\d*)rem;\s*min-height/.exec(block)
    const pad = /padding-top: (\d+\.?\d*)rem;\s*padding-bottom/.exec(block)
    const px = (rem: string) => Number(rem) * 16
    const row = px(control![1]) + 2 * px(pad![1])
    expect(row).toBeGreaterThanOrEqual(40)
    expect(row).toBeLessThanOrEqual(44)
  })

  it('packs the five stars to 36 and leaves the vote breakdown alone', () => {
    expect(block).toMatch(
      /\.viewer-fields \.viewer-stars > button \{\s*height: 2\.25rem;\s*width: 2\.25rem;/,
    )
    // `> button`, not a descendant: the per-voter breakdown underneath is
    // a 14px DISPLAY, and growing those would push its rows apart.
    expect(block).toContain('.viewer-stars > button')
  })

  it('and every selector is two classes deep, so order cannot beat it', () => {
    for (const sel of [
      '.viewer-fields .viewer-field-row',
      '.viewer-fields .viewer-field-control',
      '.viewer-fields .viewer-fields-name',
    ]) {
      expect(block).toContain(sel)
    }
  })

  it('36 is never below the floor §228b set for a non-primary target', () => {
    const floor = /\.viewer-tap-36 \{\s*min-height: (\d+)px/.exec(CSS)
    expect(Number(floor![1])).toBe(36)
    expect(block).toContain('2.25rem') // 36px
  })
})

// ─── item 4: the transcript rows ────────────────────────────────────────

describe('§228c item 4 — the transcript rows, phones only', () => {
  const block = CSS.slice(
    CSS.indexOf('/* ─── Transcript, phones'),
    CSS.indexOf('/* ─── A phone on its side'),
  )

  it('is scoped to `max-width: 767px` and nothing else', () => {
    expect(block).toContain('@media (max-width: 767px) {')
    expect(rulesOnly(block)).not.toContain('hover:')
  })

  it('a one-line row is 36px with 8px of padding', () => {
    expect(block).toMatch(
      /\.viewer-transcript-list \.viewer-transcript-row \{\s*min-height: 2\.25rem;\s*padding-top: 0\.5rem;\s*padding-bottom: 0\.5rem;/,
    )
  })

  it('`min-height`, so a two-line sentence still grows', () => {
    const row = /\.viewer-transcript-row \{([^}]*)\}/.exec(rulesOnly(block))![1]
    expect(row).toContain('min-height')
    expect(row).not.toMatch(/(^|[^-])height:/)
    expect(row).not.toContain('overflow')
    expect(row).not.toContain('max-height')
  })

  it('the two header rows become one slimmer block', () => {
    expect(block).toMatch(/\.viewer-transcript-head \{\s*padding-top: 0\.25rem/)
    expect(block).toMatch(/\.viewer-transcript-head-first \{\s*border-bottom-width: 0;/)
  })

  it('the switch comes down with them, by overriding the right property', () => {
    // `tap-target-44` sets `width: max(100%, 44px)`, which a `min-width`
    // cannot bring down.
    expect(block).toMatch(
      /\.viewer-transcript-head \.tap-target-44::before \{\s*width: max\(100%, 2\.25rem\);\s*height: max\(100%, 2\.25rem\);/,
    )
  })

  it('and the active row is still just a background colour', () => {
    const i = TRANSCRIPT.indexOf('viewer-transcript-row')
    const btn = TRANSCRIPT.slice(i, i + 700)
    expect(btn).toContain("isActive")
    expect(btn).toContain('bg-bg-hover')
    // Nothing that would reserve a second line for it.
    expect(btn).not.toContain('min-h-[')
    expect(btn).not.toContain('h-12')
  })

  it('tapping a row still seeks', () => {
    expect(TRANSCRIPT).toContain('onClick={() => onSeek(seg.start)}')
  })
})
