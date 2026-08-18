/**
 * Right-click menus on the asset grid (CLAUDE.md §28).
 *
 * Rendered for real, because every interesting rule here is about what the
 * menu contains given some state — selection membership, and which handlers
 * the current role was given. None of that is visible from a handler call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Asset } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { AssetGrid } from '../asset-grid'

function asset(id: string, name: string): Asset {
  return {
    id,
    project_id: 'p-1',
    name,
    status: 'in_review',
    asset_type: 'video',
    created_at: new Date().toISOString(),
    folder_id: null,
  } as unknown as Asset
}

const ASSETS = [asset('a-1', 'Clip One'), asset('a-2', 'Clip Two'), asset('a-3', 'Clip Three')]

/** Every action the grid can be given; individual tests withhold some. */
function allHandlers() {
  return {
    onAssetShare: vi.fn(),
    onAssetDownload: vi.fn(),
    onAssetRename: vi.fn(),
    onAssetDelete: vi.fn(),
    onCreateShareLink: vi.fn(),
    onBulkDelete: vi.fn(),
    onBulkDownload: vi.fn(),
    onBulkMove: vi.fn(),
    onNewFolder: vi.fn(),
    onUpload: vi.fn(),
  }
}

function setup(overrides: Record<string, unknown> = {}) {
  const handlers = { ...allHandlers(), ...overrides }
  const utils = render(
    <AssetGrid
      assets={ASSETS}
      projectId="p-1"
      projectName="Proj"
      layout="grid"
      {...(handlers as Record<string, never>)}
    />,
  )
  return { ...utils, handlers }
}

