/**
 * Selecting ONE asset and pressing Download must not build a zip (§177).
 *
 * Rendered through the real grid and the real planner, because the bug was
 * never in either piece on its own: `onBulkDownload` fired for any non-empty
 * selection and went straight to `setZipOpen(true)` with no count check, so
 * a single checkbox produced `Project_Selected.zip` holding one clip — while
 * the card menu, right-click and the viewer all handed over the file itself.
 *
 * The assertion that matters is the negative one: the zip dialog is not
 * merely unused, it never mounts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import type { Asset, Folder } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

let downloads: string[] = []
vi.mock('@/lib/download', () => ({
  triggerBrowserDownload: (u: string) => {
    downloads.push(u)
    return true
  },
}))

import { AssetGrid } from '../asset-grid'
import { useViewStore } from '@/stores/view-store'
import { planBulkDownload } from '@/lib/bulk-download'
import { triggerBrowserDownload } from '@/lib/download'

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

const ASSETS = [asset('a-1', 'A One'), asset('a-2', 'B Two'), asset('a-3', 'C Three')]
const FOLDERS = [
  { id: 'f-1', name: 'Day 2 Rushes', project_id: 'p-1' } as unknown as Folder,
  { id: 'f-2', name: 'Day 3 Rushes', project_id: 'p-1' } as unknown as Folder,
]

/**
 * The project page's own wiring, minus everything unrelated to downloading:
 * the same planner call, the same single-asset branch, and a stand-in for
 * the zip dialog that records the props it would have been mounted with.
 */
function Harness({ onZip }: { onZip: (v: { assetIds: string[]; scope: string; folderName?: string }) => void }) {
  const [zip, setZip] = React.useState<null | {
    assetIds: string[]
    scope: string
    folderName?: string
  }>(null)

  return (
    <>
      <AssetGrid
        assets={ASSETS}
        folders={FOLDERS}
        projectId="p-1"
        projectName="Rope Challenge"
        onAssetSelect={() => {}}
        onBulkDownload={async (assetIds, folderIds) => {
          const plan = await planBulkDownload({
            assetIds,
            folderIds,
            expandFolder: async (id) => (id === 'f-1' ? ['a-7', 'a-8'] : ['a-9']),
            folderNameById: (id) => FOLDERS.find((f) => f.id === id)?.name,
          })
          if (plan.mode === 'none') return
          if (plan.mode === 'single') {
            triggerBrowserDownload(`/stream/hls/${plan.assetId}.mov?token=t`)
            return
          }
          const next = {
            assetIds: plan.assetIds,
            scope: plan.scope,
            folderName: plan.folderName,
          }
          setZip(next)
          onZip(next)
        }}
      />
      {/* Stands in for BatchDownloadDialog: mounted on exactly the same
          condition, so "no zip dialog" is observable in the DOM. */}
      {zip && <div data-testid="zip-dialog">Download selected</div>}
    </>
  )
}

function cardFor(id: string) {
  const el = document.querySelector(`[data-asset-card="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el as HTMLElement
}

/** A folder is selected by its own checkbox, not by cmd-clicking the card
 *  (the card's click opens the folder). It carries no accessible name, so it
 *  is reached through the wrapper the grid renders it in. */
function folderCheckboxFor(id: string) {
  const card = document.querySelector(`[data-folder-card="${id}"]`)
  const box = card?.parentElement?.querySelector('button')
  if (!box) throw new Error(`no folder checkbox for ${id}`)
  return box as HTMLElement
}

async function selectWithMeta(user: ReturnType<typeof userEvent.setup>, el: HTMLElement) {
  await user.keyboard('{Meta>}')
  await user.click(el)
  await user.keyboard('{/Meta}')
}

beforeEach(() => {
  downloads = []
  vi.clearAllMocks()
  useViewStore.setState({
    layout: 'grid',
    flattenFolders: false,
    sortKey: 'name',
    sortDirection: 'asc',
  })
})

describe('one selected asset', () => {
  it('downloads the file and never opens the zip dialog', async () => {
    const user = userEvent.setup()
    const onZip = vi.fn()
    render(<Harness onZip={onZip} />)

    await selectWithMeta(user, cardFor('a-2'))
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(downloads).toEqual(['/stream/hls/a-2.mov?token=t']))
    expect(onZip).not.toHaveBeenCalled()
    expect(screen.queryByTestId('zip-dialog')).toBeNull()
  })
})

describe('a genuine multi-select still zips, and says what shape it is', () => {
  it('two assets -> selected', async () => {
    const user = userEvent.setup()
    const onZip = vi.fn()
    render(<Harness onZip={onZip} />)

    await selectWithMeta(user, cardFor('a-1'))
    await selectWithMeta(user, cardFor('a-2'))
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(onZip).toHaveBeenCalled())
    expect(onZip.mock.calls[0][0]).toMatchObject({
      assetIds: ['a-1', 'a-2'],
      scope: 'selected',
    })
    expect(await screen.findByTestId('zip-dialog')).toBeTruthy()
    expect(downloads).toEqual([])
  })

  it('one folder -> single_folder, named after it', async () => {
    const user = userEvent.setup()
    const onZip = vi.fn()
    render(<Harness onZip={onZip} />)

    await user.click(folderCheckboxFor('f-1'))
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(onZip).toHaveBeenCalled())
    expect(onZip.mock.calls[0][0]).toMatchObject({
      scope: 'single_folder',
      folderName: 'Day 2 Rushes',
      assetIds: ['a-7', 'a-8'],
    })
  })

  it('two folders -> multiple_folders, with no single name to give', async () => {
    const user = userEvent.setup()
    const onZip = vi.fn()
    render(<Harness onZip={onZip} />)

    await user.click(folderCheckboxFor('f-1'))
    await user.click(folderCheckboxFor('f-2'))
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(onZip).toHaveBeenCalled())
    expect(onZip.mock.calls[0][0]).toMatchObject({ scope: 'multiple_folders' })
    expect(onZip.mock.calls[0][0].folderName).toBeUndefined()
  })

  it('a folder plus a loose file -> selected, not the folder name', async () => {
    const user = userEvent.setup()
    const onZip = vi.fn()
    render(<Harness onZip={onZip} />)

    await user.click(folderCheckboxFor('f-1'))
    await selectWithMeta(user, cardFor('a-3'))
    await user.click(screen.getByRole('button', { name: /^download$/i }))

    await waitFor(() => expect(onZip).toHaveBeenCalled())
    expect(onZip.mock.calls[0][0].scope).toBe('selected')
  })
})
