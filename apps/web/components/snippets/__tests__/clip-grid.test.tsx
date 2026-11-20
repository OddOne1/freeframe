/**
 * The clips grid opens a card in place: it spans the row it was already in,
 * its row-mate moves to the row below, nothing from a later row moves up,
 * and closing it puts every card back. The column count comes from the
 * grid's computed layout (jsdom has none, so it is stubbed here).
 */
import * as React from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIP_GRID_CLASS, ClipGrid, countGridColumns, expandedRowOrder } from '../clip-grid'

const KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']

/**
 * Where CSS grid's plain (not dense) row flow puts each card: cards fill
 * the row left to right, and a full-width card starts a row of its own.
 */
function placeRows(order: string[], expandedKey: string | null, columns: number) {
  const at = new Map<string, { row: number; col: number }>()
  let row = 0
  let col = 0
  for (const key of order) {
    if (key === expandedKey && columns > 1) {
      if (col !== 0) {
        row++
        col = 0
      }
      at.set(key, { row, col: 0 })
      row++
      continue
    }
    at.set(key, { row, col })
    col++
    if (col === columns) {
      row++
      col = 0
    }
  }
  return at
}

describe('expandedRowOrder', () => {
  const before = placeRows(KEYS, null, 2)
  const order = expandedRowOrder(KEYS, KEYS.indexOf('c3'), 2)
  const after = placeRows(order, 'c3', 2)

  it('keeps a card from the right column in the row it was in', () => {
    expect(before.get('c3')).toEqual({ row: 1, col: 1 })
    expect(after.get('c3')).toEqual({ row: 1, col: 0 })
  })

  it('moves its row-mate to the row directly below, in the left column', () => {
    expect(before.get('c2')).toEqual({ row: 1, col: 0 })
    expect(after.get('c2')).toEqual({ row: 2, col: 0 })
    // and the next card fills in beside it
    expect(after.get('c4')).toEqual({ row: 2, col: 1 })
  })

  it('leaves the other cards in their original order and never moves one up', () => {
    expect(order.filter((k) => k !== 'c3')).toEqual(KEYS.filter((k) => k !== 'c3'))
    for (const key of KEYS) {
      if (key === 'c3') continue
      expect(after.get(key)!.row).toBeGreaterThanOrEqual(before.get(key)!.row)
    }
    // Rows above the opened card are untouched.
    expect(after.get('c0')).toEqual(before.get('c0'))
    expect(after.get('c1')).toEqual(before.get('c1'))
  })

  it('changes nothing for a card in the left column, a single column, or nothing open', () => {
    expect(expandedRowOrder(KEYS, KEYS.indexOf('c2'), 2)).toEqual(KEYS)
    expect(expandedRowOrder(KEYS, KEYS.indexOf('c3'), 1)).toEqual(KEYS)
    expect(expandedRowOrder(KEYS, -1, 2)).toEqual(KEYS)
  })

  it('works for more columns too', () => {
    const order3 = expandedRowOrder(KEYS, KEYS.indexOf('c5'), 3)
    expect(order3).toEqual(['c0', 'c1', 'c2', 'c5', 'c3', 'c4', 'c6'])
    expect(placeRows(order3, 'c5', 3).get('c5')!.row).toBe(placeRows(KEYS, null, 3).get('c5')!.row)
  })
})

describe('countGridColumns', () => {
  it('counts resolved tracks, repeat() and nothing', () => {
    expect(countGridColumns('512px 512px')).toBe(2)
    expect(countGridColumns('1024px')).toBe(1)
    expect(countGridColumns('[a] 100px [b] 200px [c]')).toBe(2)
    expect(countGridColumns('repeat(2, minmax(0, 1fr))')).toBe(2)
    expect(countGridColumns('minmax(0, 1fr) minmax(0, 1fr) 40px')).toBe(3)
    // What auto-fill resolves to in a browser: one track per column that fits.
    expect(countGridColumns('496px 496px 496px')).toBe(3)
    expect(countGridColumns('601.5px 601.5px 601.5px 601.5px')).toBe(4)
    expect(countGridColumns('none')).toBe(1)
    expect(countGridColumns('')).toBe(1)
  })
})

