/**
 * The viewer top bar's degradation contract (§228 B), read out of the CSS
 * and the markup rather than measured — jsdom resolves no container
 * queries at all, and the measured version is the Chromium audit in the
 * §228 report (390 / 360 / 320 / 768, `scrollWidth <= innerWidth`).
 *
 * What is worth pinning here is the SHAPE of the rule, because that is
 * what a well-meaning edit breaks:
 *
 *  - it is a container query on the bar, not a window breakpoint, because
 *    the bar's width is the window MINUS the sidebar rail;
 *  - the steps go in the owner's order — labels, then the `⋯` menu, then
 *    the asset nav's own row, then the action group's;
 *  - no step fires at the width a 1280px, 1440px or 1024px window gives
 *    the bar, which is what "desktop is pixel-identical" means in CSS;
 *  - the bar WRAPS, with no `md:flex-nowrap` to undo it: the last two
 *    steps work by `flex-basis: 100%`, which on a nowrap row pushes the
 *    next group off-screen instead of moving it down (measured: x=1032
 *    on a 768px tablet);
 *  - and the panel toggle is not in the `⋯` menu, because being the last
 *    item of an overflowing row is how it got lost in the first place.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const PAGE = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx'),
  'utf8',
)

/** The `@container viewerbar (max-width: N)` block bodies, in file order. */
function steps(): { width: number; body: string }[] {
  const out: { width: number; body: string }[] = []
  const re = /@container viewerbar \(max-width: (\d+)px\) \{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(CSS))) {
    // Walk braces from the block's opening one so a nested @media is kept.
    let depth = 1
    let i = re.lastIndex
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++
      else if (CSS[i] === '}') depth--
      i++
    }
    out.push({ width: Number(m[1]), body: CSS.slice(re.lastIndex, i - 1) })
  }
  return out
}

/** Bar widths a given window gives this bar: window - rail - padding. */
const barAt = (win: number, rail = 52) => win - rail - 24

describe('§228 — the bar is a container, not a breakpoint', () => {
  it('declares itself one', () => {
    expect(CSS).toMatch(/\.viewer-topbar \{[^}]*container-type: inline-size/)
    expect(CSS).toMatch(/\.viewer-topbar \{[^}]*container-name: viewerbar/)
  })

  it('and the markup carries the class', () => {
    expect(PAGE).toMatch(/className="viewer-topbar flex flex-wrap /)
  })

  it('with no `md:flex-nowrap` to undo the wrapping the steps rely on', () => {
    // The regression this pins: `flex-basis: 100%` on a nowrap row does
    // not wrap the group, it pushes the next one past the right edge.
    // Read out of the className, not the file — the comment above it in
    // page.tsx names `md:flex-nowrap` as the thing that must not come back.
    const cls = /className="(viewer-topbar[^"]*)"/.exec(PAGE)?.[1] ?? ''
    expect(cls).toContain('flex-wrap')
    expect(cls).not.toContain('flex-nowrap')
  })
})

