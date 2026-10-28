/**
 * §241 item 1/2 — a REMOVED version stays in the version list, and the
 * three people who may bring it back are offered a Restore.
 *
 * What these hold:
 *
 *  * the removed row is LISTED, in red, with the word "Removed", in its
 *    numeric place — a deleted v2 between v1 and v3, not appended;
 *  * it is NOT selectable: `disabled`, so neither a click nor an arrow key
 *    can make a version with no media (the server empties `files` for a
 *    deleted row) the current one;
 *  * Restore appears only where the SERVER set `can_restore`. The uploader
 *    of a version who did not delete it is refused by §240, so a rule
 *    derived from `created_by` here would offer a button that 403s;
 *  * who removed it is printed only when the server sent a name — a
 *    reviewer is told the version was removed, not by whom;
 *  * success and failure both report, and a 409 `storage_limit` shows the
 *    server's own sentence rather than a generic error.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { ToastProvider } from '@/components/shared/toast'
import { useReviewStore } from '@/stores/review-store'
import { VersionSwitcher } from '../version-switcher'
import type { AssetVersion } from '@/types'

const live = (n: number): AssetVersion =>
  ({
    id: `v-${n}`,
    asset_id: 'a1',
    version_number: n,
    processing_status: 'ready',
    created_by: 'user-me',
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    files: [],
  }) as AssetVersion

const removed = (
  n: number,
  opts: { canRestore?: boolean; who?: string | null } = {},
): AssetVersion =>
  ({
    id: `v-${n}`,
    asset_id: 'a1',
    version_number: n,
    processing_status: 'ready',
    created_by: 'user-me',
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: '2026-10-01T10:00:00Z',
    deleted_by_name: opts.who ?? null,
    can_restore: opts.canRestore ?? false,
    files: [],
  }) as AssetVersion

function renderSwitcher(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

beforeEach(() => {
  useReviewStore.getState().reset()
})

describe('a removed version in the list', () => {
  it('is listed, in red, as Removed, and is not selectable', async () => {
    const user = userEvent.setup()
    const versions = [live(1), live(3)]
    useReviewStore.getState().setCurrentVersion(versions[1])

    renderSwitcher(
      <VersionSwitcher versions={versions} removedVersions={[removed(2)]} />,
    )

    await user.click(screen.getByRole('button', { name: /^v3/ }))
    const row = await screen.findByTestId('removed-version-2')
    expect(row).toBeInTheDocument()
    expect(row).toHaveTextContent(/removed/i)
    expect(row).toHaveTextContent('v2')

    const item = row.querySelector('[role="menuitem"]') as HTMLElement
    expect(item).toHaveAttribute('data-disabled')
    expect(item.className).toMatch(/text-status-error/)

    // Clicking it changes nothing: v3 is still the current version.
    await user.click(item)
    expect(useReviewStore.getState().currentVersion?.version_number).toBe(3)
  })

  it('sits in its numeric place, not at the end', async () => {
    const user = userEvent.setup()
    const versions = [live(1), live(3)]
    useReviewStore.getState().setCurrentVersion(versions[1])

    renderSwitcher(
      <VersionSwitcher versions={versions} removedVersions={[removed(2)]} />,
    )
    await user.click(screen.getByRole('button', { name: /^v3/ }))

    const rows = await screen.findAllByRole('menuitem')
    const labels = rows.map((r) => r.textContent ?? '')
    const v1 = labels.findIndex((t) => t.startsWith('v1'))
    const v2 = labels.findIndex((t) => t.startsWith('v2'))
    const v3 = labels.findIndex((t) => t.startsWith('v3'))
    expect(v1).toBeLessThan(v2)
    expect(v2).toBeLessThan(v3)
  })

  it('carries no media: a removed row offers nothing to play', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])

    renderSwitcher(
      <VersionSwitcher versions={versions} removedVersions={[removed(2)]} />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    const row = await screen.findByTestId('removed-version-2')

    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('video')).toBeNull()
    // Nor a status label: "DONE" on a version that is gone is a lie.
    expect(row).not.toHaveTextContent(/DONE/)
  })

  it('shows who removed it when the server said, and not when it did not', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])

    const { unmount } = renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2, { who: 'Mathias' })]}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    expect(await screen.findByTestId('removed-version-2')).toHaveTextContent(
      /Removed by Mathias/,
    )
    unmount()

    renderSwitcher(<VersionSwitcher versions={versions} removedVersions={[removed(2)]} />)
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    expect(await screen.findByTestId('removed-version-2')).not.toHaveTextContent(
      /Removed by/,
    )
  })

  it('opens the menu for a removed version even with one live version left', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])

    renderSwitcher(<VersionSwitcher versions={versions} removedVersions={[removed(2)]} />)
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    expect(await screen.findByTestId('removed-version-2')).toBeInTheDocument()
  })
})

describe('Restore on a removed version', () => {
  it('is offered only where the server set can_restore', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])

    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[
          removed(2, { canRestore: true }),
          removed(3, { canRestore: false }),
        ]}
        onRestoreVersion={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))

    expect(await screen.findByTestId('restore-version-2')).toBeInTheDocument()
    expect(screen.queryByTestId('restore-version-3')).not.toBeInTheDocument()
  })

  it('is not offered at all without a handler (share mode, a viewer)', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])

    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2, { canRestore: true })]}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await screen.findByTestId('removed-version-2')
    expect(screen.queryByTestId('restore-version-2')).not.toBeInTheDocument()
  })

  it('restores on a single click and says so', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    const onRestore = vi.fn().mockResolvedValue(undefined)

    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2, { canRestore: true })]}
        onRestoreVersion={onRestore}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('restore-version-2'))

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(onRestore.mock.calls[0][0].id).toBe('v-2')
    // No confirm dialog in the way: it is reversible and cheap.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('v2 restored')).toBeInTheDocument()
  })

  it('shows the server’s sentence when the storage limit blocks it', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    const limit = new Error(
      'Restoring this version would exceed the storage limit. Free up space and try again.',
    )
    const onRestore = vi.fn().mockRejectedValue(limit)

    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2, { canRestore: true })]}
        onRestoreVersion={onRestore}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('restore-version-2'))

    expect(await screen.findByText(/exceed the storage limit/i)).toBeInTheDocument()
    expect(screen.queryByText('v2 restored')).not.toBeInTheDocument()
  })

  it('falls back to its own words when the failure carries none', async () => {
    const user = userEvent.setup()
    const versions = [live(1)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    const onRestore = vi.fn().mockRejectedValue(new Error(''))

    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2, { canRestore: true })]}
        onRestoreVersion={onRestore}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('restore-version-2'))

    expect(await screen.findByText(/Could not restore this version/i)).toBeInTheDocument()
  })
})
