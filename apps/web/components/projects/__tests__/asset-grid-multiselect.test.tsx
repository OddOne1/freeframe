/**
 * Shift-range and select-all in the asset grid (CLAUDE.md §99).
 *
 * Rendered for real. Every rule here is about what a click MEANS given
 * modifier keys and what is currently selected, and none of that is
 * visible from calling a handler — the whole bug was that the card body's
 * click went somewhere else entirely and never looked at `e.shiftKey`.
 *
 * The selection count is read off the bulk-action bar, because that is the
 * thing the user actually sees and the thing bulk delete/move/share act on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Asset, Folder } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { AssetGrid } from '../asset-grid'
import { useViewStore } from '@/stores/view-store'

function asset(id: string, name: string): Asset {
  return {
    id,
    project_id: 'p-1',
    name,
    status: 'in_review',
    asset_type: 'video',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    folder_id: null,
  } as unknown as Asset
}

// Named so the default sort (name) leaves them in this order — a range
// test that did not control the order would be asserting against whatever
// the sort happened to do.
const ASSETS = [
  asset('a-1', 'A One'), asset('a-2', 'B Two'), asset('a-3', 'C Three'),
  asset('a-4', 'D Four'), asset('a-5', 'E Five'),
]

const FOLDERS = [
  { id: 'f-1', name: 'Folder One', project_id: 'p-1' } as unknown as Folder,
]

function setup(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onAssetSelect: vi.fn(),
    onBulkDelete: vi.fn(),
    onBulkDownload: vi.fn(),
    onBulkMove: vi.fn(),
    onCreateShareLink: vi.fn(),
    ...overrides,
  }
  const utils = render(
    <AssetGrid assets={ASSETS} projectId="p-1" projectName="Proj" {...handlers} />,
  )
  return { ...utils, handlers }
}

function cardFor(id: string) {
  const el = document.querySelector(`[data-asset-card="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el as HTMLElement
}

/** What the bulk bar says, or null when nothing is selected and it is not
 *  rendered at all. */
function selectedCount(): number | null {
  const el = screen.queryByText(/\d+ Items? selected/)
  if (!el) return null
  return Number((el.textContent || '').match(/(\d+)/)?.[1])
}

beforeEach(() => {
  vi.clearAllMocks()
  useViewStore.setState({ layout: 'grid', flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
})

describe('plain click is unchanged', () => {
  it('still opens the side panel and selects nothing', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(cardFor('a-2'))
    expect(handlers.onAssetSelect).toHaveBeenCalledTimes(1)
    // The bar is absent, not empty: nothing was added to the bulk set.
    expect(selectedCount()).toBeNull()
  })
})

describe('shift-click range', () => {
  it('selects everything between the anchor and the clicked card', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(cardFor('a-2'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)     // a-2, a-3, a-4
    // The range must NOT also open the detail panel — one gesture, one
    // meaning.
    expect(handlers.onAssetSelect).toHaveBeenCalledTimes(1)
  })

  it('works upwards as well as downwards', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(cardFor('a-4'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)
  })

  it('is ADDITIVE — an earlier selection outside the range survives', async () => {
    const user = userEvent.setup()
    setup()
    // Pick one at the far end via cmd-click, then range-select elsewhere.
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-5'))
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    await user.click(cardFor('a-1'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Shift}')
    // a-5 kept, plus a-1..a-2. Finder's rule: a range adds, it does not
    // replace.
    expect(selectedCount()).toBe(3)
  })

  it('with no anchor yet, behaves as a plain single select rather than doing nothing', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-3'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(1)
  })

  it('re-anchors on a cmd-click, so the next range starts from there', async () => {
    const user = userEvent.setup()
    setup()
    // Two shift-clicks in a row cannot show this: ranges are additive, so
    // the union is the same size whether or not the anchor moved. A
    // cmd-click in between is what separates them — it moves the anchor
    // without selecting a range.
    await user.click(cardFor('a-1'))          // anchor a-1
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-4'))          // anchor a-4, selects a-4
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-5'))
    await user.keyboard('{/Shift}')
    // Anchored at a-4: a-4..a-5, so two. Had the anchor stayed at a-1 this
    // would be a-1..a-5, all five.
    expect(selectedCount()).toBe(2)
  })
})

describe('the range follows the RENDERED order, not the array order', () => {
  it('a range under a different sort selects what is visually between', async () => {
    const user = userEvent.setup()
    // Dates chosen so the rendered order interleaves rather than reverses:
    // reversing an array preserves contiguity, so a desc sort could not
    // tell `filtered` and `assets` apart. Sorted by date asc this renders
    // a-3, a-1, a-5, a-2, a-4.
    const dated = [
      asset('a-1', 'A One'), asset('a-2', 'B Two'), asset('a-3', 'C Three'),
      asset('a-4', 'D Four'), asset('a-5', 'E Five'),
    ]
    const at = (i: number) => new Date(2020, 0, i).toISOString()
    ;(dated[2] as { updated_at: string }).updated_at = at(1)
    ;(dated[0] as { updated_at: string }).updated_at = at(2)
    ;(dated[4] as { updated_at: string }).updated_at = at(3)
    ;(dated[1] as { updated_at: string }).updated_at = at(4)
    ;(dated[3] as { updated_at: string }).updated_at = at(5)
    useViewStore.setState({ layout: 'grid', flattenFolders: false, sortKey: 'date', sortDirection: 'asc' })

    render(<AssetGrid assets={dated} projectId="p-1" projectName="Proj" onBulkDelete={vi.fn()} />)
    await user.click(cardFor('a-1'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-5'))
    await user.keyboard('{/Shift}')
    // Adjacent on screen, so two. Computed over the raw `assets` prop they
    // are four apart and this would select all five.
    expect(selectedCount()).toBe(2)
  })
})

describe('cmd/ctrl click', () => {
  it('toggles one asset without opening the panel', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetSelect).not.toHaveBeenCalled()
  })

  it('adds without clearing what is already selected, and toggles back off', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-1'))
    await user.click(cardFor('a-3'))
    expect(selectedCount()).toBe(2)
    await user.click(cardFor('a-1'))
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
  })

  it('ctrl works too, for non-Mac', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Control>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Control}')
    expect(selectedCount()).toBe(1)
  })
})

