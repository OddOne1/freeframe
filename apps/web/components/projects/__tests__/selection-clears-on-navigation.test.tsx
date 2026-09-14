/**
 * A selection belongs to the folder it was made in.
 *
 * Select three clips in folder A, walk into folder B, and the ids stayed in
 * state: the bulk bar claimed "3 Items selected" with nothing on screen
 * selected, and Download/Move/Delete would then act on files the user could
 * no longer see. The only reset that existed was the shareMode effect.
 *
 * Navigation here is a PROP CHANGE on a mounted grid, not a remount —
 * rerendering with a new `currentFolderId` — because a remount would clear
 * the state by itself and prove nothing about the fix.
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

function asset(id: string, name: string, folderId: string | null): Asset {
  return {
    id,
    project_id: 'p-1',
    name,
    status: 'in_review',
    asset_type: 'video',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    folder_id: folderId,
  } as unknown as Asset
}

const IN_A = [asset('a-1', 'A One', 'f-a'), asset('a-2', 'B Two', 'f-a'), asset('a-3', 'C Three', 'f-a')]
const IN_B = [asset('b-1', 'D Four', 'f-b'), asset('b-2', 'E Five', 'f-b')]
const FOLDERS_A = [{ id: 'f-sub', name: 'Sub', project_id: 'p-1' } as unknown as Folder]

function cardFor(id: string) {
  const el = document.querySelector(`[data-asset-card="${id}"]`)
  if (!el) throw new Error(`no card for ${id}`)
  return el as HTMLElement
}

function folderCheckbox(id: string) {
  const card = document.querySelector(`[data-folder-card="${id}"]`)
  const box = card?.parentElement?.querySelector('button')
  if (!box) throw new Error(`no folder checkbox for ${id}`)
  return box as HTMLElement
}

/** What the user sees: the bulk bar's count, or null when it is absent. */
function selectedCount(): number | null {
  const el = screen.queryByText(/\d+ Items? selected/)
  if (!el) return null
  return Number((el.textContent || '').match(/(\d+)/)?.[1])
}

/** Every checkbox currently showing a tick. */
function checkedBoxes(): number {
  return document.querySelectorAll('[data-asset-card] .bg-accent, [data-folder-card] ~ *').length
}

async function selectWithMeta(user: ReturnType<typeof userEvent.setup>, el: HTMLElement) {
  await user.keyboard('{Meta>}')
  await user.click(el)
  await user.keyboard('{/Meta}')
}

beforeEach(() => {
  vi.clearAllMocks()
  useViewStore.setState({ layout: 'grid', flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
})

describe('navigating between folders', () => {
  it('drops the selection when currentFolderId changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )

    await selectWithMeta(user, cardFor('a-1'))
    await selectWithMeta(user, cardFor('a-2'))
    expect(selectedCount()).toBe(2)

    // Walk into folder B. Same component instance, new props.
    rerender(
      <AssetGrid assets={IN_B} projectId="p-1" projectName="Proj" currentFolderId="f-b" />,
    )

    expect(selectedCount()).toBeNull()
  })

  it('leaves no checkbox pre-ticked in the folder arrived at', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )
    await selectWithMeta(user, cardFor('a-1'))

    rerender(
      <AssetGrid assets={IN_B} projectId="p-1" projectName="Proj" currentFolderId="f-b" />,
    )

    // Nothing in B is selected — asserted through the same bar the user
    // reads, since an "empty selection" with a visible bar is the bug.
    expect(selectedCount()).toBeNull()
    expect(screen.queryByRole('button', { name: /^download$/i })).toBeNull()
  })

  it('clears a FOLDER selection too, not just assets', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} folders={FOLDERS_A} projectId="p-1" projectName="Proj"
        currentFolderId="f-a" onBulkDownload={vi.fn()} />,
    )

    await user.click(folderCheckbox('f-sub'))
    expect(selectedCount()).toBe(1)

    rerender(
      <AssetGrid assets={IN_B} folders={[]} projectId="p-1" projectName="Proj"
        currentFolderId="f-b" onBulkDownload={vi.fn()} />,
    )

    expect(selectedCount()).toBeNull()
  })

  it('clears when navigating UP to the project root (null)', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )
    await selectWithMeta(user, cardFor('a-1'))

    rerender(<AssetGrid assets={IN_B} projectId="p-1" projectName="Proj" currentFolderId={null} />)

    expect(selectedCount()).toBeNull()
  })

  it('forgets the shift-click anchor as well', async () => {
    /* §99's anchor points at an id from the folder we left. A shift-click
       in the new folder must start a fresh range, not extend from a card
       that is no longer on screen. */
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )
    await user.click(cardFor('a-1'))   // sets the anchor

    rerender(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-b" />,
    )

    await user.keyboard('{Shift>}')
    await user.click(cardFor('a-3'))
    await user.keyboard('{/Shift}')

    // With a stale anchor this would be a 3-item range (a-1..a-3).
    expect(selectedCount()).toBe(1)
  })
})

describe('switching projects without a remount', () => {
  it('drops the selection when projectId changes', async () => {
    /* Neither mount site passes key={projectId}, and the project page reads
       its id from useParams() — so /projects/A -> /projects/B reconciles
       into the SAME component instance. Same trap §29 documented one level
       up for currentFolderId itself. */
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId={null} />,
    )

    await selectWithMeta(user, cardFor('a-1'))
    expect(selectedCount()).toBe(1)

    rerender(
      <AssetGrid assets={IN_B} projectId="p-2" projectName="Other" currentFolderId={null} />,
    )

    expect(selectedCount()).toBeNull()
  })
})

describe('what must NOT be cleared', () => {
  it('survives an unrelated rerender in the same folder', async () => {
    /* The failure mode of getting the deps wrong: an effect keyed on a
       value that changes every render clears the selection constantly, and
       selecting anything becomes impossible. */
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )

    await selectWithMeta(user, cardFor('a-1'))
    await selectWithMeta(user, cardFor('a-2'))
    expect(selectedCount()).toBe(2)

    // New array identities, new callbacks — everything a parent re-render
    // hands down — but the same folder.
    rerender(
      <AssetGrid assets={[...IN_A]} projectId="p-1" projectName="Proj" currentFolderId="f-a"
        onBulkDownload={vi.fn()} onBulkDelete={vi.fn()} />,
    )

    expect(selectedCount()).toBe(2)
  })

  it('survives several such rerenders in a row', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <AssetGrid assets={IN_A} projectId="p-1" projectName="Proj" currentFolderId="f-a" />,
    )
    await selectWithMeta(user, cardFor('a-1'))

    for (let i = 0; i < 5; i++) {
      rerender(
        <AssetGrid assets={[...IN_A]} projectId="p-1" projectName="Proj" currentFolderId="f-a"
          onBulkMove={vi.fn()} />,
      )
    }

    expect(selectedCount()).toBe(1)
  })
})
