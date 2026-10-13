/**
 * One CLICK opens — a tap, a mouse click, Enter (§232 item 1, reversing
 * the mouse half of §227b).
 *
 * §227b's rule was "a tap opens, a mouse click selects, a mouse
 * double-click opens", because a selected asset had a right panel to
 * appear in. §232 removes that panel, and the owner's decision is that the
 * first click opens whatever made it: "we would want to open folders and
 * assets on the first click". The tests that asserted the old mouse rule
 * are REWRITTEN here rather than deleted — same four surfaces, same
 * gestures, opposite expectation — because what has to keep working is
 * everything around the new rule:
 *
 *   - selection is still fully possible with a mouse: the checkbox,
 *     cmd-click, shift-click, and a plain click once anything is selected
 *   - a DRAG never opens anything
 *   - the checkbox, the kebab, the rating and the rename dialog never open
 *     the card they sit on
 *   - a tap still opens, exactly as §227b made it
 *
 * Every test here drives REAL pointer events through the real components,
 * because the whole decision is "what was this gesture", and that is
 * invisible from calling a handler. Three things measured in this
 * environment shape how they are written:
 *
 *  - `user.click()` fires `pointerdown` with `pointerType: 'mouse'`, so
 *    these are genuinely the mouse path.
 *  - the `click` event that follows carries NO `pointerType` at all
 *    (undefined in jsdom, and not guaranteed in Safari either). That is
 *    why §227b recorded the type on `pointerdown` — and why §232's drag
 *    guard records the POSITION there instead.
 *  - jsdom runs no layout and applies no media queries, so "44 CSS px is
 *    44px" and "`(hover: none)` paints this" are asserted as the classes
 *    that encode the decision, and measured for real in the browser
 *    evidence.
 *
 * STATED PLAINLY: the Cmd / Shift / drag gestures here are synthesized —
 * by userEvent in this file, by Playwright's mouse in the Chromium
 * evidence. Neither is a Mac trackpad.
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

/** The four surfaces a click has to work on. */
const el = {
  assetCard: () => document.querySelector('[data-asset-card="a-1"]') as HTMLElement,
  folderCard: () => document.querySelector('[data-folder-card="f-1"]') as HTMLElement,
  assetRow: () => document.querySelector('[data-asset-row="a-1"]') as HTMLElement,
  folderRow: () => document.querySelector('[data-folder-row="f-1"]') as HTMLElement,
}

/** The focusable wrapper. The asset CARD is `AssetCard`'s own root inside
 *  the grid's wrapper div; the other three carry the handlers themselves. */
const focusTarget = {
  assetCard: () => el.assetCard().parentElement as HTMLElement,
  folderCard: () => el.folderCard(),
  assetRow: () => el.assetRow(),
  folderRow: () => el.folderRow(),
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

// ─────────────────────────────────────────────────────────── the new rule

describe('a plain MOUSE click opens, on all four surfaces, once', () => {
  it('asset card', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen.mock.calls[0][0].id).toBe('a-1')
    // One gesture, one meaning: not also a selection.
    expect(selectedCount()).toBeNull()
  })

  it('asset row', async () => {
    const { user, handlers } = setup('list')
    await user.click(el.assetRow())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(selectedCount()).toBeNull()
  })

  it('folder card — the surface where a mouse click used to do nothing at all', async () => {
    // §227b pinned this as inert on purpose: the grid passed the card no
    // `onSelect`, so a plain mouse click had always been a dead gesture,
    // and the checkbox and the double-click were the mouse's only two
    // controls. That is the thing the owner reported.
    const { user, handlers } = setup('grid')
    await user.click(el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onFolderOpen.mock.calls[0][0].id).toBe('f-1')
  })

  it('folder row — which already opened on one click, and still does', async () => {
    const { user, handlers } = setup('list')
    await user.click(el.folderRow())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })
})

