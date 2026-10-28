/**
 * §240 C2 / §241 item 5b — a Delete the server would refuse is not offered.
 *
 * §240 narrowed deletion: an editor may delete only assets they uploaded,
 * and a folder only when its whole subtree is theirs. The server answers
 * that per row (`can_delete`), and these tests hold that the web renders
 * from THAT answer rather than from a rule of its own:
 *
 *  * false → the control is disabled and says why, on the card menu, the
 *    list row, the right-click menu, the folder card and the folder tree;
 *  * absent → the control stays as it was, because an older listing (or a
 *    share page's grid) sends no flag and taking the action away there
 *    would remove it from people who have it. The server's 403 is the
 *    backstop, and the page shows its message;
 *  * a multi-select holding ONE forbidden item offers no bulk delete at
 *    all: there is no bulk endpoint, so the loop would half-succeed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type { Asset, Folder, FolderTreeNode } from '@/types'
import {
  ASSET_DELETE_DENIED,
  BULK_DELETE_DENIED,
  FOLDER_DELETE_DENIED,
  deleteBlocked,
} from '../delete-permissions'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(async () => ({})) },
  ApiError: class extends Error {},
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/projects/p-1',
}))

import { AssetGrid } from '../asset-grid'
import { FolderCard } from '../folder-card'
import { FolderTree } from '../folder-tree'

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a-1',
  project_id: 'p-1',
  name: 'Clip.mov',
  description: null,
  asset_type: 'video',
  status: 'in_review',
  rating: null,
  assignee_id: null,
  folder_id: null,
  due_date: null,
  keywords: [],
  created_by: 'u-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  deleted_at: null,
  ...over,
})

const folder = (over: Partial<Folder> = {}): Folder => ({
  id: 'f-1',
  project_id: 'p-1',
  parent_id: null,
  name: 'Day 1',
  created_by: 'u-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  item_count: 2,
  total_size_bytes: 0,
  ...over,
})

const gridProps = {
  projectId: 'p-1',
  projectName: 'Podcast',
  currentFolderId: null,
  folderTree: [] as FolderTreeNode[],
  folderPaths: {},
  assignees: {},
  thumbnails: {},
  versionCounts: {},
  authorNames: {},
  fileSizes: {},
}

function renderGrid(over: Record<string, unknown> = {}) {
  return render(
    <AssetGrid
      {...gridProps}
      assets={[asset()]}
      folders={[]}
      onAssetDelete={vi.fn()}
      onFolderDelete={vi.fn(async () => {})}
      onBulkDelete={vi.fn()}
      {...over}
    />,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('the flag’s meaning', () => {
  it('blocks only on an explicit false', () => {
    expect(deleteBlocked(false)).toBe(true)
    expect(deleteBlocked(true)).toBe(false)
    expect(deleteBlocked(undefined)).toBe(false)
  })
})

describe('one asset, in the grid’s menus', () => {
  it('disables the card menu’s Delete and says why', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset({ can_delete: false })] })

    await user.click(screen.getByRole('button', { name: 'Options for Clip.mov' }))
    const item = await screen.findByTestId('asset-menu-delete')
    expect(item).toHaveAttribute('data-disabled')
    expect(item).toHaveAttribute('title', ASSET_DELETE_DENIED)
  })

  it('leaves it alone when the server said yes', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset({ can_delete: true })] })

    await user.click(screen.getByRole('button', { name: 'Options for Clip.mov' }))
    const item = await screen.findByTestId('asset-menu-delete')
    expect(item).not.toHaveAttribute('data-disabled')
  })

  it('leaves it alone when no flag was sent at all', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset()] })

    await user.click(screen.getByRole('button', { name: 'Options for Clip.mov' }))
    expect(await screen.findByTestId('asset-menu-delete')).not.toHaveAttribute(
      'data-disabled',
    )
  })

  it('answers the same way on right-click', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset({ can_delete: false })] })

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByText('Clip.mov'),
    })
    const item = await screen.findByTestId('asset-menu-delete')
    expect(item).toHaveAttribute('data-disabled')
    expect(item).toHaveAttribute('title', ASSET_DELETE_DENIED)
  })
})

describe('a folder', () => {
  it('disables the folder card’s Delete and says why', async () => {
    const user = userEvent.setup()
    render(
      <FolderCard
        folder={folder({ can_delete: false })}
        onOpen={vi.fn()}
        onDelete={vi.fn(async () => {})}
      />,
    )
    await user.click(screen.getAllByRole('button')[0])
    const item = screen.getByTestId('folder-card-delete')
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', FOLDER_DELETE_DENIED)
  })

  it('disables the folder tree’s Delete and says why', async () => {
    const user = userEvent.setup()
    render(
      <FolderTree
        tree={[
          {
            id: 'f-1',
            name: 'Day 1',
            parent_id: null,
            item_count: 2,
            total_size_bytes: 0,
            can_delete: false,
            children: [],
          },
        ]}
        projectName="Podcast"
        currentFolderId={null}
        showTrash={false}
        onSelectFolder={vi.fn()}
        onCreateFolder={vi.fn(async () => {})}
        onRenameFolder={vi.fn(async () => {})}
        onDeleteFolder={vi.fn(async () => {})}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Folder options for Day 1/ }))
    const item = await screen.findByTestId('folder-tree-delete-f-1')
    expect(item).toHaveAttribute('data-disabled')
    expect(item).toHaveAttribute('title', FOLDER_DELETE_DENIED)
  })
})

describe('a multi-select', () => {
  async function select(user: ReturnType<typeof userEvent.setup>, name: string) {
    // The card's own checkbox — a named button, as §99/§227b made it.
    await user.click(screen.getByRole('button', { name: `Select ${name}` }))
  }

  it('offers the bulk delete when every selected item may be deleted', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset({ can_delete: true })] })
    await select(user, 'Clip.mov')
    expect(screen.getByTestId('bulk-delete')).not.toBeDisabled()
  })

  it('withholds it when the selection holds one item that may not be', async () => {
    const user = userEvent.setup()
    renderGrid({ assets: [asset({ can_delete: false })] })
    await select(user, 'Clip.mov')

    const button = screen.getByTestId('bulk-delete')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', BULK_DELETE_DENIED)
  })

  it('does not call the handler for a forbidden selection', async () => {
    const user = userEvent.setup()
    const onBulkDelete = vi.fn()
    renderGrid({ assets: [asset({ can_delete: false })], onBulkDelete })
    await select(user, 'Clip.mov')
    await user.click(screen.getByTestId('bulk-delete'))
    expect(onBulkDelete).not.toHaveBeenCalled()
  })

  it('withholds it for a forbidden FOLDER in the selection too', async () => {
    const user = userEvent.setup()
    renderGrid({
      assets: [],
      folders: [folder({ can_delete: false })],
    })
    await select(user, 'Day 1')
    expect(screen.getByTestId('bulk-delete')).toBeDisabled()
  })
})
