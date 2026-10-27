/**
 * §239 — deleting ONE version from the version selector.
 *
 * What these hold:
 *
 *  * the delete control appears per VERSION, not per page. An editor who
 *    uploaded v2 is offered it on v2 and not on a colleague's v1 — the
 *    rule `canRetryProcessing` uses, asked once per row;
 *  * the LAST remaining version keeps the control, disabled, with the
 *    reason spelled out. Removing it instead leaves "why is there no
 *    option here" unanswered, and the server's own 409 says the same
 *    thing;
 *  * the dialog names the version, says the comments go with it, and says
 *    the app cannot undo it. All three are in the copy because none of
 *    them is recoverable from the UI;
 *  * a refusal from the server is SHOWN, in the dialog, which stays open.
 *    A 403/404/409 must not look like a success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { useReviewStore } from '@/stores/review-store'
import { VersionSwitcher } from '../version-switcher'
import type { AssetVersion } from '@/types'

const version = (n: number, createdBy: string, status = 'ready'): AssetVersion =>
  ({
    id: `v-${n}`,
    asset_id: 'a1',
    version_number: n,
    processing_status: status,
    created_by: createdBy,
    created_at: '2026-01-0{n}T00:00:00Z',
    deleted_at: null,
    files: [],
  }) as AssetVersion

const ME = 'user-me'
const COLLEAGUE = 'user-them'

/** The page's own rule: the uploader, the project owner, or a superadmin. */
const uploaderOnly = (v: AssetVersion) => v.created_by === ME

function open(ui: React.ReactElement) {
  return render(ui)
}

beforeEach(() => {
  useReviewStore.getState().reset()
})

describe('VersionSwitcher delete', () => {
  it('offers delete on my own version and not on a colleague’s', async () => {
    const user = userEvent.setup()
    const versions = [version(1, COLLEAGUE), version(2, ME)]
    useReviewStore.getState().setCurrentVersion(versions[1])

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v2/ }))

    expect(await screen.findByTestId('delete-version-2')).toBeInTheDocument()
    expect(screen.queryByTestId('delete-version-1')).not.toBeInTheDocument()
  })

  it('renders no delete control at all when the caller offers none', async () => {
    const user = userEvent.setup()
    const versions = [version(1, COLLEAGUE), version(2, COLLEAGUE)]
    useReviewStore.getState().setCurrentVersion(versions[1])

    open(<VersionSwitcher versions={versions} />)

    await user.click(screen.getByRole('button', { name: /^v2/ }))
    await waitFor(() => expect(screen.getByText('v1')).toBeInTheDocument())
    expect(screen.queryByTestId('delete-version-2')).not.toBeInTheDocument()
  })

  it('disables delete on the only version and says why', async () => {
    const user = userEvent.setup()
    const versions = [version(1, ME)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    const onDelete = vi.fn()

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={onDelete}
      />,
    )

    // The menu opens even with a single version, which it did not before:
    // otherwise the explanation has nowhere to live.
    await user.click(screen.getByRole('button', { name: /^v1/ }))

    const item = await screen.findByTestId('delete-version-1')
    expect(item).toHaveAttribute('data-disabled')
    expect(screen.getByText(/only version/i)).toBeInTheDocument()

    await user.click(item)
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument()
  })

  it('disables delete while the version is still uploading or processing', async () => {
    const user = userEvent.setup()
    const versions = [version(1, ME), version(2, ME, 'processing')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v1/ }))
    const item = await screen.findByTestId('delete-version-2')
    expect(item).toHaveAttribute('data-disabled')
    expect(item).toHaveAttribute('title', expect.stringMatching(/uploading or processing/i))
  })

  it('confirms with the version number, the comments and the undo warning', async () => {
    const user = userEvent.setup()
    const versions = [version(1, ME), version(2, ME)]
    useReviewStore.getState().setCurrentVersion(versions[1])
    const onDelete = vi.fn().mockResolvedValue(undefined)

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v2/ }))
    await user.click(await screen.findByTestId('delete-version-2'))

    expect(await screen.findByText('Delete v2?')).toBeInTheDocument()
    expect(screen.getByText(/comments, annotations and approvals/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /delete version/i }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1))
    expect(onDelete.mock.calls[0][0].id).toBe('v-2')
  })

  it('shows the server’s refusal and keeps the dialog open', async () => {
    const user = userEvent.setup()
    const versions = [version(1, ME), version(2, ME)]
    useReviewStore.getState().setCurrentVersion(versions[1])
    const onDelete = vi
      .fn()
      .mockRejectedValue(new Error('This is the only version of this file.'))

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v2/ }))
    await user.click(await screen.findByTestId('delete-version-2'))
    await user.click(screen.getByRole('button', { name: /delete version/i }))

    expect(
      await screen.findByText('This is the only version of this file.'),
    ).toBeInTheDocument()
    // Still open: nothing happened, and the dialog is where it says so.
    expect(screen.getByText('Delete v2?')).toBeInTheDocument()
  })

  it('still switches version when the row itself is clicked', async () => {
    const user = userEvent.setup()
    const versions = [version(1, ME), version(2, ME)]
    useReviewStore.getState().setCurrentVersion(versions[1])
    const onDelete = vi.fn()

    open(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={uploaderOnly}
        onDeleteVersion={onDelete}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v2/ }))
    await user.click(await screen.findByText('v1'))

    await waitFor(() =>
      expect(useReviewStore.getState().currentVersion?.id).toBe('v-1'),
    )
    expect(onDelete).not.toHaveBeenCalled()
  })
})
