/**
 * The sidebar folder menu is a popup, not a block in the list (§223 A).
 *
 * The bug: the menu rendered in normal flow, immediately after its row, so
 * opening it pushed every following folder — and the folder's own children
 * — down by the menu's height. The row you were aiming at moved out from
 * under the pointer.
 *
 * jsdom has no layout, so "did not shift" cannot be measured in pixels.
 * What IS measurable, and is the actual mechanism, is containment: the menu
 * must not be a descendant of the tree at all, the tree's own rendered rows
 * must be the same elements in the same order before and after opening, and
 * the only thing Radix adds inside the tree must be taken out of flow by
 * `position: fixed`. A menu that satisfies all three cannot reflow the list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FolderTreeNode } from '@/types'

import { FolderTree } from '../folder-tree'

function node(id: string, name: string, children: FolderTreeNode[] = []): FolderTreeNode {
  return {
    id,
    name,
    parent_id: null,
    item_count: 0,
    total_size_bytes: 0,
    children,
  } as unknown as FolderTreeNode
}

/** Three siblings, the middle one with a child: opening the FIRST row's
 *  menu used to move all four of the rows below it. */
const TREE: FolderTreeNode[] = [
  node('f-1', 'Alpha'),
  node('f-2', 'Bravo', [node('f-2a', 'Bravo Child')]),
  node('f-3', 'Charlie'),
]

function setup(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, ReturnType<typeof vi.fn> | undefined> = {
    onSelectFolder: vi.fn(),
    onShowTrash: vi.fn(),
    onCreateFolder: vi.fn(async () => {}),
    onRenameFolder: vi.fn(async () => {}),
    onDeleteFolder: vi.fn(async () => {}),
    onShareFolder: vi.fn(),
    onDropItems: vi.fn(),
    ...overrides,
  }
  const utils = render(
    <FolderTree
      tree={TREE}
      projectName="Proj"
      currentFolderId={null}
      showTrash={false}
      onSelectFolder={handlers.onSelectFolder as never}
      onShowTrash={handlers.onShowTrash as never}
      onCreateFolder={handlers.onCreateFolder as never}
      onRenameFolder={handlers.onRenameFolder as never}
      onDeleteFolder={handlers.onDeleteFolder as never}
      onShareFolder={handlers.onShareFolder as never}
      onDropItems={handlers.onDropItems as never}
    />,
  )
  return { ...utils, handlers }
}

/** The tree's own subtree — everything the sidebar lays out. */
function treeRoot(container: HTMLElement) {
  const el = container.firstElementChild
  if (!el) throw new Error('tree did not render')
  return el as HTMLElement
}

/** Rows, by the element that carries each folder's name. */
function rowLabels(container: HTMLElement) {
  return Array.from(treeRoot(container).querySelectorAll('span.truncate')).map(
    (s) => s.textContent,
  )
}

function menuItems() {
  return screen.queryAllByRole('menuitem').map((i) => i.textContent?.trim())
}

async function openKebab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `Folder options for ${name}` }))
  await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('§223 A.1 — the menu is a popup, outside the tree', () => {
  it('renders its items outside the tree subtree', async () => {
    const user = userEvent.setup()
    const { container } = setup()
    await openKebab(user, 'Alpha')

    const item = screen.getByRole('menuitem', { name: 'Rename' })
    // The whole fix in one assertion: the menu is not in the list.
    expect(treeRoot(container).contains(item)).toBe(false)
    // …and it really is in the document, i.e. portalled rather than absent.
    expect(document.body.contains(item)).toBe(true)
  })

  it('leaves the tree rows untouched — same elements, same order', async () => {
    const user = userEvent.setup()
    const { container } = setup()

    const before = Array.from(treeRoot(container).querySelectorAll('span.truncate'))
    const labelsBefore = before.map((s) => s.textContent)

    await openKebab(user, 'Alpha')

    const after = Array.from(treeRoot(container).querySelectorAll('span.truncate'))
    // Same node identities, so nothing was remounted or reordered…
    expect(after).toEqual(before)
    // …and the sequence a reader sees is unchanged.
    expect(labelsBefore).toEqual(['Proj', 'Alpha', 'Bravo', 'Charlie'])
    expect(rowLabels(container)).toEqual(labelsBefore)
  })

  it('adds not one element to the tree, which is what a shift requires', async () => {
    const user = userEvent.setup()
    const { container } = setup()

    // The count, not just the order: re-inlining the menu would leave every
    // row element identical and in sequence (the menu goes BETWEEN them),
    // so order alone does not catch it. An element that is not there cannot
    // take up height.
    const before = treeRoot(container).querySelectorAll('*').length
    await openKebab(user, 'Alpha')
    expect(treeRoot(container).querySelectorAll('*').length).toBe(before)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(menuItems()).toEqual([]))
    expect(treeRoot(container).querySelectorAll('*').length).toBe(before)
  })

  it('keeps the one element Radix does add inside the tree out of flow', async () => {
    const user = userEvent.setup()
    const { container } = setup()
    await openKebab(user, 'Alpha')

    // Radix needs an anchor element in the React tree. It is CursorMenu's
    // zero-size `fixed` span — the reason an anchor cannot push a row down.
    const anchors = Array.from(
      treeRoot(container).querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
    ).filter((el) => el.style.position === 'fixed')
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) {
      expect(a.style.width).toBe('0px')
      expect(a.style.height).toBe('0px')
    }
  })

  it('still renders no popup at all while closed', () => {
    const { container } = setup()
    expect(menuItems()).toEqual([])
    expect(rowLabels(container)).toEqual(['Proj', 'Alpha', 'Bravo', 'Charlie'])
  })
})

