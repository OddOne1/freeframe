/**
 * §238 — the version dropdown tells the two kinds of failure apart.
 *
 * The owner's v6 read a red **Failed**, which sent him looking for a
 * processing problem that did not exist. The server now says which stage
 * failed, and the dropdown says it in the user's language:
 *
 *   failure_stage: "upload"      → amber "Upload incomplete"
 *   failure_stage: "processing"  → red "Failed", exactly as before
 *
 * The delete confirmation differs for the same reason: an incomplete
 * upload has no comments to hide and its number comes BACK, so the §239
 * sentence would be false in both halves.
 *
 * `failure_stage` is read, never derived: a test that built it from
 * `processing_status` here would pass against a client that guessed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { useReviewStore } from '@/stores/review-store'
import { VersionSwitcher, versionStatusFor } from '../version-switcher'
import type { AssetVersion } from '@/types'

const ME = 'user-me'

const version = (
  n: number,
  status = 'ready',
  failureStage: AssetVersion['failure_stage'] = null,
): AssetVersion =>
  ({
    id: `v-${n}`,
    asset_id: 'a1',
    version_number: n,
    processing_status: status,
    failure_stage: failureStage,
    created_by: ME,
    created_at: '2026-10-26T00:00:00Z',
    deleted_at: null,
    files: [],
  }) as AssetVersion

const mine = () => true

beforeEach(() => {
  useReviewStore.getState().reset()
})

describe('the label', () => {
  it('an incomplete upload is "Upload incomplete", not "Failed"', async () => {
    const user = userEvent.setup()
    const versions = [version(1), version(2, 'failed', 'upload')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))

    expect(await screen.findByText('Upload incomplete')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
  })

  it('a processing failure is still a red "Failed"', async () => {
    const user = userEvent.setup()
    const versions = [version(1), version(2, 'failed', 'processing')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))

    expect(await screen.findByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('Upload incomplete')).not.toBeInTheDocument()
  })

  it('an api that does not send the field yet behaves exactly as before', async () => {
    // A rolling deploy: a rebuilt web container talking to an api that
    // predates §238. `failure_stage` is absent, nothing is treated as an
    // upload failure, and the old red label is what shows.
    const user = userEvent.setup()
    const legacy = { ...version(2, 'failed') } as AssetVersion
    delete (legacy as { failure_stage?: unknown }).failure_stage
    const versions = [version(1), legacy]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(<VersionSwitcher versions={versions} />)
    await user.click(screen.getByRole('button', { name: /^v1/ }))

    expect(await screen.findByText('Failed')).toBeInTheDocument()
  })

  it('the helper is what both the switcher and the compare picker read', () => {
    // One function, so the two menus cannot drift apart about what a
    // version is called.
    expect(versionStatusFor(version(2, 'failed', 'upload')).label).toBe('Upload incomplete')
    expect(versionStatusFor(version(2, 'failed', 'processing')).label).toBe('Failed')
    expect(versionStatusFor(version(2, 'ready')).label).toBe('DONE')
    expect(versionStatusFor(version(2, 'uploading')).label).toBe('Uploading')
    expect(versionStatusFor(version(2, 'processing')).label).toBe('Processing')
    // Amber, not red — the point of the whole distinction.
    expect(versionStatusFor(version(2, 'failed', 'upload')).className).not.toContain(
      'error',
    )
  })
})

describe('deleting it from the menu', () => {
  it('says the number comes back, and does not claim comments are hidden', async () => {
    const user = userEvent.setup()
    const versions = [version(1), version(2, 'failed', 'upload')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('delete-version-2'))

    expect(await screen.findByText(/Delete v2\?/)).toBeInTheDocument()
    expect(screen.getByText(/never fully uploaded/i)).toBeInTheDocument()
    expect(screen.getByText(/frees v2/i)).toBeInTheDocument()
    expect(screen.queryByText(/will be hidden from this file/i)).not.toBeInTheDocument()
  })

  it('a processing failure keeps §239’s wording', async () => {
    const user = userEvent.setup()
    const versions = [version(1), version(2, 'failed', 'processing')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('delete-version-2'))

    expect(await screen.findByText(/will be hidden from this file/i)).toBeInTheDocument()
    expect(screen.queryByText(/frees v2/i)).not.toBeInTheDocument()
  })

  it('calls the page’s own delete, which is the §239 route', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => {})
    const versions = [version(1), version(2, 'failed', 'upload')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={onDelete}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('delete-version-2'))
    await user.click(screen.getByRole('button', { name: /^Delete version$/ }))

    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'v-2', failure_stage: 'upload' }),
    )
  })

  it('a refusal from the server is shown in the dialog', async () => {
    // The 409 §238 answers when the store still holds an object at the
    // key: it is not an empty shell, and nothing was deleted.
    const user = userEvent.setup()
    const onDelete = vi.fn(async () => {
      throw new Error('Storage still holds this version’s file')
    })
    const versions = [version(1), version(2, 'failed', 'upload')]
    useReviewStore.getState().setCurrentVersion(versions[0])

    render(
      <VersionSwitcher
        versions={versions}
        canDeleteVersion={mine}
        onDeleteVersion={onDelete}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^v1/ }))
    await user.click(await screen.findByTestId('delete-version-2'))
    await user.click(screen.getByRole('button', { name: /^Delete version$/ }))

    expect(await screen.findByText(/Storage still holds/i)).toBeInTheDocument()
  })
})
