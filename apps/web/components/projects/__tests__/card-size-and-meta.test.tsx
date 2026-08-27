/**
 * XS card size, the independent overview size, and the metadata-row
 * overflow (CLAUDE.md §51).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { useViewStore } from '@/stores/view-store'
import { useProjectViewStore } from '@/stores/project-view-store'
import { AssetCard } from '../asset-card'
import type { Asset } from '@/types'

// The column counts moved from asset-grid.tsx into container queries in
// globals.css (§50). Same numbers, new home.
const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const POPOVER = fs.readFileSync(
  path.join(process.cwd(), 'components/projects/appearance-popover.tsx'),
  'utf8',
)
const OVERVIEW = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/page.tsx'),
  'utf8',
)

function asset(): Asset {
  return {
    id: 'a1',
    project_id: 'p1',
    name: 'Clip',
    status: 'in_review',
    asset_type: 'video',
    created_at: '2026-08-01T00:00:00Z',
    folder_id: null,
  } as unknown as Asset
}

beforeEach(() => {
  window.localStorage.clear()
  useViewStore.setState({ cardSize: 'M', showUploader: true, showFileSize: true })
  useProjectViewStore.setState({ projectCardSize: 'S' })
})

describe('XS', () => {
  /**
   * §67 INVERTED THIS. It doubled S/M/L and deliberately left XS alone, so
   * in the asset grid XS (4/5/7/9) is now LESS dense than S (6/8/10/12) at
   * every breakpoint — the "extra small" card is the larger one there.
   *
   * Kept and inverted rather than deleted, because the relationship is
   * still worth pinning: if XS is ever re-tuned to lead S again, that is a
   * decision someone should make on purpose rather than discover.
   */
  it('is LESS dense than S at every breakpoint since §67 left it untouched', () => {
    // One entry per breakpoint, in source order (base, 640, 1024, 1280).
    const cols = (size: string) =>
      Array.from(
        CSS.matchAll(
          new RegExp(`\\.asset-grid\\[data-size='${size}'\\][^;]*repeat\\((\\d+)`, 'g'),
        ),
      ).map((m) => Number(m[1]))

    const xs = cols('XS')
    const s = cols('S')
    expect(xs.length).toBeGreaterThan(1)
    expect(xs).toHaveLength(s.length)
    xs.forEach((n, i) => expect(n).toBeLessThan(s[i]))
  })

  it('is offered first, smallest to largest, in the in-project control', () => {
    // The Card Size control specifically — this file has several Segments.
    const block = POPOVER.slice(POPOVER.indexOf('Card Size'))
    const options = /options=\{\[([\s\S]*?)\]\}/.exec(block)![1]
    const order = Array.from(options.matchAll(/value: '(XS|S|M|L)'/g)).map((m) => m[1])
    expect(order).toEqual(['XS', 'S', 'M', 'L'])
  })

  it('is offered in the same order on the overview', () => {
    expect(OVERVIEW).toMatch(/\["XS", "S", "M", "L"\] as CardSize\[\]/)
  })
})

describe('the overview size is independent', () => {
  it('uses its own store and its own storage key', () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), 'stores/project-view-store.ts'),
      'utf8',
    )
    expect(store).toMatch(/name: 'freeframe-project-view-settings'/)
    // Never reads or writes the in-project one.
    expect(store).not.toMatch(/freeframe-view-settings/)
    expect(OVERVIEW).toMatch(/useProjectViewStore\(\)/)
    expect(OVERVIEW).not.toMatch(/setCardSize/)
  })

  it('does not move when the in-project size changes', () => {
    useViewStore.getState().setCardSize('L')
    expect(useProjectViewStore.getState().projectCardSize).toBe('S')

    useProjectViewStore.getState().setProjectCardSize('XS')
    expect(useViewStore.getState().cardSize).toBe('L')
  })

  it('has its own column map rather than borrowing the asset grid’s', () => {
    expect(OVERVIEW).toMatch(/const projectGridColsMap: Record<CardSize, string>/)
  })
})

describe('the metadata row', () => {
  it('shows the file size even when the uploader name is very long', () => {
    render(
      <AssetCard
        projectId="p1"
        asset={asset()}
        authorName={'Bartholomew Featherstonehaugh-Cholmondeley'.repeat(2)}
        fileSize={5 * 1024 * 1024}
      />,
    )
    // The whole line used to be clamped, so a long name ate the size.
    expect(screen.getByText('5 MB')).toBeInTheDocument()
  })

  it('truncates only the name, leaving date and size outside the ellipsis', () => {
    const { container } = render(
      <AssetCard projectId="p1" asset={asset()} authorName={'x'.repeat(80)} fileSize={1024 * 1024} />,
    )
    const row = screen.getByText('1 MB').parentElement!
    // A clamp on the row itself is what caused the bug.
    expect(row.className).not.toContain('line-clamp')
    const truncating = Array.from(row.querySelectorAll('span')).filter((el) =>
      el.className.includes('truncate'),
    )
    expect(truncating).toHaveLength(1)
    expect(truncating[0].textContent).toHaveLength(80)
    expect(screen.getByText('1 MB').className).toContain('shrink-0')
  })

  it('still renders without an uploader name', () => {
    render(<AssetCard projectId="p1" asset={asset()} fileSize={2048} />)
    expect(screen.getByText('2 KB')).toBeInTheDocument()
  })
})
