/**
 * Sortable column headers (CLAUDE.md §40).
 *
 * The app had no clickable-header sort before this; the existing convention
 * was a dropdown of named keys. What is pinned here is the behaviour that
 * makes a header sort feel right rather than random: a new column starts
 * ascending, the same column reverses, and absent values stay at the bottom
 * in both directions.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlainTh, SortControl, SortableTh, sortRows, useSort, useSortState } from '../sortable'

interface Row {
  name: string
  size: number | null
}

const ROWS: Row[] = [
  { name: 'Beta', size: 33 },
  { name: 'alpha', size: null },
  { name: 'Gamma', size: 17 },
]

const ACCESSORS = {
  name: (r: Row) => r.name,
  size: (r: Row) => r.size,
}

function Table({ rows = ROWS }: { rows?: Row[] }) {
  const { sorted, sort } = useSort(rows, ACCESSORS, { key: 'name' })
  return (
    <table>
      <thead>
        <tr>
          <SortableTh label="Name" sortKey="name" sort={sort} />
          <SortableTh label="Size" sortKey="size" sort={sort} />
          <PlainTh label="Actions" align="right" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function order() {
  return screen.getAllByRole('cell').map((c) => c.textContent)
}

describe('sortRows', () => {
  it('compares strings case- and accent-insensitively, and numerically', () => {
    const rows = [{ name: 'Take 10', size: 1 }, { name: 'take 2', size: 2 }]
    const sorted = sortRows(rows, ACCESSORS, { key: 'name', direction: 'asc' })
    // "Take 10" would come first under a plain codepoint compare.
    expect(sorted.map((r) => r.name)).toEqual(['take 2', 'Take 10'])
  })

  it('keeps absent values last in BOTH directions', () => {
    const asc = sortRows(ROWS, ACCESSORS, { key: 'size', direction: 'asc' })
    const desc = sortRows(ROWS, ACCESSORS, { key: 'size', direction: 'desc' })
    // Reversing must not float every blank to the top: "no limit set" is not
    // the largest or the smallest value, it is absent.
    expect(asc.at(-1)!.name).toBe('alpha')
    expect(desc.at(-1)!.name).toBe('alpha')
    expect(asc.map((r) => r.size)).toEqual([17, 33, null])
    expect(desc.map((r) => r.size)).toEqual([33, 17, null])
  })

  it('does not mutate the array it was given', () => {
    const rows = [...ROWS]
    sortRows(rows, ACCESSORS, { key: 'size', direction: 'desc' })
    expect(rows).toEqual(ROWS)
  })
})

describe('SortableTh', () => {
  it('sorts by the clicked column, ascending first', async () => {
    render(<Table />)
    await userEvent.click(screen.getByRole('button', { name: /Size/ }))
    expect(order()).toEqual(['Gamma', 'Beta', 'alpha'])
  })

  it('reverses on a second click of the same column', async () => {
    render(<Table />)
    const size = screen.getByRole('button', { name: /Size/ })
    await userEvent.click(size)
    await userEvent.click(size)
    expect(order()).toEqual(['Beta', 'Gamma', 'alpha'])
  })

  it('starts a different column ascending rather than inheriting the direction', async () => {
    render(<Table />)
    const size = screen.getByRole('button', { name: /Size/ })
    await userEvent.click(size)
    await userEvent.click(size) // size is now DESCENDING
    expect(order()).toEqual(['Beta', 'Gamma', 'alpha'])

    await userEvent.click(screen.getByRole('button', { name: /Name/ }))
    // Ascending by name. Carrying "descending" over from the previous column
    // would give Gamma, Beta, alpha instead.
    expect(order()).toEqual(['alpha', 'Beta', 'Gamma'])
  })

  it('reports the active column through aria-sort, and only that one', async () => {
    render(<Table />)
    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((h) => h.getAttribute('aria-sort'))).toEqual([
      'ascending',
      'none',
      null, // the plain Actions header is not a sortable column at all
    ])

    await userEvent.click(screen.getByRole('button', { name: /Size/ }))
    expect(screen.getAllByRole('columnheader').map((h) => h.getAttribute('aria-sort'))).toEqual([
      'none',
      'ascending',
      null,
    ])
  })

  it('gives a non-sortable column no button to press', () => {
    render(<Table />)
    const actions = screen.getAllByRole('columnheader').at(-1)!
    expect(actions.querySelector('button')).toBeNull()
  })
})

describe('two tables on one page', () => {
  it('sort independently', async () => {
    render(
      <>
        <div data-testid="first">
          <Table />
        </div>
        <div data-testid="second">
          <Table />
        </div>
      </>,
    )
    const first = screen.getByTestId('first')
    const second = screen.getByTestId('second')

    await userEvent.click(within(first).getByRole('button', { name: /Size/ }))

    expect(Array.from(first.querySelectorAll('td')).map((c) => c.textContent)).toEqual([
      'Gamma', 'Beta', 'alpha',
    ])
    // Sorting one table must not resort the other.
    expect(Array.from(second.querySelectorAll('td')).map((c) => c.textContent)).toEqual([
      'alpha', 'Beta', 'Gamma',
    ])
  })
})

describe('SortControl', () => {
  it('drives the same state outside a table', async () => {
    function List() {
      const sort = useSortState<'name' | 'size'>('name')
      const sorted = sortRows(ROWS, ACCESSORS, sort)
      return (
        <>
          <SortControl
            label="LUTs"
            sort={sort}
            options={[
              { key: 'name', label: 'Name' },
              { key: 'size', label: 'Size' },
            ]}
          />
          <ul>
            {sorted.map((r) => (
              <li key={r.name}>{r.name}</li>
            ))}
          </ul>
        </>
      )
    }
    render(<List />)
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'alpha', 'Beta', 'Gamma',
    ])

    await userEvent.click(screen.getByRole('button', { name: /Size/ }))
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'Gamma', 'Beta', 'alpha',
    ])
    expect(screen.getByRole('button', { name: /Size/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Name/ })).toHaveAttribute('aria-pressed', 'false')
  })
})
