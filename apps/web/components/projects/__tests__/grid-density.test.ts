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
 * §67's first cut (1b7f16e) doubled S/M/L while leaving XS alone, which
 * inverted the asset grid's ladder — S ended up denser than XS, so the
 * "extra small" card was the larger one. The §67 correction restored strict
 * XS > S > M > L at every breakpoint, so the ordering invariant below
 * applies to ALL FOUR sizes again, XS included.
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

  it('never puts a larger card in more columns than a smaller one', () => {
    const ladders = read()
    const steps = ladders.XS.length
    for (let i = 0; i < steps; i++) {
      for (let j = 1; j < SIZES.length; j++) {
        expect(ladders[SIZES[j - 1]][i]).toBeGreaterThanOrEqual(ladders[SIZES[j]][i])
      }
    }
  })

  it('and in the asset grid the decrease is STRICT, which was the whole correction', () => {
    const ladders = read()
    // Separate from the >= check above because the overview legitimately
    // ties (M and L both start at 2 columns at base). Only the asset grid
    // was inverted, and only it has to step strictly down.
    if (ladders.XS.join() !== [4, 5, 7, 9].join()) return
    const steps = ladders.XS.length
    for (let i = 0; i < steps; i++) {
      for (let j = 1; j < SIZES.length; j++) {
        expect(ladders[SIZES[j - 1]][i]).toBeGreaterThan(ladders[SIZES[j]][i])
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
  it('asset grid matches the CORRECTED table, with XS untouched', () => {
    // XS's own density is a hard ceiling on S: at base and 640 it is
    // already 4 and 5, leaving S no room to go denser than its original
    // 3 and 4 without catching XS. So the halving only lands at 1024/1280.
    expect(assetGridLadders()).toEqual({
      XS: [4, 5, 7, 9],
      S: [3, 4, 6, 8],
      M: [2, 3, 5, 7],
      L: [1, 2, 4, 6],
    })
  })

  it('projects overview follows §68\'s 1/3 growth curve, with XS untouched', () => {
    expect(overviewLadders()).toEqual({
      XS: [3, 5, 7, 9],
      S: [2, 4, 5, 7],
      M: [2, 3, 4, 5],
      L: [2, 2, 3, 4],
    })
  })

  it('and the overview steps strictly down everywhere EXCEPT base, where it cannot', () => {
    const o = overviewLadders()
    // XS is 3 columns at base, so four strictly-decreasing counts would
    // need 3 > 2 > 1 > 0. S/M/L all sit at 2 there — which is also what the
    // width curve wants — and step strictly down at every other breakpoint.
    expect([o.XS[0], o.S[0], o.M[0], o.L[0]]).toEqual([3, 2, 2, 2])
    for (let i = 1; i < o.XS.length; i++) {
      for (let j = 1; j < SIZES.length; j++) {
        expect(o[SIZES[j - 1]][i]).toBeGreaterThan(o[SIZES[j]][i])
      }
    }
  })

  it('and XS leads S everywhere again — 1b7f16e\'s inversion is gone', () => {
    const a = assetGridLadders()
    expect(a.XS.every((n, i) => n > a.S[i])).toBe(true)
  })
})
