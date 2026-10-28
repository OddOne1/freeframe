/**
 * §241 item 4 — what a delete confirmation says.
 *
 * The old sentence ("You can restore it later from Recently Deleted") left
 * out the only fact the user needs: there is a deadline, and after it the
 * file is gone. Every asset and folder delete in the app now names the
 * retention window, from ONE source — `trashDeleteWarning` — so a fifth
 * dialog cannot be added with the old promise in it.
 *
 * The version dialog is deliberately NOT part of that: a soft-deleted
 * version is never purged, so it gets its own honest text (asserted in
 * `review/__tests__/delete-version.test.tsx`), and the scan at the bottom
 * of this file holds that no dialog keeps the old wording.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { trashDeleteWarning, TRASH_RETENTION_DAYS } from '@/lib/utils'
import type { Folder, FolderTreeNode } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(async () => ({})) },
  ApiError: class extends Error {},
}))

import { FolderCard } from '../folder-card'
import { FolderTree } from '../folder-tree'

const folder = (over: Partial<Folder> = {}): Folder => ({
  id: 'f-1',
  project_id: 'p-1',
  parent_id: null,
  name: 'Day 1',
  created_by: 'u-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  item_count: 3,
  total_size_bytes: 0,
  ...over,
})

const node = (over: Partial<FolderTreeNode> = {}): FolderTreeNode => ({
  id: 'f-1',
  name: 'Day 1',
  parent_id: null,
  item_count: 3,
  total_size_bytes: 0,
  children: [],
  ...over,
})

const treeProps = {
  projectName: 'Podcast',
  currentFolderId: null,
  showTrash: false,
  onSelectFolder: vi.fn(),
  onCreateFolder: vi.fn(async () => {}),
  onRenameFolder: vi.fn(async () => {}),
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('the wording itself', () => {
  it('names the deadline for an asset', () => {
    expect(trashDeleteWarning('asset')).toBe(
      'This will move the asset to the trash. You have 30 days to restore it from "Recently Deleted" before it will be permanently deleted.',
    )
  })

  it('names the deadline for a folder, and what goes with it', () => {
    expect(trashDeleteWarning('folder')).toBe(
      'This will move the folder and everything inside it to the trash. You have 30 days to restore it from "Recently Deleted" before it will be permanently deleted.',
    )
  })

  it('reads in the plural for a multi-select', () => {
    expect(trashDeleteWarning('selection')).toBe(
      'This will move the selected items to the trash. You have 30 days to restore them from "Recently Deleted" before they will be permanently deleted.',
    )
  })

  it('takes the number from the retention constant, not a literal', () => {
    expect(trashDeleteWarning('asset')).toContain(`${TRASH_RETENTION_DAYS} days`)
    expect(trashDeleteWarning('asset', 14)).toContain('14 days')
  })
})

describe('the folder card’s dialog', () => {
  it('carries the new folder wording', async () => {
    const user = userEvent.setup()
    render(
      <FolderCard folder={folder()} onOpen={vi.fn()} onDelete={vi.fn(async () => {})} />,
    )
    await user.click(screen.getByRole('button', { name: /^$|more/i }))
    await user.click(screen.getByTestId('folder-card-delete'))
    expect(await screen.findByText(trashDeleteWarning('folder'))).toBeInTheDocument()
  })
})

describe('the folder tree’s confirmation', () => {
  it('carries the new folder wording', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onDeleteFolder = vi.fn(async () => {})

    render(
      <FolderTree {...treeProps} tree={[node()]} onDeleteFolder={onDeleteFolder} />,
    )
    await user.click(screen.getByRole('button', { name: /Folder options for Day 1/ }))
    await user.click(await screen.findByTestId('folder-tree-delete-f-1'))

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy.mock.calls[0][0]).toContain(trashDeleteWarning('folder'))
    expect(confirmSpy.mock.calls[0][0]).toContain('Day 1')
    // It answered no, so nothing was deleted.
    expect(onDeleteFolder).not.toHaveBeenCalled()
  })
})

/** Every .ts/.tsx under the app's own source, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('no delete dialog keeps the old promise', () => {
  const root = join(__dirname, '..', '..', '..')
  const files = sourceFiles(root).map((f) => ({
    path: f.slice(root.length + 1),
    text: readFileSync(f, 'utf8'),
  }))

  it('nothing says "You can restore it later" any more', () => {
    const hits = files
      .filter(
        (f) =>
          /You can restore (it|them) later/.test(f.text) ||
          /moved to trash\. You can restore/.test(f.text),
      )
      .map((f) => f.path)
    expect(hits).toEqual([])
  })

  it('the project page’s two dialogs take their text from the one source', () => {
    const page = files.find(
      (f) => f.path === 'app/(dashboard)/projects/[id]/page.tsx',
    )!
    expect(page.text).toContain('trashDeleteWarning("asset")')
    expect(page.text).toContain('trashDeleteWarning("selection")')
  })

  it('the folder surfaces take theirs from the same source', () => {
    for (const path of ['components/projects/folder-card.tsx', 'components/projects/folder-tree.tsx']) {
      const file = files.find((f) => f.path === path)!
      expect(file.text).toContain("trashDeleteWarning('folder')")
    }
  })

  it('the version dialog promises no deadline, because nothing purges a version', () => {
    const switcher = files.find(
      (f) => f.path === 'components/review/version-switcher.tsx',
    )!
    expect(switcher.text).toContain('approvals are hidden with it')
    expect(switcher.text).toContain('version list or from Recently Deleted')
    expect(switcher.text).not.toContain('trashDeleteWarning')
  })
})
