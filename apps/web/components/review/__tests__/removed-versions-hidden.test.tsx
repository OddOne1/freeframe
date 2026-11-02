/**
 * §240b — a removed version is shown ONLY to someone who may restore it.
 *
 * The rule lives on the server: `?include_deleted=true` simply returns no
 * removed row to a caller who cannot restore it. So for an editor who did
 * not delete it, a reviewer or a viewer, `removedVersions` arrives EMPTY,
 * and what these hold is that "empty" renders exactly the pre-§241
 * dropdown — no red row, no "Removed", no leftover spacing — and that the
 * menu opens or stays a plain label for the same reasons it did before.
 *
 * There is deliberately no client-side filter to test: the switcher
 * renders whatever removed rows it is handed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const removed = (n: number): AssetVersion =>
  ({
    ...live(n),
    deleted_at: '2026-10-01T10:00:00Z',
    deleted_by_name: 'Ann Editor',
    can_restore: true,
  }) as AssetVersion

function renderSwitcher(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

/** The open menu's markup, for comparing two renders. */
async function openMenuHtml(trigger: RegExp): Promise<string> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: trigger }))
  const menu = await screen.findByRole('menu')
  return menu.innerHTML
}

beforeEach(() => {
  useReviewStore.getState().reset()
})

describe('a user the server sent no removed rows', () => {
  it('sees the same menu as before §241, with gaps in the numbers left as they are', async () => {
    const versions = [live(1), live(3)]
    useReviewStore.getState().setCurrentVersion(versions[1])

    // Pre-§241: the switcher was never given removed rows at all.
    const before = renderSwitcher(<VersionSwitcher versions={versions} />)
    const htmlBefore = await openMenuHtml(/^v3/)
    before.unmount()

    useReviewStore.getState().reset()
    useReviewStore.getState().setCurrentVersion(versions[1])
    renderSwitcher(<VersionSwitcher versions={versions} removedVersions={[]} />)
    const htmlAfter = await openMenuHtml(/^v3/)

    expect(htmlAfter).toBe(htmlBefore)
    const labels = screen.getAllByRole('menuitem').map((r) => r.textContent ?? '')
    expect(labels.map((t) => t.slice(0, 2))).toEqual(['v1', 'v3'])
    expect(screen.queryByText(/removed/i)).toBeNull()
    expect(screen.queryByTestId(/^removed-version-/)).toBeNull()
    expect(screen.queryByTestId(/^restore-version-/)).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('with one live version and nothing to delete, has no menu at all', async () => {
    const versions = [live(3)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    renderSwitcher(<VersionSwitcher versions={versions} removedVersions={[]} />)

    const trigger = screen.getByRole('button', { name: /^v3/ })
    // No chevron: the trigger is a plain label, as before §241.
    expect(trigger.querySelector('svg')).toBeNull()
    await userEvent.setup().click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('with one live version it may delete, still gets the only-version notice', async () => {
    const versions = [live(3)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[]}
        onDeleteVersion={async () => {}}
        canDeleteVersion={() => true}
      />,
    )
    await openMenuHtml(/^v3/)
    expect(screen.getByText(/only version/i)).toBeInTheDocument()
    expect(screen.queryByTestId(/^removed-version-/)).toBeNull()
  })
})

describe('a user who may restore it', () => {
  it('with one live version, the removed row still opens the menu, with Restore', async () => {
    const versions = [live(3)]
    useReviewStore.getState().setCurrentVersion(versions[0])
    renderSwitcher(
      <VersionSwitcher
        versions={versions}
        removedVersions={[removed(2)]}
        onRestoreVersion={async () => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: /^v3/ })
    expect(trigger.querySelector('svg')).not.toBeNull()
    await openMenuHtml(/^v3/)
    expect(screen.getByTestId('removed-version-2')).toHaveTextContent(/removed by ann editor/i)
    expect(screen.getByTestId('restore-version-2')).toBeInTheDocument()
  })
})
