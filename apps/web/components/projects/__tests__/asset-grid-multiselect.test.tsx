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
    // §232 — `onAssetSelect` is gone; a plain click OPENS now, so the
    // handler a selection must never reach is `onAssetOpen`.
    onAssetOpen: vi.fn(),
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

function checkboxFor(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^(Select|Deselect) ${name}$`) })
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

/**
 * §232 reversed the plain-click rule this file was written against.
 *
 * Before: a plain MOUSE click on a card selected it for the right panel
 * (`onAssetSelect`) and a double-click opened it. Now the first click
 * opens, so an anchor for a range has to be set the way a selection is
 * started — the checkbox, or a cmd-click. The range rules themselves are
 * unchanged, which is the point of keeping these tests rather than
 * rewriting them: shift and cmd mean exactly what §99/§101 said they mean.
 */
describe('a plain click OPENS and selects nothing (§232)', () => {
  it('opens the asset, and the bulk bar never appears', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(cardFor('a-2'))
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen.mock.calls[0][0].id).toBe('a-2')
    // The bar is absent, not empty: nothing was added to the bulk set.
    expect(selectedCount()).toBeNull()
  })

  it('…but a plain click TOGGLES once something is selected', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(checkboxFor('A One'))
    expect(selectedCount()).toBe(1)
    await user.click(cardFor('a-2'))
    expect(selectedCount()).toBe(2)
    await user.click(cardFor('a-2'))
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })
})

describe('shift-click range', () => {
  it('selects everything between the anchor and the clicked card', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    // §232 — a cmd-click sets the anchor, because a plain one now opens.
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)     // a-2, a-3, a-4
    // Neither the anchor nor the range may open anything — one gesture,
    // one meaning, and this is what makes single-click open safe.
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('works upwards as well as downwards', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('is ADDITIVE — an earlier selection outside the range survives', async () => {
    const user = userEvent.setup()
    setup()
    // Pick one at the far end via cmd-click, then range-select elsewhere.
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-5'))
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    // §232 — a selection is active, so this plain click toggles a-1 in and
    // moves the anchor to it rather than opening.
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
    await user.click(checkboxFor('A One'))    // anchor a-1, selects a-1
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-4'))          // anchor a-4, selects a-4
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-5'))
    await user.keyboard('{/Shift}')
    // Anchored at a-4, the range adds a-4..a-5: a-1, a-4, a-5 — three.
    // Had the anchor stayed at a-1 the range would be a-1..a-5 and this
    // would be all five. (§232 changed how the first anchor is set — a
    // plain click opens now — so it is the checkbox here rather than a
    // bare click on a-1; the rule under test is untouched.)
    expect(selectedCount()).toBe(3)
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
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-1'))
    await user.keyboard('{/Meta}')
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
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
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

/**
 * §101 — the same rules, reached through the CHECKBOX.
 *
 * §99 put shift/cmd only on the card body. The checkbox is the visible
 * "select" control and the more natural target, and it plain-toggled
 * whatever modifier was held — in two separate implementations, one per
 * view, that each ignored the event.
 */

describe.each([
  ['grid', 'grid' as const],
  ['list', 'list' as const],
])('checkbox modifier clicks — %s view', (_label, layout) => {
  beforeEach(() => {
    useViewStore.setState({ layout, flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
  })

  it('plain click toggles and never opens the asset', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(checkboxFor('B Two'))
    expect(selectedCount()).toBe(1)
    // The one behaviour that must stay checkbox-specific.
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    await user.click(checkboxFor('B Two'))
    expect(selectedCount()).toBeNull()
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('shift-click selects the range', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.click(checkboxFor('B Two'))
    await user.keyboard('{Shift>}')
    await user.click(checkboxFor('D Four'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)     // a-2, a-3, a-4
    // Still never an open, even with a modifier held.
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  // Documentation, not discrimination, and worth being straight about: on
  // the CHECKBOX a cmd-click and a plain click are the same operation —
  // both toggle one item and neither opens the panel. This asserts the
  // intent holds, but it cannot fail if the modifier branch is removed,
  // because the fallback does the same thing. The shift case above is what
  // actually proves the modifier is read.
  it('cmd-click adds without disturbing an existing range', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(checkboxFor('A One'))
    await user.keyboard('{Shift>}')
    await user.click(checkboxFor('B Two'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(2)
    await user.keyboard('{Meta>}')
    await user.click(checkboxFor('E Five'))
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(3)
  })

})

describe('the checkbox and the card body share one anchor', () => {
  // Grid only, because cardFor() reads data-asset-card, which AssetCard
  // sets and the list row does not. The rule under test is view-agnostic
  // state, so proving it once is enough — asserting it in list view would
  // need a second selector for no extra confidence.
  beforeEach(() => {
    useViewStore.setState({ layout: 'grid', flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
  })

  it('a card-body shift-click continues from where a checkbox click left off', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(checkboxFor('B Two'))
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)
  })

  it('…and the reverse', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(checkboxFor('D Four'))
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(3)
  })
})

describe('bulk actions act on exactly what was selected', () => {
  it('delete receives the range, nothing more', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.keyboard('{Meta>}')
    await user.click(cardFor('a-2'))
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-4'))
    await user.keyboard('{/Shift}')
    await user.click(screen.getByRole('button', { name: /^delete$/i }))
    const [assetIds] = (handlers.onBulkDelete as ReturnType<typeof vi.fn>).mock.calls[0]
    expect([...assetIds].sort()).toEqual(['a-2', 'a-3', 'a-4'])
  })
})