describe('§223 A.1 — dismissal and keyboard access', () => {
  it('closes on Escape', async () => {
    const user = userEvent.setup()
    setup()
    await openKebab(user, 'Alpha')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(menuItems()).toEqual([]))
  })

  it('closes on an outside click', async () => {
    const user = userEvent.setup()
    setup()
    await openKebab(user, 'Alpha')
    await user.click(document.body)
    await waitFor(() => expect(menuItems()).toEqual([]))
  })

  it('exposes the items as a menu, reachable by arrow keys', async () => {
    const user = userEvent.setup()
    setup()
    await openKebab(user, 'Alpha')
    // Radix owns focus for a real `role="menu"`; this asserts we get that
    // rather than a div of plain buttons, which is what it replaced.
    expect(screen.getByRole('menu')).toBeTruthy()
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus(),
    )
  })
})

describe('§223 A.1 — right-click opens the same menu', () => {
  it('offers exactly what the kebab offers', async () => {
    const user = userEvent.setup()
    setup()

    await openKebab(user, 'Bravo')
    const fromKebab = menuItems()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(menuItems()).toEqual([]))

    const row = screen.getByText('Bravo').closest('div') as HTMLElement
    await user.pointer({ keys: '[MouseRight]', target: row })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))

    expect(menuItems()).toEqual(fromKebab)
  })

  it('acts on the row that was right-clicked', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()

    const row = screen.getByText('Charlie').closest('div') as HTMLElement
    await user.pointer({ keys: '[MouseRight]', target: row })
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0))
    await user.click(screen.getByRole('menuitem', { name: 'Create share link' }))

    expect(handlers.onShareFolder).toHaveBeenCalledWith('f-3', 'Charlie')
  })
})

describe('§223 A.2 — Create share link', () => {
  it('sits between New Subfolder and Delete', async () => {
    const user = userEvent.setup()
    setup()
    await openKebab(user, 'Alpha')
    expect(menuItems()).toEqual([
      'Rename',
      'New Subfolder',
      'Create share link',
      'Delete',
    ])
  })

  it('calls the handler with this folder’s id and name', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await openKebab(user, 'Bravo')
    await user.click(screen.getByRole('menuitem', { name: 'Create share link' }))

    expect(handlers.onShareFolder).toHaveBeenCalledTimes(1)
    expect(handlers.onShareFolder).toHaveBeenCalledWith('f-2', 'Bravo')
  })

  it('reaches a nested folder too, with that child’s own id', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    // Expand Bravo by clicking its row.
    await user.click(screen.getByText('Bravo'))
    const child = await screen.findByText('Bravo Child')
    expect(child).toBeTruthy()

    await openKebab(user, 'Bravo Child')
    await user.click(screen.getByRole('menuitem', { name: 'Create share link' }))
    expect(handlers.onShareFolder).toHaveBeenCalledWith('f-2a', 'Bravo Child')
  })

  it('is withheld when the role cannot share', async () => {
    const user = userEvent.setup()
    setup({ onShareFolder: undefined })
    await openKebab(user, 'Alpha')
    const items = menuItems()
    expect(items).not.toContain('Create share link')
    // …and the rest of the menu still works.
    expect(items).toEqual(['Rename', 'New Subfolder', 'Delete'])
  })

  it('the other entries still do what they did', async () => {
    const user = userEvent.setup()
    const { handlers } = setup()
    await openKebab(user, 'Alpha')
    await user.click(screen.getByRole('menuitem', { name: 'New Subfolder' }))
    expect(handlers.onCreateFolder).toHaveBeenCalledWith('', 'f-1')
  })
})
