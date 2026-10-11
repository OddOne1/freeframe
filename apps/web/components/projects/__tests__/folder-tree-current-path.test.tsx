/**
 * The tree opens where you are (§227b item 2).
 *
 * The owner, from a real phone: he was inside "Video", below `src`, and
 * the opened navigator showed `Just Ride 2026` with `src` and `Podcast`
 * both collapsed — the folder he was in was neither visible nor
 * highlighted. Checked before fixing: not the mock data (the mock tree
 * contains that exact chain), but `FolderNode`'s own `useState(false)`,
 * which nothing ever seeded. The `xl`+ sidebar column shares this
 * component and had the same hole, so the mechanism lives in `FolderTree`
 * and both mount points get it — there is no second implementation for the
 * panel, which is what these tests pin down by exercising `FolderTree`
 * directly AND through `FolderNavigator`.
 *
 * The tree here is three levels deep with a sibling branch, because the
 * two things that can go wrong are "not deep enough" and "opens
 * everything".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FolderTreeNode } from '@/types'

import { FolderTree, folderPathIds } from '../folder-tree'
import { FolderNavigator } from '../folder-navigator'

const node = (
  id: string,
  name: string,
  parent_id: string | null,
  children: FolderTreeNode[] = [],
): FolderTreeNode =>
  ({ id, name, parent_id, item_count: 0, total_size_bytes: 0, children }) as FolderTreeNode

// Just Ride 2026 / src / Video / Reaction_watchparty  — the owner's own
// chain, plus the sibling that was showing instead of it.
const REACTION = node('f-reaction', 'Reaction_watchparty', 'f-video')
const VIDEO = node('f-video', 'Video', 'f-src', [REACTION])
const SRC = node('f-src', 'src', null, [VIDEO])
const PODCAST = node('f-podcast', 'Podcast', null, [node('f-ep12', 'Episode 12', 'f-podcast')])
const TREE = [SRC, PODCAST]

const treeProps = (currentFolderId: string | null, tree: FolderTreeNode[] = TREE) => ({
  tree,
  projectName: 'Just Ride 2026',
  currentFolderId,
  showTrash: false,
  onSelectFolder: vi.fn(),
  onShowTrash: vi.fn(),
  onCreateFolder: vi.fn().mockResolvedValue(undefined),
  onRenameFolder: vi.fn().mockResolvedValue(undefined),
  onDeleteFolder: vi.fn().mockResolvedValue(undefined),
})

/** The row for a folder, or null when its ancestors are still collapsed. */
const row = (id: string, scope: HTMLElement | Document = document) =>
  scope.querySelector(`[data-tree-folder="${id}"]`) as HTMLElement | null

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom implements no scrollIntoView at all (measured: `undefined`),
  // which is why the component optional-calls it. A spy is the only way to
  // assert the call from here.
  scrollIntoView = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView = scrollIntoView
})

afterEach(() => {
  delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView
})

describe('folderPathIds', () => {
  it('returns the chain from the top down to the folder, inclusive', () => {
    expect(folderPathIds(TREE, 'f-reaction')).toEqual(['f-src', 'f-video', 'f-reaction'])
  })

  it('is empty at the root and for a folder the tree does not hold yet', () => {
    expect(folderPathIds(TREE, null)).toEqual([])
    // The cold-load case: `?folder=` is known on the first render, the
    // tree answers later. Empty means "not yet", not "nowhere".
    expect(folderPathIds([], 'f-reaction')).toEqual([])
  })
})

