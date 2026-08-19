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
        const bigger = SIZES[j]
        const smaller = SIZES[j - 1]
        expect(ladders[smaller][i]).toBeGreaterThanOrEqual(ladders[bigger][i])
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