describe('select all', () => {
  it('Cmd+A selects every visible asset', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Meta>}a{/Meta}')
    expect(selectedCount()).toBe(ASSETS.length)
  })

  it('Ctrl+A does too', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Control>}a{/Control}')
    expect(selectedCount()).toBe(ASSETS.length)
  })

  it('does NOT hijack select-all inside a text field', async () => {
    const user = userEvent.setup()
    setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await user.keyboard('{Meta>}a{/Meta}')
    expect(selectedCount()).toBeNull()
    input.remove()
  })

  it('includes folders when they are on screen', async () => {
    const user = userEvent.setup()
    render(
      <AssetGrid assets={ASSETS} folders={FOLDERS} projectId="p-1" projectName="Proj"
        onBulkDelete={vi.fn()} />,
    )
    await user.keyboard('{Meta>}a{/Meta}')
    expect(selectedCount()).toBe(ASSETS.length + FOLDERS.length)
  })

  it('…but not when Flatten Folders has hidden them', async () => {
    const user = userEvent.setup()
    useViewStore.setState({ layout: 'grid', flattenFolders: true, sortKey: 'name', sortDirection: 'asc' })
    render(
      <AssetGrid assets={ASSETS} folders={FOLDERS} projectId="p-1" projectName="Proj"
        onBulkDelete={vi.fn()} />,
    )
    await user.keyboard('{Meta>}a{/Meta}')
    expect(selectedCount()).toBe(ASSETS.length)
  })

  it('the bulk bar button selects all too', async () => {
    const user = userEvent.setup()
    setup()
    // The bar only exists once something is selected — see the build
    // report; the shortcut is the zero-state path.
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-1'))
    await user.keyboard('{/Meta}')
    await user.click(screen.getByRole('button', { name: /select all/i }))
    expect(selectedCount()).toBe(ASSETS.length)
  })
})

describe('bulk actions act on exactly what was selected', () => {
  it('delete receives the range, nothing more', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(cardFor('a-2'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Shift}')
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    const [assetIds] = (handlers.onBulkDelete as ReturnType<typeof vi.fn>).mock.calls[0]
    expect([...assetIds].sort()).toEqual(['a-2', 'a-3', 'a-4'])
  })
})