describe('the tree opens along the path to the current folder', () => {
  it('shows a folder three levels down, with every ancestor expanded', () => {
    render(<FolderTree {...treeProps('f-reaction')} />)
    expect(row('f-src')).toBeTruthy()
    expect(row('f-video')).toBeTruthy()
    expect(row('f-reaction')).toBeTruthy()
  })

  it('highlights the current folder and nothing else', () => {
    render(<FolderTree {...treeProps('f-reaction')} />)
    expect(row('f-reaction')).toHaveAttribute('aria-current', 'true')
    expect(row('f-src')).not.toHaveAttribute('aria-current')
    expect(row('f-video')).not.toHaveAttribute('aria-current')
    // The highlight itself, which is what the owner could not see.
    expect(row('f-reaction')!.className).toMatch(/bg-accent\/10/)
  })

  it('scrolls the current folder into view, minimally', () => {
    render(<FolderTree {...treeProps('f-reaction')} />)
    expect(scrollIntoView).toHaveBeenCalled()
    // `nearest` so a container that does not need to scroll does not —
    // the desktop column must not jump.
    expect(scrollIntoView.mock.calls[0][0]).toEqual({ block: 'nearest', inline: 'nearest' })
    expect(scrollIntoView.mock.instances[0]).toBe(row('f-reaction'))
  })

  it('leaves the sibling branch closed — the path opens, not the tree', () => {
    render(<FolderTree {...treeProps('f-reaction')} />)
    expect(row('f-podcast')).toBeTruthy()
    expect(row('f-ep12')).toBeNull()
  })

  it('opens nothing at the project root', () => {
    render(<FolderTree {...treeProps(null)} />)
    expect(row('f-src')).toBeTruthy()
    expect(row('f-video')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('catches up when the tree arrives after the URL (cold deep link)', () => {
    const { rerender } = render(<FolderTree {...treeProps('f-reaction', [])} />)
    expect(row('f-reaction')).toBeNull()
    rerender(<FolderTree {...treeProps('f-reaction')} />)
    expect(row('f-reaction')).toBeTruthy()
    expect(row('f-reaction')).toHaveAttribute('aria-current', 'true')
  })

  it('follows a move to a different folder', () => {
    const { rerender } = render(<FolderTree {...treeProps(null)} />)
    expect(row('f-ep12')).toBeNull()
    rerender(<FolderTree {...treeProps('f-ep12')} />)
    expect(row('f-ep12')).toHaveAttribute('aria-current', 'true')
    // and what was already open stays open
    rerender(<FolderTree {...treeProps('f-reaction')} />)
    expect(row('f-ep12')).toBeTruthy()
    expect(row('f-reaction')).toHaveAttribute('aria-current', 'true')
  })
})

describe('the seeding does not fight the person using it', () => {
  it('a collapse survives SWR handing the same tree back', async () => {
    const user = userEvent.setup()
    const props = treeProps('f-video')
    const { rerender } = render(<FolderTree {...props} />)
    expect(row('f-video')).toBeTruthy()

    // Collapse `src` by clicking the row — it is the current folder's
    // parent, so this is the case a naive effect would undo.
    await user.click(row('f-src')!)
    expect(row('f-video')).toBeNull()

    // A revalidation: same contents, new array identity.
    rerender(<FolderTree {...props} tree={[{ ...SRC }, { ...PODCAST }]} />)
    expect(row('f-video')).toBeNull()
  })

  it('a row click still expands and collapses it', async () => {
    const user = userEvent.setup()
    const props = treeProps(null)
    render(<FolderTree {...props} />)

    await user.click(row('f-src')!)
    expect(props.onSelectFolder).toHaveBeenCalledWith('f-src')
    expect(row('f-video')).toBeTruthy()

    await user.click(row('f-src')!)
    expect(row('f-video')).toBeNull()
  })
})

describe('the folder navigator gets it from the same mechanism', () => {
  const navProps = (currentFolderId: string | null) => ({
    ...treeProps(currentFolderId),
    segments: ['Just Ride 2026', 'src', 'Video', 'Reaction_watchparty'],
  })

  it('opens three levels deep, highlighted and scrolled to, on open', async () => {
    const user = userEvent.setup()
    render(<FolderNavigator {...navProps('f-reaction')} />)

    // The panel is not mounted until the bar is tapped, so nothing has
    // been expanded yet — this is the state the owner photographed.
    expect(screen.queryByTestId('folder-navigator-panel')).toBeNull()

    await user.click(screen.getByTestId('folder-navigator-trigger'))
    const panel = screen.getByTestId('folder-navigator-panel')
    expect(row('f-src', panel)).toBeTruthy()
    expect(row('f-video', panel)).toBeTruthy()
    expect(row('f-reaction', panel)).toHaveAttribute('aria-current', 'true')
    expect(within(panel).getByText('Reaction_watchparty')).toBeTruthy()
    expect(scrollIntoView.mock.instances).toContain(row('f-reaction', panel))
  })

  it('is expanded again the next time it is opened', async () => {
    const user = userEvent.setup()
    render(<FolderNavigator {...navProps('f-video')} />)
    const trigger = screen.getByTestId('folder-navigator-trigger')

    await user.click(trigger)
    expect(row('f-video', screen.getByTestId('folder-navigator-panel'))).toBeTruthy()
    await user.click(trigger)
    expect(screen.queryByTestId('folder-navigator-panel')).toBeNull()
    await user.click(trigger)
    expect(row('f-video', screen.getByTestId('folder-navigator-panel'))).toBeTruthy()
  })
})