describe('§228 — the steps, in the owner’s order', () => {
  const byWidth = (w: number) => steps().filter((s) => s.width === w).map((s) => s.body).join('\n')

  it('labels go first', () => {
    expect(byWidth(904)).toMatch(/\.vbar-label \{\s*display: none/)
  })

  it('then the secondary actions fold into the ⋯ menu', () => {
    const body = byWidth(764)
    expect(body).toMatch(/\.vbar-inline \{\s*display: none/)
    expect(body).toMatch(/\.vbar-more \{\s*display: flex/)
  })

  it('then the asset nav takes a row of its own, ordered LAST', () => {
    const body = byWidth(624)
    // `order: 3` matters as much as the basis: the nav sits between the
    // name and the actions in the DOM, so wrapping it where it stands
    // would push the actions onto a third row.
    expect(body).toMatch(/\.vbar-nav \{[^}]*order: 3/)
    expect(body).toMatch(/\.vbar-nav \{[^}]*flex-basis: 100%/)
  })

  it('and last of all the action group does, at md+ only', () => {
    const body = byWidth(504)
    expect(body).toMatch(/@media \(min-width: 768px\)/)
    expect(body).toMatch(/\.vbar-right \{[^}]*flex-basis: 100%/)
    // BOTH groups: a 100%-basis right group beside a `flex: 1 1 0%` left
    // group fills the line exactly and never wraps — it just squeezes the
    // asset name to nothing, which is the original bug.
    expect(body).toMatch(/\.vbar-left \{[^}]*flex-basis: 100%/)
  })

  it('each step is narrower than the one before it', () => {
    const widths = steps().map((s) => s.width)
    const outside = widths.slice(0, 4)
    expect(outside).toEqual([...outside].sort((a, b) => b - a))
  })
})

describe('§228 — the desktop widths are below every threshold', () => {
  const widest = () => Math.max(...steps().filter((s) => s.width < 1000).map((s) => s.width))

  it('1440px, 1280px and 1024px windows all clear the first step', () => {
    for (const win of [1440, 1280, 1024]) {
      expect(barAt(win)).toBeGreaterThan(widest())
    }
  })

  it('while a 768px one does not — which is the point', () => {
    expect(barAt(768)).toBeLessThan(widest())
  })
})

describe('§228 — the same steps move up on a touch device', () => {
  it('because every control in the bar is 44px there, not 28', () => {
    const touch = CSS.slice(CSS.indexOf('@media (hover: none) {', CSS.indexOf('.viewer-topbar')))
    expect(touch).toMatch(/@container viewerbar \(max-width: 1100px\)[\s\S]*?\.vbar-label/)
    expect(touch).toMatch(/@container viewerbar \(max-width: 1000px\)[\s\S]*?\.vbar-more/)
    expect(touch).toMatch(/@container viewerbar \(max-width: 900px\)[\s\S]*?\.vbar-nav/)
    expect(touch).toMatch(/@container viewerbar \(max-width: 760px\)[\s\S]*?\.vbar-right/)
  })

  it('and none of it can reach a mouse, so the desktop shots are unaffected', () => {
    // `hover: none` is a media FEATURE, not a width: a 1440px mouse never
    // matches it, and a touch laptop at 1440px deliberately does.
    const i = CSS.indexOf('@media (hover: none) {', CSS.indexOf('.viewer-topbar'))
    expect(i).toBeGreaterThan(0)
    expect(CSS.slice(i, i + 40)).not.toMatch(/min-width/)
  })
})

describe('§228 — the 44px minimum is removed again for a mouse at md+', () => {
  it('so the desktop bar keeps its 28px controls exactly', () => {
    expect(CSS).toMatch(/\.viewer-tap \{\s*min-height: 44px;\s*min-width: 44px;\s*\}/)
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(hover: hover\) and \(pointer: fine\) \{\s*\.viewer-tap \{\s*min-height: 0;\s*min-width: 0;/,
    )
  })

  it('and it is on the controls that were too small', () => {
    // §228b item 3g split this list in two. Back and the panel toggle are
    // on the PRIMARY list and keep `viewer-tap` (44). The navigation and
    // the `⋯` trigger moved to `viewer-tap-36`, which is 36 below `md`,
    // 44 on a touch tablet and nothing at all for a mouse — see the
    // §228b block at the bottom of this file.
    for (const id of ['viewer-back', 'viewer-panel-toggle']) {
      const i = PAGE.indexOf(`data-testid="${id}"`)
      expect(i, id).toBeGreaterThan(0)
      // the className sits within a few lines of the testid
      expect(PAGE.slice(Math.max(0, i - 600), i + 600)).toMatch(/viewer-tap(?!-)/)
    }
    for (const id of ['viewer-prev-asset', 'viewer-next-asset', 'viewer-overflow-trigger']) {
      const i = PAGE.indexOf(`data-testid="${id}"`)
      expect(i, id).toBeGreaterThan(0)
      expect(PAGE.slice(Math.max(0, i - 600), i + 600)).toContain('viewer-tap-36')
    }
  })
})

describe('§228 — the panel toggle is never in the overflow menu', () => {
  it('it is its own always-rendered control at md+', () => {
    // The §228 bug: it was the LAST item of a row that overflowed, so on
    // a phone it was off-screen and the panel could not be opened at all.
    const menu = PAGE.slice(
      PAGE.indexOf('data-testid="viewer-overflow-menu"'),
      PAGE.indexOf('data-testid="viewer-panel-toggle"'),
    )
    expect(menu).not.toContain('Toggle sidebar')
    expect(menu).not.toContain('Columns2')
    // §228c — the flag is `phoneChrome` now (`useIsPhone` OR a phone on
    // its side); the toggle is absent in both, for the same reason.
    expect(PAGE).toMatch(/\{!phoneChrome && \(\s*<button\s+onClick=\{\(\) => setSidebarOpen/)
  })

  it('and it carries no `vbar-inline`, so no step can hide it', () => {
    const i = PAGE.indexOf('data-testid="viewer-panel-toggle"')
    expect(PAGE.slice(i - 400, i + 400)).not.toContain('vbar-inline')
  })
})

describe('§228 — the phone player height always leaves room below it', () => {
  it('is capped at 40dvh, per media type', () => {
    expect(CSS).toMatch(/\.viewer-phone-media \{[\s\S]*?height: min\(40dvh/)
    expect(CSS).toMatch(/\.viewer-phone-media\[data-media='video'\][\s\S]*?100vw \* 0\.5625/)
    // §228b item 3c — 240, not 252: the compact transport row is 44px
    // rather than 56px, so 160 (waveform) + 36 (scrubber) + 44.
    expect(CSS).toMatch(/\.viewer-phone-media\[data-media='audio'\][\s\S]*?240px/)
  })

  it('and yields further to the on-screen keyboard', () => {
    expect(CSS).toMatch(/--viewer-media-cap: calc\(100dvh - var\(--kb, 0px\) - 350px\)/)
    expect(PAGE).toContain("'--kb'")
  })

  it('`dvh`, never `vh` — iOS reports 100vh without its toolbars', () => {
    const block = CSS.slice(CSS.indexOf('.viewer-phone-media {'))
    expect(block).not.toMatch(/\b\d+vh\b/)
  })
})

// ─── §228b — the compact phone rows, and the floor under their targets ──

const VIDEO = fs.readFileSync(
  path.join(process.cwd(), 'components/review/video-player.tsx'),
  'utf8',
)
const AUDIO = fs.readFileSync(
  path.join(process.cwd(), 'components/review/audio-player.tsx'),
  'utf8',
)

describe('§228b item 3g — a 36px floor beside the 44px one', () => {
  it('`viewer-tap-36` is 36 below md, 44 on a touch tablet and nothing for a mouse', () => {
    expect(CSS).toMatch(/\.viewer-tap-36 \{\s*min-height: 36px;\s*min-width: 36px;\s*\}/)
    // A 768px touch tablet keeps exactly what §228 gave it, which is what
    // item 3i's "the tablet is pixel-identical" means for these controls.
    // §228c item 6 — `and (min-height: 501px)`: a phone on its side is
    // also 768px+ wide, and it keeps the 36px floor, because its bar is
    // 40px tall.
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(min-height: 501px\) \{\s*\.viewer-tap-36 \{\s*min-height: 44px;\s*min-width: 44px;/,
    )
    expect(CSS).toMatch(
      /@media \(min-width: 768px\) and \(hover: hover\) and \(pointer: fine\) \{\s*\.viewer-tap-36 \{\s*min-height: 0;\s*min-width: 0;/,
    )
  })

  it('and 36 is never larger than 44, so the primary list is never the smaller one', () => {
    const floor = (cls: string) =>
      Number(new RegExp(`\\.${cls} \\{\\s*min-height: (\\d+)px`).exec(CSS)![1])
    expect(floor('viewer-tap-36')).toBeLessThan(floor('viewer-tap'))
  })
})

describe('§228b item 3a — the one-row phone bar', () => {
  it('the nav only takes a row of its own at md+', () => {
    // Below `md` the owner wants ONE bar. Both ladders — the mouse one and
    // the `hover: none` one — have to agree, or a narrow desktop window
    // and a phone would disagree about the same width.
    for (const width of [624, 900]) {
      const body = steps().filter((s) => s.width === width).map((s) => s.body).join('\n')
      expect(body, String(width)).toMatch(/\.vbar-nav/)
      const i = body.indexOf('.vbar-nav')
      expect(body.slice(0, i), String(width)).toMatch(/@media \(min-width: 768px\)/)
    }
  })

  it('and the bar still wraps, which is the floor under every step', () => {
    const cls = /className="(viewer-topbar[^"]*)"/.exec(PAGE)?.[1] ?? ''
    expect(cls).toContain('flex-wrap')
    expect(cls).toContain('max-md:min-h-11')
  })
})

describe('§228b item 3c — the compact transport row', () => {
  it('is 44px tall, not 56, in both players', () => {
    for (const [name, src] of [['video', VIDEO], ['audio', AUDIO]] as const) {
      const i = src.indexOf(`data-testid="${name}-transport-compact"`)
      expect(i, name).toBeGreaterThan(0)
      const cls = /className="([^"]*)"/.exec(src.slice(i, i + 900))![1]
      expect(cls, name).toContain('h-11')
      expect(cls, name).not.toContain('h-14')
    }
  })

  it('play/pause keeps 44x44 — it is on the primary list', () => {
    for (const [name, src] of [['video', VIDEO], ['audio', AUDIO]] as const) {
      const i = src.indexOf('data-testid="player-play-pause"')
      expect(i, name).toBeGreaterThan(0)
      const cls = /className=(?:"([^"]*)"|\{[^}]*\})/.exec(src.slice(i, i + 600))![1] ?? ''
      expect(cls, name).toContain('h-11')
      expect(cls, name).toContain('w-11')
    }
  })

  it('settings and fullscreen drop to 36 wide', () => {
    for (const [name, src] of [['video', VIDEO], ['audio', AUDIO]] as const) {
      const i = src.indexOf('data-testid="player-settings-button"')
      const cls = /className="([^"]*)"/.exec(src.slice(i, i + 600))![1]
      expect(cls, name).toContain('w-9')
      expect(cls, name).toContain('h-11')
    }
  })

  it('and the timecode chip is a 28px box inside a 44px hit area', () => {
    for (const [name, src] of [['video', VIDEO], ['audio', AUDIO]] as const) {
      const i = src.indexOf('data-testid="player-timecode"')
      const chunk = src.slice(i, i + 700)
      expect(chunk, name).toContain('flex h-11 items-center')
      expect(chunk, name).toContain('h-7 items-center gap-1 rounded-md bg-bg-tertiary px-2')
    }
  })

  it('while the desktop row below it is untouched', () => {
    // Its own 48px band, its own 28px controls, `hover-none:` variants and
    // all — the public share viewer mounts this player and is out of scope.
    expect(VIDEO).toContain(
      'flex items-center justify-between h-12 px-4 bg-bg-secondary/80 border-t border-border shrink-0',
    )
    expect(AUDIO).toContain(
      'flex items-center justify-between h-12 px-4 bg-bg-secondary/80 border-t border-border shrink-0',
    )
  })
})

describe('§228b item 3c — the player cap follows the shorter row', () => {
  it('video: 16:9 plus the scrubber plus the 44px row', () => {
    expect(CSS).toMatch(/100vw \* 0\.5625 \+ 80px/)
    expect(CSS).not.toMatch(/100vw \* 0\.5625 \+ 92px/)
  })

  it('audio: the 160px waveform plus the scrubber plus the 44px row', () => {
    expect(CSS).toMatch(/\.viewer-phone-media\[data-media='audio'\][\s\S]*?240px/)
  })
})