describe('a mouse DOUBLE-click opens once, not twice', () => {
  // Years of double-clicking this grid is muscle memory, and two opens is
  // two router pushes — two history entries for one gesture, so one Back
  // press would not get you out of the viewer. The second click of the
  // sequence carries `detail: 2` and is dropped.
  it('asset card', async () => {
    const { user, handlers } = setup('grid')
    await user.dblClick(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })

  it('folder card', async () => {
    const { user, handlers } = setup('grid')
    await user.dblClick(el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('asset row and folder row', async () => {
    const { user, handlers } = setup('list')
    await user.dblClick(el.assetRow())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    await user.dblClick(el.folderRow())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────────────── the half that makes the rule survivable

/**
 * Selection with a mouse. This is the part that makes single-click open
 * safe rather than destructive, so it is tested harder than the open
 * itself.
 */
describe('selection is still fully possible with a mouse', () => {
  it('cmd-click toggles a card and never opens it', async () => {
    const { user, handlers } = setup('grid')
    await user.keyboard('{Meta>}')
    await user.click(el.assetCard())
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    // …and back off again.
    await user.keyboard('{Meta>}')
    await user.click(el.assetCard())
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBeNull()
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('ctrl-click does too, for a mouse that is not on a Mac', async () => {
    const { user, handlers } = setup('grid')
    await user.keyboard('{Control>}')
    await user.click(el.assetCard())
    await user.keyboard('{/Control}')
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('shift-click selects the range and never opens', async () => {
    const { user, handlers } = setup('grid')
    await user.keyboard('{Meta>}')
    await user.click(el.assetCard())
    await user.keyboard('{/Meta}')
    await user.keyboard('{Shift>}')
    await user.click(document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBe(2)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('a modified click on a FOLDER card toggles it rather than opening it', async () => {
    // Folders have no range of their own — the shift range is measured
    // over the rendered ASSET list, which folders are not in — so shift
    // toggles here, exactly like cmd. Asserted rather than left implicit.
    const { user, handlers } = setup('grid')
    await user.keyboard('{Meta>}')
    await user.click(el.folderCard())
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    await user.keyboard('{Shift>}')
    await user.click(el.folderCard())
    await user.keyboard('{/Shift}')
    expect(selectedCount()).toBeNull()
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('a modified click on a FOLDER row does the same', async () => {
    const { user, handlers } = setup('list')
    await user.keyboard('{Meta>}')
    await user.click(el.folderRow())
    await user.keyboard('{/Meta}')
    expect(selectedCount()).toBe(1)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('Escape clears the selection', async () => {
    // NEW in §232: Escape did nothing before. With a selection now
    // changing what every click in the view does, there has to be a
    // one-key way out of that mode.
    const { user } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)
    await user.keyboard('{Escape}')
    expect(selectedCount()).toBeNull()
  })

  it('a click on empty space clears the selection', async () => {
    // NEW in §232 as well.
    const { user } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)
    // The "1 FOLDER" label row: inside the grid, part of no card, and not
    // interactive — the canvas, as far as this rule is concerned.
    const label = screen.getByText(/^1 Folder$/)
    await user.click(label.parentElement as HTMLElement)
    expect(selectedCount()).toBeNull()
  })

  it('the bulk bar X still clears it', async () => {
    const { user } = setup('grid', { onBulkDelete: vi.fn() })
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    const bar = screen.getByText(/1 Item selected/).parentElement as HTMLElement
    await user.click(bar.querySelector('button') as HTMLElement)
    expect(selectedCount()).toBeNull()
  })
})

/**
 * §232 item 1 — a DRAG must never be followed by an open.
 *
 * The real move gesture (§223: an asset or a folder dropped onto a folder)
 * is HTML5 drag and drop, and a browser that has promoted the gesture to a
 * drag fires no `click` at all. What this guards is the gesture the
 * browser did NOT promote: a press, a move and a release, which still ends
 * in a `click` — at the release point. Before §232 that click only
 * selected, so it was harmless; now it would navigate.
 *
 * jsdom has no drag machinery, so these drive the two primitives the guard
 * actually reads: `pointerdown` at one place, `click` at another. The real
 * mouse-down / move / up drag over a real drop target is in the Chromium
 * evidence.
 */
describe('a drag that ends on a card does not open it', () => {
  const dragThenClick = (node: HTMLElement, dx: number, dy: number) => {
    node.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: 100, clientY: 100, pointerType: 'mouse',
    }))
    node.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: 100 + dx, clientY: 100 + dy, pointerType: 'mouse',
    }))
    node.dispatchEvent(new MouseEvent('click', {
      bubbles: true, clientX: 100 + dx, clientY: 100 + dy, detail: 1,
    }))
  }

  it('asset card', () => {
    const { handlers } = setup('grid')
    dragThenClick(el.assetCard(), 120, 40)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    expect(selectedCount()).toBeNull()
  })

  it('folder card', () => {
    const { handlers } = setup('grid')
    dragThenClick(el.folderCard(), 0, 90)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('asset row and folder row', () => {
    const { handlers } = setup('list')
    dragThenClick(el.assetRow(), 200, 0)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    dragThenClick(el.folderRow(), -60, 30)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('a drag does not SELECT either, with a selection already active', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)
    dragThenClick(document.querySelector('[data-asset-card="a-2"]') as HTMLElement, 150, 0)
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('…and a click that moved only a pixel or two still opens', () => {
    // The threshold is 5px, because a real click wobbles. A guard that
    // fired on any movement at all would make the grid feel broken.
    const { handlers } = setup('grid')
    dragThenClick(el.assetCard(), 2, 2)
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })
})

describe('the keyboard: Enter opens, Space toggles (§232 item 1)', () => {
  // NEW: no card or row was focusable before §232 — no `tabIndex`, no key
  // handler — so Enter did nothing on any of the four.
  it('every surface is focusable', () => {
    setup('grid')
    expect(focusTarget.assetCard().tabIndex).toBe(0)
    expect(focusTarget.folderCard().tabIndex).toBe(0)
    setup('list')
    expect(focusTarget.assetRow().tabIndex).toBe(0)
    expect(focusTarget.folderRow().tabIndex).toBe(0)
  })

  it('Enter on an asset card opens it', async () => {
    const { user, handlers } = setup('grid')
    focusTarget.assetCard().focus()
    await user.keyboard('{Enter}')
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })

  it('Enter on a folder card opens it', async () => {
    const { user, handlers } = setup('grid')
    focusTarget.folderCard().focus()
    await user.keyboard('{Enter}')
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('Enter on either list row opens it', async () => {
    const { user, handlers } = setup('list')
    focusTarget.assetRow().focus()
    await user.keyboard('{Enter}')
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    focusTarget.folderRow().focus()
    await user.keyboard('{Enter}')
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })

  it('Space toggles the selection instead of opening', async () => {
    const { user, handlers } = setup('grid')
    focusTarget.assetCard().focus()
    await user.keyboard('[Space]')
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    await user.keyboard('[Space]')
    expect(selectedCount()).toBeNull()
  })

  it('a key pressed inside a control the card contains belongs to that control', async () => {
    // The kebab is a real button inside the card. Enter on it opens its
    // menu; it must not also open the asset.
    const { user, handlers } = setup('grid')
    const kebab = el.assetCard().querySelector('[aria-haspopup="menu"]') as HTMLElement
    kebab.focus()
    await user.keyboard('{Enter}')
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })
})

// ───────────────────────────────────────────────── touch, unchanged (§227b)

describe('a touch tap opens, in both layouts', () => {
  it('opens an asset CARD, once', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen.mock.calls[0][0].id).toBe('a-1')
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
  })

  it('opens a folder ROW in the list layout, once', async () => {
    const { user, handlers } = setup('list')
    await tap(user, el.folderRow())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
  })
})

describe('hybrid devices — the SAME card, both gestures, one meaning', () => {
  it('iPad with a trackpad: a finger tap and a trackpad click both open', async () => {
    const { user, handlers } = setup('grid')

    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)

    // Same card, same mount, no remount in between. §227b needed these
    // two to DIFFER; §232 needs them to agree, which is the simpler
    // guarantee — and the reason the hook no longer records the pointer
    // type at all.
    await user.click(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(2)
  })

  it('and the other way round, on a folder card', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(1)
    await tap(user, el.folderCard())
    expect(handlers.onFolderOpen).toHaveBeenCalledTimes(2)
  })

  it('a double TAP opens twice and no more', async () => {
    // Two taps are two gestures and mean two opens, which is what a finger
    // means. What must not happen is a THIRD open from the `dblclick` /
    // `detail: 2` that follows the second tap's click.
    const { user, handlers } = setup('grid')
    await tap(user, el.assetCard())
    await tap(user, el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(2)
  })
})

describe('with a selection active, a click or a tap toggles instead of opening', () => {
  it('asset card, with a MOUSE: the checkbox starts it, a plain click extends it', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)

    await user.click(document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    expect(selectedCount()).toBe(2)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()

    await user.click(document.querySelector('[data-asset-card="a-2"]') as HTMLElement)
    expect(selectedCount()).toBe(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('folder card, with a MOUSE: the same rule', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await user.click(el.folderCard())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('folder row, with a MOUSE: the same rule, where a click would have opened', async () => {
    const { user, handlers } = setup('list')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await user.click(el.folderRow())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('asset card, TAPPED: the checkbox starts it, the card extends it', async () => {
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

  it('folder card, TAPPED: the same rule', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await tap(user, el.folderCard())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('folder row, TAPPED: the same rule', async () => {
    const { user, handlers } = setup('list')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    await tap(user, el.folderRow())
    expect(selectedCount()).toBe(2)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('and once the selection is cleared, a click opens again', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(selectedCount()).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Deselect A One' }))
    expect(selectedCount()).toBeNull()

    await user.click(el.assetCard())
    expect(handlers.onAssetOpen).toHaveBeenCalledTimes(1)
  })
})

// ────────────────────── the controls inside a card, which never open it

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
    expect(selectedCount()).toBe(1)
  })

  it('folder card, tapped', async () => {
    const { user, handlers } = setup('grid')
    await tap(user, screen.getByRole('button', { name: 'Select Day 1' }))
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(selectedCount()).toBe(1)
  })

  it('folder card, clicked', async () => {
    const { user, handlers } = setup('grid')
    await user.click(screen.getByRole('button', { name: 'Select Day 1' }))
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

  it('asset row and folder row, clicked', async () => {
    const { user, handlers } = setup('list')
    await user.click(screen.getByRole('button', { name: 'Select A One' }))
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select Day 1' }))
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

  it('the asset card’s "···" trigger, clicked', async () => {
    const { user, handlers } = setup('grid')
    const kebab = el.assetCard().querySelector('[aria-haspopup="menu"]') as HTMLElement
    await user.click(kebab)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the folder card’s "···" trigger', async () => {
    const { user, handlers } = setup('grid')
    const kebab = el.folderCard().querySelector('button') as HTMLElement
    await tap(user, kebab)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
    expect(screen.getByText('Rename')).toBeTruthy()
  })

  it('the folder card’s "···" trigger, clicked', async () => {
    const { user, handlers } = setup('grid')
    await user.click(el.folderCard().querySelector('button') as HTMLElement)
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

  it('the star rating, clicked', async () => {
    const onAssetVote = vi.fn()
    const { user, handlers } = setup('grid', { canVote: true, onAssetVote })
    const stars = Array.from(el.assetCard().querySelectorAll('button')).filter((b) =>
      b.querySelector('svg')?.getAttribute('class')?.includes('star'),
    )
    await user.click(stars[3] as HTMLElement)
    expect(onAssetVote).toHaveBeenCalledTimes(1)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the list row’s "···" trigger', async () => {
    const { user, handlers } = setup('list')
    const kebab = el.assetRow().querySelector('[aria-haspopup="menu"]') as HTMLElement
    await tap(user, kebab)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the list row’s "···" trigger, clicked', async () => {
    const { user, handlers } = setup('list')
    const kebab = el.assetRow().querySelector('[aria-haspopup="menu"]') as HTMLElement
    await user.click(kebab)
    expect(handlers.onAssetOpen).not.toHaveBeenCalled()
  })

  it('the folder row’s "···" trigger, clicked', async () => {
    const { user, handlers } = setup('list')
    const kebab = el.folderRow().querySelector('[aria-haspopup="menu"]') as HTMLElement
    await user.click(kebab)
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })

  it('the RENAME control, and the dialog it opens', async () => {
    // Rename is reached through the folder card's kebab and opens a
    // dialog. Neither the menu entry nor anything inside the dialog may
    // reach the card's click handler — the dialog is PORTALLED to
    // document.body, so it is not a descendant of the card, which is what
    // makes that true rather than lucky. Asserted, because "the rename
    // control must not open the card" is only safe while that holds.
    const onFolderRename = vi.fn().mockResolvedValue(undefined)
    const { user, handlers } = setup('grid', { onFolderRename })
    await user.click(el.folderCard().querySelector('button') as HTMLElement)
    await user.click(screen.getByText('Rename'))
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()

    const field = screen.getByPlaceholderText('Folder name')
    expect(field.closest('[data-folder-card]')).toBeNull()
    await user.type(field, '!')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(handlers.onFolderOpen).not.toHaveBeenCalled()
  })
})

/**
 * On a phone the checkbox is the ONLY way to start a multi-selection, so
 * it being visible and finger-sized is a requirement, not a style. (§227b,
 * unchanged by §232 — and now the mouse's main way in as well, beside
 * cmd-click.)
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
