/**
 * The project toolbar at narrow column widths (§224b).
 *
 * The bug the owner photographed: at 1280px with the right panel open the
 * main column is 580px, and the toolbar put "Sorted by" on two lines,
 * wrapped "New Folder" and pushed Upload 87px past the right edge where
 * it could not be clicked at all.
 *
 * What can honestly be asserted here and what cannot: jsdom has no layout
 * engine and does not evaluate container queries, so none of these tests
 * can observe a button being clipped. Two kinds of assertion stand in for
 * it, and both are about the thing that would actually break:
 *
 *   - the markup contracts the CSS hangs off (the hook classes, the
 *     label spans, the accessible names that survive the label going),
 *     exercised through a real render;
 *   - the rules themselves, read out of globals.css, because a rule that
 *     is not in the stylesheet cannot fire in a browser either.
 *
 * The widths themselves were measured in Chromium against the real build
 * and are recorded in the commit; a pixel diff, not a unit test, is what
 * proves "the four combinations that fit today are unchanged".
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

import { SortPopover } from '../sort-popover'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const GRID = fs.readFileSync(
  path.join(process.cwd(), 'components/projects/asset-grid.tsx'),
  'utf8',
)
const PAGE = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/[id]/page.tsx'),
  'utf8',
)

/** The `@container assetgrid (max-width: N)` block, as written. */
function band(maxWidth: number): string {
  const head = `@container assetgrid (max-width: ${maxWidth}px) {`
  const at = CSS.indexOf(head)
  if (at === -1) return ''
  // Balanced-brace scan: these blocks nest an @media inside them, so a
  // scan to the first `}` would stop three lines in.
  let depth = 0
  for (let i = at + head.length - 1; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(at, i + 1)
  }
  return ''
}

describe('step 1 — "Sorted by Date" is one line', () => {
  it('the trigger refuses to wrap', () => {
    render(<SortPopover />)
    const trigger = screen.getByRole('button', { name: /sorted by/i })
    expect(trigger.className).toMatch(/\bwhitespace-nowrap\b/)
  })

  it('and refuses to be squeezed below its content width', () => {
    // Without shrink-0 a flex parent squeezes it instead of wrapping, and
    // the text is pushed out of the button rather than onto a second line
    // — the same symptom by a different route.
    render(<SortPopover />)
    expect(screen.getByRole('button', { name: /sorted by/i }).className).toMatch(/\bshrink-0\b/)
  })

  it('keeps the label and its value in one button, so they cannot separate', () => {
    render(<SortPopover />)
    const trigger = screen.getByRole('button', { name: /sorted by/i })
    expect(trigger.textContent).toMatch(/Sorted by\s*\w+/)
  })
})

describe('step 2 — Appearance stacks above Sort', () => {
  it('has a rule that turns the left group into a column', () => {
    const b = band(739)
    expect(b).not.toBe('')
    expect(b).toMatch(/\.toolbar-crowded \.toolbar-left \{[^}]*display: flex/)
    expect(b).toMatch(/\.toolbar-crowded \.toolbar-left \{[^}]*flex-direction: column/)
  })

  it('drops the vertical divider, which separates nothing once stacked', () => {
    expect(band(739)).toMatch(/\.toolbar-crowded \.toolbar-divider \{ display: none/)
  })

  it('the markup gives that rule something to act on', () => {
    // `md:contents` alone has no box to turn into a column; the hook class
    // is what lets the narrow case materialise one without changing the
    // wide case, where the wrapper still dissolves.
    expect(GRID).toMatch(/className="toolbar-left hidden md:contents"/)
    expect(GRID).toMatch(/className="toolbar-divider /)
  })

  it('starts at 740px, which is where the one-row layout still fits', () => {
    // Measured: a fully labelled row needs 694px of content box, and
    // 1440 with the panel open gives exactly 740px of container. That
    // combination must stay on one row, so the band may not reach it.
    expect(CSS).toContain('@container assetgrid (max-width: 739px)')
  })
})

describe('step 3 — Share and New Folder drop to icons', () => {
  it('has a rule that hides the labels', () => {
    expect(band(619)).toMatch(/\.toolbar-crowded \.toolbar-label \{ display: none/)
  })

  it('only the label is in the span, so hiding it leaves the icon', () => {
    expect(PAGE).toMatch(/<span className="toolbar-label">Share<\/span>/)
    expect(PAGE).toMatch(/<span className="toolbar-label">New Folder<\/span>/)
  })

  it('both buttons keep a name and a tooltip once the text is gone', () => {
    // The whole accessible name of these two came from their text. With
    // the text display:none they would be unlabelled icons.
    for (const label of ['Share', 'New Folder']) {
      const re = new RegExp(`aria-label="${label}"[\\s\\S]{0,40}title="${label}"`)
      expect(PAGE).toMatch(re)
    }
  })

  it('Upload keeps its label at every width', () => {
    // The owner's rule: Upload must always be fully visible and
    // reachable. It is the one action never reduced to an icon.
    expect(PAGE).not.toMatch(/<span className="toolbar-label">Upload<\/span>/)
  })
})

describe('step 4 — the action group takes a row of its own', () => {
  it('the bar may wrap at all', () => {
    // Without flex-wrap the last-resort rule below cannot take effect,
    // and an over-full row goes back to pushing buttons out of view.
    expect(GRID).toMatch(/hidden md:flex items-center gap-1 flex-wrap border-b/)
  })

  it('and the narrowest band forces the break', () => {
    const b = band(489)
    expect(b).toMatch(/\.toolbar-crowded \.toolbar-actions \{[^}]*flex-basis: 100%/)
  })

  it('the group is addressable', () => {
    expect(GRID).toMatch(/className="toolbar-actions flex items-center gap-2"/)
  })
})

describe('the bands are ordered and scoped', () => {
  it('each step is strictly narrower than the one before', () => {
    const widths = Array.from(CSS.matchAll(/@container assetgrid \(max-width: (\d+)px\)/g)).map(
      (m) => Number(m[1]),
    )
    expect(widths).toEqual([739, 619, 489])
  })

  it('nothing fires without an action group to make room for', () => {
    // /assets renders the same bar with no actions; stacking Appearance
    // there would be making room for nothing.
    for (const w of [739, 619, 489]) {
      expect(band(w)).toMatch(/\.toolbar-crowded /)
    }
    expect(GRID).toMatch(/actions && 'toolbar-crowded'/)
  })

  it('and nothing fires below md, where the bar is not displayed', () => {
    // Without the inner @media, a narrow container below md would turn
    // `toolbar-left` from display:none into a visible column.
    for (const w of [739, 619, 489]) {
      expect(band(w)).toMatch(/@media \(min-width: 768px\)/)
    }
  })
})

describe('§224b item 3 — no empty band on a phone', () => {
  it('the bar itself is hidden below md', () => {
    // Every child of it is already hidden there, so what rendered was a
    // bordered row with nothing in it between the folder name and the
    // first section heading.
    expect(GRID).toMatch(/'hidden md:flex items-center/)
  })

  it('but it is still a flex row at md+', () => {
    expect(GRID).toMatch(/md:flex items-center gap-1/)
  })
})
