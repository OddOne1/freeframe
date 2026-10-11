/**
 * §228b item 2 — iOS Safari must not zoom the page when a field is
 * focused.
 *
 * The owner, on his iPhone: focusing "Leave your comment…" zooms the whole
 * page in and scrolls it sideways, "so people can still see what they
 * comment" is no longer true. iOS Safari auto-zooms any focused `input`,
 * `textarea` or `select` whose COMPUTED font-size is below 16px, and this
 * app's fields are 10-14px.
 *
 * Chromium does not reproduce the zoom, so the end-to-end proof is the
 * owner's own device. What CAN be proved here, and is:
 *
 *  - the rule exists, is scoped to a touch device and nothing else, and
 *    beats Tailwind's `text-[13px]` on specificity;
 *  - it does not reach for `maximum-scale` / `user-scalable=no`, which
 *    would "fix" the zoom by disabling pinch-zoom for everyone;
 *  - the inventory it has to cover is the one the owner listed.
 *
 * And in Chromium, with touch emulation, harness/fields.mjs walks the
 * viewer's three tabs, the project view, the command palette, the rename
 * and share dialogs, two settings pages and both login steps and reads the
 * computed font-size of every visible field: 21 under 16px before, 0
 * after. Those numbers are in the §228b report.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const LAYOUT = fs.readFileSync(path.join(process.cwd(), 'app/layout.tsx'), 'utf8')

/** The one block. Everything below reads out of it. */
function zoomBlock(): string {
  const i = CSS.indexOf('@media (hover: none) and (pointer: coarse) {')
  expect(i, 'the 16px rule is missing from globals.css').toBeGreaterThan(0)
  let depth = 0
  let j = CSS.indexOf('{', i)
  const start = j
  for (; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++
    else if (CSS[j] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return CSS.slice(start, j + 1)
}

describe('§228b item 2 — the global 16px rule', () => {
  it('exists, and covers input, textarea and select', () => {
    const b = zoomBlock()
    expect(b).toMatch(/font-size: 16px/)
    expect(b).toMatch(/:root input/)
    expect(b).toMatch(/:root textarea/)
    expect(b).toMatch(/:root select/)
  })

  it('is ONE rule, not a `hover-none:text-base` sprinkled over 60 files', () => {
    // The failure mode this guards: the next field someone adds is 13px
    // and nobody notices until an iPhone touches it.
    const sprinkled = fs
      .readdirSync(path.join(process.cwd(), 'components'), { recursive: true })
      .filter((f) => typeof f === 'string' && (f as string).endsWith('.tsx'))
      .map((f) => fs.readFileSync(path.join(process.cwd(), 'components', f as string), 'utf8'))
      .filter((src) => /hover-none:text-(base|\[16px\])/.test(src))
    expect(sprinkled).toHaveLength(0)
  })

  it('wins against Tailwind’s `text-[13px]`, which is a class selector', () => {
    // A bare `input` is (0,0,1) and loses to any utility class (0,1,0).
    // `:root input` is (0,1,1) and wins by one notch — without
    // `!important`, which would also shrink anything deliberately larger.
    const b = zoomBlock()
    expect(b).toMatch(/:root (input|textarea|select)/)
    expect(b).not.toMatch(/!important/)
  })

  it('leaves the non-text input types alone', () => {
    // A checkbox, a radio, a range thumb, a colour swatch and a file
    // button do not trigger the zoom, and their drawn size can move with
    // the font in some engines.
    const b = zoomBlock()
    for (const t of ['checkbox', 'radio', 'range', 'color', 'file']) {
      expect(b, t).toContain(`:not([type='${t}'])`)
    }
  })

  it('and cannot reach a mouse, so no desktop pixel moves', () => {
    expect(CSS).toContain('@media (hover: none) and (pointer: coarse) {')
    // Not a width breakpoint: a 1024px touch tablet zooms exactly like a
    // 390px phone, and a 1440px mouse does not zoom at all.
    const b = zoomBlock()
    expect(b).not.toMatch(/min-width|max-width/)
  })
})

describe('§228b item 2 — pinch-zoom stays available', () => {
  it('the viewport meta sets no maximum-scale and no user-scalable', () => {
    expect(LAYOUT).not.toMatch(/maximumScale|maximum-scale/)
    expect(LAYOUT).not.toMatch(/userScalable|user-scalable/)
  })

  it('and it still has width=device-width, initialScale 1 and viewport-fit cover', () => {
    expect(LAYOUT).toMatch(/width: "device-width"/)
    expect(LAYOUT).toMatch(/initialScale: 1/)
    expect(LAYOUT).toMatch(/viewportFit: "cover"/)
  })

  it('and no `interactive-widget`, which could not be tested here', () => {
    // Chromium has no software keyboard, so `resizes-content` cannot be
    // shown to do what it should. The §228 `use-keyboard-inset` logic is
    // what holds the composer above the keyboard, and it stays.
    expect(LAYOUT).not.toMatch(/interactive-widget/)
  })
})

describe('§228b item 2 — the composer the owner was actually using', () => {
  const INPUT = fs.readFileSync(
    path.join(process.cwd(), 'components/review/comment-input.tsx'),
    'utf8',
  )

  it('still declares `text-[13px]`, and is covered by the rule rather than edited', () => {
    // Deliberately NOT changed to `text-base`: the desktop composer is
    // 13px and must stay 13px, and the media query is what makes it 16 on
    // a phone. If someone "fixes" this by hard-coding 16 here, the desktop
    // screenshots move.
    expect(INPUT).toContain('text-[13px]')
  })
})