describe('ClipGrid', () => {
  let template = '400px 400px'
  const observers: Array<() => void> = []

  beforeEach(() => {
    template = '400px 400px'
    observers.length = 0
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) =>
      el.hasAttribute('data-clip-grid') ? ({ gridTemplateColumns: template } as CSSStyleDeclaration) : real(el, pseudo),
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {
          observers.push(() => this.cb())
        }
        observe() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function Harness() {
    const [open, setOpen] = React.useState<string | null>(null)
    return (
      <ClipGrid items={KEYS} keyOf={(k) => k} expandedKey={open}>
        {(k) => (
          <article data-clip-key={k} className={open === k ? 'col-span-full' : undefined}>
            <button type="button" onClick={() => setOpen((cur) => (cur === k ? null : k))}>
              toggle {k}
            </button>
          </article>
        )}
      </ClipGrid>
    )
  }

  const domOrder = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-clip-key]')).map((el) => el.dataset.clipKey)

  it('renders the opened right-column card first in its row, then its row-mate, then the rest', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(domOrder()).toEqual(KEYS)

    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    expect(domOrder()).toEqual(['c0', 'c1', 'c3', 'c2', 'c4', 'c5', 'c6'])
  })

  it('puts the original order back when the card closes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    expect(domOrder()).toEqual(KEYS)
  })

  it('keeps the original order in a single-column layout', async () => {
    template = '800px'
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    expect(domOrder()).toEqual(KEYS)
  })

  it('follows the grid when its column count changes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    expect(domOrder()).toEqual(['c0', 'c1', 'c3', 'c2', 'c4', 'c5', 'c6'])

    template = '800px'
    act(() => observers.forEach((fire) => fire()))
    expect(domOrder()).toEqual(KEYS)

    template = '400px 400px'
    act(() => observers.forEach((fire) => fire()))
    expect(domOrder()).toEqual(['c0', 'c1', 'c3', 'c2', 'c4', 'c5', 'c6'])

    // A wider window: three columns, c3 is now the first of its row.
    template = '400px 400px 400px'
    act(() => observers.forEach((fire) => fire()))
    expect(domOrder()).toEqual(KEYS)

    // Four: c3 ends the first row, so it moves to that row's start.
    template = '400px 400px 400px 400px'
    act(() => observers.forEach((fire) => fire()))
    expect(domOrder()).toEqual(['c3', 'c0', 'c1', 'c2', 'c4', 'c5', 'c6'])
  })

  it('uses an auto-fill grid with a 31rem column minimum by default (45rem at the Large grid size)', () => {
    render(<Harness />)
    const grid = document.querySelector('[data-clip-grid]')!
    expect(grid.className).toBe(CLIP_GRID_CLASS)
    expect(CLIP_GRID_CLASS).toContain(
      'grid-cols-[repeat(auto-fill,minmax(min(100%,calc(31rem*var(--clip-scale,1)_-_3rem*(var(--clip-scale,1)_-_1))),1fr))]',
    )
    // No fixed column count left over from the old two-column grid.
    expect(CLIP_GRID_CLASS).not.toMatch(/grid-cols-\d|lg:grid-cols/)
  })

  describe('with three columns', () => {
    beforeEach(() => {
      template = '496px 496px 496px'
    })

    // c0 c1 c2 / c3 c4 c5 / c6
    it('keeps an opened right-hand card in its row, with its row-mates below it in order', async () => {
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'toggle c5' }))
      const order = domOrder() as string[]
      expect(order).toEqual(['c0', 'c1', 'c2', 'c5', 'c3', 'c4', 'c6'])

      const before = placeRows(KEYS, null, 3)
      const after = placeRows(order, 'c5', 3)
      // Same row as before, now at its start (and spanning it).
      expect(after.get('c5')).toEqual({ row: before.get('c5')!.row, col: 0 })
      // Its two row-mates: the row directly below, left to right, in order.
      expect(after.get('c3')).toEqual({ row: 2, col: 0 })
      expect(after.get('c4')).toEqual({ row: 2, col: 1 })
      // Then the rest, and nothing moved up.
      expect(after.get('c6')).toEqual({ row: 2, col: 2 })
      for (const key of KEYS) expect(after.get(key)!.row).toBeGreaterThanOrEqual(before.get(key)!.row)
      expect(after.get('c0')).toEqual(before.get('c0'))
    })

    it('does the same for a card in the middle column', async () => {
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'toggle c4' }))
      expect(domOrder()).toEqual(['c0', 'c1', 'c2', 'c4', 'c3', 'c5', 'c6'])
    })

    it('changes nothing for a card already first in its row', async () => {
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'toggle c3' }))
      expect(domOrder()).toEqual(KEYS)
    })

    it('puts the original order back when the card closes', async () => {
      const user = userEvent.setup()
      render(<Harness />)
      await user.click(screen.getByRole('button', { name: 'toggle c5' }))
      await user.click(screen.getByRole('button', { name: 'toggle c5' }))
      expect(domOrder()).toEqual(KEYS)
    })
  })

  it('with four columns, opens a card from the end of the first row at its start', async () => {
    template = '496px 496px 496px 496px'
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'toggle c3' }))
    expect(domOrder()).toEqual(['c3', 'c0', 'c1', 'c2', 'c4', 'c5', 'c6'])
    // Switching to c6, third in the second row.
    await user.click(screen.getByRole('button', { name: 'toggle c6' }))
    expect(domOrder()).toEqual(['c0', 'c1', 'c2', 'c3', 'c6', 'c4', 'c5'])
    await user.click(screen.getByRole('button', { name: 'toggle c6' }))
    expect(domOrder()).toEqual(KEYS)
  })
})
