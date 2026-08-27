/**
 * The asset grid sizes off its container, not the viewport (CLAUDE.md §50).
 *
 * The bug: column count came from viewport media queries while available
 * width came from a flex sibling, so opening the 360px Comments/Fields panel
 * kept the column count and shrank every card to fit.
 *
 * These read the CSS and the JSX rather than measuring layout — jsdom
 * implements neither container queries nor flexbox sizing, so a rendering
 * test here would assert nothing. Stated plainly rather than dressed up.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const GRID = fs.readFileSync(
  path.join(process.cwd(), 'components/projects/asset-grid.tsx'),
  'utf8',
)
const PAGE = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/[id]/page.tsx'),
  'utf8',
)

describe('the container', () => {
  it('is established on the element whose width the panel changes', () => {
    // The flex child, not the grid itself — a container on the grid would
    // query its own already-shrunk width and change nothing.
    expect(PAGE).toMatch(/asset-grid-container flex-1 flex flex-col min-w-0/)
    expect(CSS).toMatch(/\.asset-grid-container \{[^}]*container-type: inline-size/)
  })

  it('names the container, so nothing else accidentally answers the query', () => {
    expect(CSS).toMatch(/container-name: assetgrid/)
    expect(CSS).toMatch(/@container assetgrid \(min-width: \d+px\)/)
  })
})

describe('the grid', () => {
  it('no longer keys columns off viewport breakpoints', () => {
    // sm:/lg:/xl: grid-cols were the bug; they must not come back.
    expect(GRID).not.toMatch(/sm:grid-cols-/)
    expect(GRID).not.toMatch(/lg:grid-cols-/)
    expect(GRID).not.toMatch(/xl:grid-cols-/)
    expect(GRID).not.toMatch(/gridColsMap/)
  })

  it('carries the size as data-size at every mount point', () => {
    const mounts = GRID.match(/data-size=\{cardSize\}/g) ?? []
    // Three grids render in this file; all three must be converted, or one
    // of them silently keeps the old behaviour.
    expect(mounts).toHaveLength(3)
    expect(GRID.match(/className=\{cn\(gridClass/g) ?? []).toHaveLength(3)
  })

  it('has a column rule for all four sizes at every breakpoint', () => {
    const breakpoints = CSS.split('@container assetgrid').slice(1)
    expect(breakpoints).toHaveLength(3)
    for (const size of ['XS', 'S', 'M', 'L']) {
      expect(CSS).toMatch(new RegExp(`\\.asset-grid\\[data-size='${size}'\\]`))
      for (const block of breakpoints) {
        expect(block).toContain(`data-size='${size}'`)
      }
    }
  })

  it('never drops below one column, so a card cannot be squeezed to nothing', () => {
    const counts = Array.from(CSS.matchAll(/\.asset-grid\[data-size='[^']+'\][^;]*repeat\((\d+)/g))
      .map((m) => Number(m[1]))
    expect(counts.length).toBeGreaterThan(0)
    // Was `toBe(1)`, which asserted the tightest bound in the file rather
    // than the invariant it is named for. §67 doubled L's base from 1 to 2,
    // so no rule uses a single column any more — worth knowing, since it
    // means the narrowest container now always shows two cards side by
    // side, but it does not violate "never below one".
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1)
  })

  it('adds no new dependency to do it', () => {
    const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    // Plain CSS on purpose: a dependency change to apps/web is what left the
    // production image unbuildable for eleven days (§13c).
    expect(pkg).not.toMatch(/container-queries/)
  })
})
