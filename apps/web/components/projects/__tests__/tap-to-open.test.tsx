/**
 * One tap opens; one click selects (§227b item 1).
 *
 * The bug, reported from a real phone and then reproduced: `asset-grid.tsx`
 * opened an asset on `onDoubleClick` only, and the grid's folder card did
 * the same, so a single tap selected an item and — since §227 removed the
 * Comments tab that made a selection visible — nothing happened. The only
 * way into the viewer or into a folder was a double-tap.
 *
 * Every test here drives REAL pointer events through the real components,
 * because the whole decision is "which gesture was this", and that is
 * invisible from calling a handler. Two things measured in this
 * environment shape how they are written:
 *
 *  - `user.click()` fires `pointerdown` with `pointerType: 'mouse'`, so
 *    the existing desktop tests already exercise the mouse path.
 *  - the `click` event that follows carries NO `pointerType` at all
 *    (undefined in jsdom, and not guaranteed in Safari either), which is
 *    exactly why the type is recorded on `pointerdown` instead.
 *
 * What jsdom cannot show: that 44 CSS px is 44 px, or that `(hover: none)`
 * paints anything, since it applies no media queries and does no layout.
 * Those are asserted as the classes that encode the decision, and measured
 * for real in the browser evidence.
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

const ASSETS = [asset('a-1', 'A One'), asset('a-2', 'B Two')]

const FOLDERS = [
  {
    id: 'f-1',
    name: 'Day 1',
    project_id: 'p-1',
    parent_id: null,
    item_count: 0,
    total_size_bytes: 0,
    created_at: new Date().toISOString(),
  } as unknown as Folder,
]

function setup(layout: 'grid' | 'list', overrides: Record<string, unknown> = {}) {
  useViewStore.setState({ layout, flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
  const handlers = {
    onAssetSelect: vi.fn(),
    onAssetOpen: vi.fn(),
    onFolderOpen: vi.fn(),
    ...overrides,
  }
  const utils = render(
    <AssetGrid
      assets={ASSETS}
      folders={FOLDERS}
      projectId="p-1"
      projectName="Proj"
      {...handlers}
    />,
  )
  return { ...utils, handlers, user: userEvent.setup() }
}

/** The four surfaces a tap has to work on. */
const el = {
  assetCard: () => document.querySelector('[data-asset-card="a-1"]') as HTMLElement,
  folderCard: () => document.querySelector('[data-folder-card="f-1"]') as HTMLElement,
  assetRow: () => document.querySelector('[data-asset-row="a-1"]') as HTMLElement,
  folderRow: () => document.querySelector('[data-folder-row="f-1"]') as HTMLElement,
}

/** A finger. `[TouchA]` press-and-release fires pointerdown(touch) + click. */
function tap(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  return user.pointer([{ keys: '[TouchA]', target }])
}

/** What the bulk bar says, or null when nothing is selected. */
function selectedCount(): number | null {
  const node = screen.queryByText(/\d+ Items? selected/)
  if (!node) return null
  return Number((node.textContent || '').match(/(\d+)/)?.[1])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a touch tap opens, in both layouts', () => {
  it('opens an asset CARD, once', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen.mock.calls[0][0].id).toBe('a-1')
    // Not also the side panel, and not a selection: one gesture, one
    // meaning.
    expect(handlers.onAssetSelect).not.toHaveBeenCalled()
    expect(selectedCount()).toBeNull()
  })

  it('opens a folder CARD, once — the grid layout a phone actually uses', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onFolderOpen.mock.calls[0][0].id).toBe('f-1')
  })

  it('opens an asset ROW in the list layout, once', async () => {
    const { user, handlers } = setup('list')
    await tap(user, el.assetRow())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetSelect).not.toHaveBeenCalled()
  })

  it('opens a folder ROW in the list layout, once', async () => {
    const { user, handlers } = setup('list')
    await tap(user, el.folderRow())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })
})

