/**
 * The density ladders stay coherent (CLAUDE.md §55).
 *
 * Deliberately NOT asserting the specific column counts. Those are a
 * first-pass estimate and are expected to be re-tuned by eye; a test
 * hardcoding them would have to be edited every round and would catch
 * nothing but its own staleness. What must hold through any tuning is the
 * shape: a smaller size is never less dense than a larger one, density never
 * decreases as the container grows, and nothing ever reaches zero columns.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SIZES = ['XS', 'S', 'M', 'L'] as const

/** In-project: container queries in globals.css. */
function assetGridLadders(): Record<string, number[]> {
  const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
  const out: Record<string, number[]> = {}
  for (const size of SIZES) {
    out[size] = Array.from(
      css.matchAll(new RegExp(`\\.asset-grid\\[data-size='${size}'\\][^;]*repeat\\((\\d+)`, 'g')),
    ).map((m) => Number(m[1]))
  }
  return out
}

/** Overview: Tailwind classes in the projects page. */
function overviewLadders(): Record<string, number[]> {
  const page = fs.readFileSync(
    path.join(process.cwd(), 'app/(dashboard)/projects/page.tsx'),
    'utf8',
  )
  const map = /const projectGridColsMap: Record<CardSize, string> = \{([\s\S]*?)\n\}/.exec(page)![1]
  const out: Record<string, number[]> = {}
  for (const size of SIZES) {
    // Anchored: an unanchored "S:" also matches inside "XS:".
    const line = new RegExp(`\\b${size}:\\s*"([^"]+)"`).exec(map)![1]
    out[size] = (line.match(/grid-cols-(\d+)/g) ?? []).map((c) =>
      Number(c.replace('grid-cols-', '')),
    )
  }
  return out
}

/**
 * §67 doubled S/M/L in both grids and deliberately left XS alone. In the
 * OVERVIEW that keeps the ladder ordered (XS 3/5/7/9 still leads S 2/4/6/8).
 * In the ASSET GRID it does not: S is now denser than XS at every
 * breakpoint and M at most of them, so "XS" is no longer the smallest card
 * there. That inversion is a consequence of the instruction, not a mistake
 * in carrying it out — so the ordering invariant is asserted only where it
 * still holds, and the asset grid's exact table is pinned instead. Deleting
 * the check outright would have lost the one thing still worth catching:
 * that these numbers are the numbers that were asked for.
 */
describe.each([
  ['in-project asset grid', assetGridLadders],
  ['projects overview', overviewLadders],
])('%s', (_name, read) => {
  it('has the same number of breakpoints for every size', () => {
    const ladders = read()
    const lengths = SIZES.map((s) => ladders[s].length)
    expect(new Set(lengths).size).toBe(1)
    expect(lengths[0]).toBeGreaterThan(1)
  })

  it('never puts a larger card in more columns than a smaller one, from S down', () => {
    const ladders = read()
    const steps = ladders.XS.length
    // XS is excluded: §67 left it untouched while doubling everything else,
    // which puts it below S (and mostly below M) in the asset grid. Among
    // S/M/L the ordering still has to hold.
    const ordered = ['S', 'M', 'L'] as const
    for (let i = 0; i < steps; i++) {
      for (let j = 1; j < ordered.length; j++) {
        expect(ladders[ordered[j - 1]][i]).toBeGreaterThanOrEqual(ladders[ordered[j]][i])
      }
    }
  })

  it('never gets less dense as the container grows', () => {
    const ladders = read()
    for (const size of SIZES) {
      const ladder = ladders[size]
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]).toBeGreaterThanOrEqual(ladder[i - 1])
      }
    }
  })

  it('never reaches zero columns', () => {
    const ladders = read()
    for (const size of SIZES) {
      expect(Math.min(...ladders[size])).toBeGreaterThanOrEqual(1)
    }
  })
})

/**
 * The numbers themselves (§67).
 *
 * §55's header says these are deliberately not asserted, because they were
 * a first-pass estimate expected to be re-tuned by eye. §67 changed that:
 * it names an exact table, and the ordering invariant that used to protect
 * the asset grid no longer applies to it. Pinning the values is what is
 * left — without it, nothing at all would catch the asset grid drifting.
 */
describe('§67 target tables', () => {
  it('asset grid matches the doubled S/M/L, with XS untouched', () => {
    expect(assetGridLadders()).toEqual({
      XS: [4, 5, 7, 9],
      S: [6, 8, 10, 12],
      M: [4, 6, 8, 8],
      L: [2, 4, 4, 6],
    })
  })

  it('projects overview matches the doubled S/M/L, with XS untouched', () => {
    expect(overviewLadders()).toEqual({
      XS: [3, 5, 7, 9],
      S: [2, 4, 6, 8],
      M: [2, 4, 4, 6],
      L: [2, 2, 2, 4],
    })
  })

  it('and the asset grid is now inverted at XS, which the ordering test excludes', () => {
    const a = assetGridLadders()
    // Stated as an assertion rather than a comment so it cannot quietly
    // stop being true without someone noticing.
    expect(a.S.every((n, i) => n > a.XS[i])).toBe(true)
  })
})