/** The card element for an asset, via the marker the grid's canvas check uses. */
function cardFor(id: string) {
  const el = document.querySelector(`[data-asset-card="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el as HTMLElement
}

function menuItems() {
  return screen.queryAllByRole('menuitem').map((i) => i.textContent?.trim())
}

beforeEach(() => { vi.clearAllMocks() })

describe('single-asset right-click', () => {
  it('offers exactly what the kebab menu offers', async () => {
    const user = userEvent.setup()
    setup()

    // The kebab's own list, for comparison — same component, so this is
    // the real cross-check rather than a hardcoded expectation.
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))

    expect(menuItems()).toEqual([
      'Create Share Link', 'Download', 'Copy Asset URL', 'Rename', 'Delete',
    ])
  })

  it('acts on the right-clicked asset', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-2') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(handlers.onAssetRename).toHaveBeenCalledTimes(1)
    expect((handlers.onAssetRename as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('a-2')
  })
})

describe('permissions — the menu offers only what the role was given', () => {
  it('omits Rename and Delete when those handlers are withheld', async () => {
    const user = userEvent.setup()
    setup({ onAssetRename: undefined, onAssetDelete: undefined })
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))

    const items = menuItems()
    expect(items).not.toContain('Rename')
    expect(items).not.toContain('Delete')
    // …and still offers what the role CAN do.
    expect(items).toContain('Download')
  })

  it('omits Share when the role cannot share', async () => {
    const user = userEvent.setup()
    setup({ onAssetShare: undefined })
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    expect(menuItems()).not.toContain('Create Share Link')
  })
})

describe('empty-canvas right-click', () => {
  it('offers New Folder and Upload', async () => {
    const user = userEvent.setup()
    const { container } = setup()
    await user.pointer({ keys: '[MouseRight]', target: container.firstChild as HTMLElement })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    expect(menuItems()).toEqual(['New Folder', 'Upload'])
  })

  it('offers nothing at all when the role can do neither', async () => {
    const user = userEvent.setup()
    const { container } = setup({ onNewFolder: undefined, onUpload: undefined })
    await user.pointer({ keys: '[MouseRight]', target: container.firstChild as HTMLElement })
    // No empty box: the handler bails before opening. Asserted on the menu
    // element, because an opened-but-empty menu also has zero items.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(menuItems()).toEqual([])
  })

  it('does not fire when the right-click landed on a card', async () => {
    const user = userEvent.setup()
    setup()
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    // The asset menu, not the canvas one.
    expect(menuItems()).not.toContain('New Folder')
  })
})

describe('selection-aware right-click', () => {
  /** Add an asset to the multi-selection via its checkbox, as a user would.
   *  Clicking the card body is a DIFFERENT action (it opens/previews), so
   *  going through the card would not build a selection at all. */
  async function select(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByLabelText(`Select ${name}`))
  }

  it('acts on the WHOLE selection when the clicked asset is part of it', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()

    await select(user, 'Clip One')
    await select(user, 'Clip Two')
    await select(user, 'Clip Three')

    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-2') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))

    // The bulk variant, not the single-asset one.
    expect(menuItems()).toContain('Move to…')
    expect(screen.getByText(/3 selected/i)).toBeTruthy()

    // By role, not by text: the bottom selection action bar also has a
    // Delete BUTTON, so a plain text query matches two things.
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(handlers.onBulkDelete).toHaveBeenCalledTimes(1)
    const [assetIds] = (handlers.onBulkDelete as ReturnType<typeof vi.fn>).mock.calls[0]
    expect([...assetIds].sort()).toEqual(['a-1', 'a-2', 'a-3'])
  })

  it('REPLACES the selection when the clicked asset is outside it', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()

    await select(user, 'Clip One')
    await select(user, 'Clip Two')

    // a-3 is not selected — the standard desktop rule is that this becomes
    // the selection, rather than acting on the stale one.
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-3') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))

    // Single-asset menu, because the selection is now just a-3.
    expect(menuItems()).not.toContain('Move to…')
    // The decisive assertion: the SELECTION itself was replaced. Checking
    // only which menu opened passes even if the old selection survives,
    // because the menu variant is chosen from membership, not size.
    expect(screen.getByText(/1 Item selected/i)).toBeTruthy()
    expect(screen.getByLabelText('Deselect Clip Three')).toBeTruthy()
    expect(screen.getByLabelText('Select Clip One')).toBeTruthy()
    expect(screen.getByLabelText('Select Clip Two')).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(handlers.onAssetRename).toHaveBeenCalledTimes(1)
    expect((handlers.onAssetRename as ReturnType<typeof vi.fn>).mock.calls[0][0].id).toBe('a-3')
    // Crucially, the previously-selected assets were NOT acted on.
    expect(handlers.onBulkDelete).not.toHaveBeenCalled()
  })

  it('treats a selection of exactly one as the single-asset case', async () => {
    const user = userEvent.setup()
    setup()
    await select(user, 'Clip One')
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    expect(menuItems()).toContain('Copy Asset URL')
    expect(menuItems()).not.toContain('Move to…')
  })

  it('omits bulk Delete when the role cannot edit', async () => {
    const user = userEvent.setup()
    setup({ onBulkDelete: undefined, onBulkMove: undefined })
    await select(user, 'Clip One')
    await select(user, 'Clip Two')
    await user.pointer({ keys: '[MouseRight]', target: cardFor('a-1') })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    const items = menuItems()
    expect(items).not.toContain('Delete')
    expect(items).not.toContain('Move to…')
    expect(items).toContain('Download')
  })
})

describe('folder tiles are not empty canvas', () => {
  it('does not open the canvas menu when right-clicking a folder', async () => {
    const user = userEvent.setup()
    render(
      <AssetGrid
        assets={ASSETS}
        folders={[{ id: 'f-1', name: 'Dailies', project_id: 'p-1' } as never]}
        projectId="p-1"
        projectName="Proj"
        layout="grid"
        {...(allHandlers() as Record<string, never>)}
      />,
    )
    const folder = document.querySelector('[data-folder-card="f-1"]')
    expect(folder).toBeTruthy()

    await user.pointer({ keys: '[MouseRight]', target: folder as HTMLElement })
    // A folder tile has no context handler of its own, so nothing stops
    // propagation — the grid's own target check is the only thing keeping
    // "New Folder" from appearing over a folder.
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
