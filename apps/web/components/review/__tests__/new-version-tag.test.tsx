/**
 * §242 — what the switcher does with the "new" set it is handed.
 *
 * The component decides nothing about WHICH versions are new (that is
 * `useLiveVersions`, and hooks/__tests__/use-live-versions.test.tsx holds
 * it). What it owns is the markup, and two mistakes are easy to make here:
 * tagging every row instead of the named ones, and changing the trigger for
 * callers that pass no set at all — share mode, and every other switcher in
 * the app.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReviewStore } from '@/stores/review-store'
import { VersionSwitcher } from '../version-switcher'
import type { AssetVersion } from '@/types'

const version = (n: number): AssetVersion =>
  ({
    id: `ver-${n}`,
    asset_id: 'a1',
    version_number: n,
    processing_status: 'ready',
    failure_stage: null,
    created_by: 'someone',
    created_at: '2026-10-28T09:00:00Z',
    deleted_at: null,
    files: [],
  }) as AssetVersion

const versions = [version(7), version(8), version(9)]

beforeEach(() => {
  useReviewStore.getState().reset()
  useReviewStore.getState().setCurrentVersion(versions[0])
})

describe('VersionSwitcher’s new-version markup', () => {
  it('renders nothing new when the caller passes no set', async () => {
    const user = userEvent.setup()
    render(<VersionSwitcher versions={versions} />)

    expect(screen.queryByTestId('new-version-dot')).not.toBeInTheDocument()
    // The trigger still reads exactly as it did — the switcher is queried
    // by that name across the suite.
    await user.click(screen.getByRole('button', { name: /^v7/ }))
    expect(screen.queryByTestId('new-version-tag-8')).not.toBeInTheDocument()
    expect(screen.queryByTestId('new-version-tag-9')).not.toBeInTheDocument()
  })

  it('tags only the rows it was given, and names the newest on the trigger', async () => {
    const user = userEvent.setup()
    render(<VersionSwitcher versions={versions} newVersionIds={new Set(['ver-8', 'ver-9'])} />)

    expect(screen.getByTestId('new-version-dot')).toHaveAttribute(
      'aria-label',
      'New version v9 available',
    )

    await user.click(screen.getByRole('button', { name: /^v7/ }))
    expect(await screen.findByTestId('new-version-tag-8')).toBeInTheDocument()
    expect(screen.getByTestId('new-version-tag-9')).toBeInTheDocument()
    // v7 was there all along.
    expect(screen.queryByTestId('new-version-tag-7')).not.toBeInTheDocument()
  })

  it('still shows the row’s live status beside the tag (§238 labels intact)', async () => {
    const user = userEvent.setup()
    const uploading = {
      ...version(9),
      processing_status: 'uploading' as AssetVersion['processing_status'],
    }
    render(
      <VersionSwitcher
        versions={[versions[0], uploading]}
        newVersionIds={new Set(['ver-8'])}
      />,
    )

    await user.click(screen.getByRole('button', { name: /^v7/ }))
    expect(await screen.findByText('Uploading')).toBeInTheDocument()
    expect(screen.getByText('DONE')).toBeInTheDocument()
  })
})