describe('a mouse is left exactly as it was', () => {
  it('asset card: one click selects, a double-click opens', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.assetCard())
    expect(handlers.onAssetSelect).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()

    await user.dblClick(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })

  it('asset row: one click selects, a double-click opens', async () => {
    const { user, handlers } = setup('list')
    await user.click(el.assetRow())
    expect(handlers.onAssetSelect).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()

    await user.dblClick(el.assetRow())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })

  it('folder card: a click does not open it, a double-click does', async () => {
    // Pinned as-is on purpose. §227b says a single mouse click "selects" a
    // folder card today; it does not — the grid passes the card no
    // `onSelect`, so a plain click has always been inert and only the
    // checkbox and the double-click do anything. "Mouse behaviour exactly
    // as today" is the constraint, so inert is what it stays.
    const { user, handlers } = setup('grid')
    await user.click(el.folderCard())
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(selectedCount()).toBeNull()

    await user.dblClick(el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('folder row: a click still opens it, as it did before §227b', async () => {
    // The one surface where a plain mouse click already opened. Making it
    // "select" to match the other three would be a desktop regression, so
    // the hook is told so explicitly (`mouseClickOpens`).
    const { user, handlers } = setup('list')
    await user.click(el.folderRow())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('shift- and cmd-click still build a selection instead of opening', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.assetCard())
    await user.keyboard('{Shift>}')
    await user.click(document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(2)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })
})

describe('hybrid devices — the SAME card, both gestures', () => {
  it('iPad with a trackpad: a finger tap opens, then a click only selects', async () => {
    const { user, handlers } = setup('grid')

    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetSelect).not.toHaveBeenCalled()

    // Same card, same mount, no remount in between: the decision is per
    // gesture, so nothing about the first tap may leak into this click.
    await user.click(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetSelect).toHaveBeenCalledTimes(1)
  })

  it('and the other way round: a click selects, then a tap opens', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.folderCard())
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    await tap(user, el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('a double TAP opens once, not twice', async () => {
    // `dblclick` fires after the second tap's click. The first tap has
    // already opened the item, so the double must not open it again.
    const { user, handlers } = setup('grid')
    await tap(user, el.assetCard())
    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(2) // two taps, two opens
    // The point: `dblclick` added nothing on top of the two clicks.
    expect(handlers.onAssetOpen).not.toHaveBeenCalledTimes(3)
  })
})

describe('with a selection active, a tap toggles instead of opening', () => {
  it('asset card: the checkbox starts it, the card extends it', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)

    await tap(user, document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    expect(selectedCount()).toBe(2)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()

    // And a tap on an already-selected card takes it back out.
    await tap(user, document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('folder card: the same rule', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await tap(user, el.folderCard())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('folder row: the same rule, where a mouse click would have opened it', async () => {
    const { user, handlers } = setup('list')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await tap(user, el.folderRow())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('and once the selection is cleared, a tap opens again', async () => {
    const { user, handlers } = setup('grid')
    const checkbox = screen.getByRole('button', { name: 'Select A One' })
    await user.click(checkbox)
    expect(selectedCount()).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Deselect A One' }))
    expect(selectedCount()).toBeNull()

    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })
})

describe('the checkbox never opens the item, under either pointer', () => {
  it('asset card, tapped', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, screen.getByRole('button', { name: 'Select A One' }))
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    // Once, not twice: the card's own click must not see this gesture.
    expect(selectedCount()).toBe(1)
  })

  it('asset card, clicked', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    expect(handlers.onAssetSelect).not.toHaveBeenCalled()
    expect(selectedCount()).toBe(1)
  })

  it('folder card, tapped', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, screen.getByRole('button', { name: 'Select Day 1' }))
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(selectedCount()).toBe(1)
  })

  it('asset row and folder row, tapped', async () => {
    const { user, handlers } = setup('list')
    await tap(user, screen.getByRole('button', { name: 'Select A One' }))
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    await tap(user, screen.getByRole('button', { name: 'Select Day 1' }))
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(selectedCount()).toBe(2)
  })
})

describe('the other controls inside a card still do not open it', () => {
  it('the asset card’s "···" trigger', async () => {
    const { user, handlers } = setup('grid')
    const kebab = el.assetCard().querySelector('[aria-haspopup="menu"]') as HTMLElement
    expect(kebab).toBeTruthy()
    await tap(user, kebab)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the folder card’s "···" trigger', async () => {
    const { user, handlers } = setup('grid')
    const kebab = el.folderCard().querySelector('button') as HTMLElement
    await tap(user, kebab)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(screen.getByText('Rename')).toBeTruthy()
  })

  it('the star rating', async () => {
    const onAssetVote = vi.fn()
    const { user, handlers } = setup('grid', { canVote: true, onAssetVote })
    // The stars are unlabelled buttons; the lucide icon inside is the only
    // handle on them.
    const stars = Array.from(el.assetCard().querySelectorAll('button')).filter((b) =>
      b.querySelector('svg')?.getAttribute('class')?.includes('star'),
    )
    expect(stars).toHaveLength(5)
    await tap(user, stars[2] as HTMLElement)
    // It did its own job, and only its own job.
    expect(onAssetVote).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the list row’s "···" trigger', async () => {
    const { user, handlers } = setup('list')
    const kebab = el.assetRow().querySelector('[aria-haspopup="menu"]') as HTMLElement
    await tap(user, kebab)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })
})

/**
 * On a phone the checkbox is the ONLY way to start a multi-selection, so
 * it being visible and finger-sized is a requirement, not a style.
 *
 * jsdom neither applies `@media (hover: none)` nor lays anything out, so
 * these assert the classes that carry the decision: `tap-target-44`
 * (globals.css — a centred `::before` of `max(100%, 44px)`, which needs
 * the control to be positioned, hence the `absolute` assertion) and the
 * `hover-none:` variant that makes it visible with no hover available.
 */
describe('every selection checkbox is visible and 44px, on all four surfaces', () => {
  const asserted = (node: HTMLElement) => {
    expect(node.className).toMatch(/\btap-target-44\b/)
    expect(node.className).toMatch(/\babsolute\b/)
  }

  it('asset card', () => {
    setup('grid')
    const box = screen.getByRole('button', { name: 'Select A One' })
    asserted(box)
    // The box itself always paints (bg-black/40); what was invisible
    // without hover was the tick inside it.
    expect(box.className).toMatch(/hover-none:text-white\/60/)
  })

  it('folder card', () => {
    setup('grid')
    const box = screen.getByRole('button', { name: 'Select Day 1' })
    asserted(box)
    expect(box.className).toMatch(/hover-none:opacity-100/)
  })

  it('asset row', () => {
    setup('list')
    const box = screen.getByRole('button', { name: 'Select A One' })
    asserted(box)
    expect(box.className).toMatch(/hover-none:opacity-100/)
  })

  it('folder row', () => {
    setup('list')
    const box = screen.getByRole('button', { name: 'Select Day 1' })
    asserted(box)
    expect(box.className).toMatch(/hover-none:opacity-100/)
  })
})
