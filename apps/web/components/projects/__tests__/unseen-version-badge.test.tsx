/**
 * The unseen-new-version badge on the asset card (CLAUDE.md §108).
 *
 * The badge makes a claim about the reader ("you have not opened this"), so
 * the cases that matter are the ones where it must NOT appear: a
 * single-version asset, and an asset this user has already opened. A badge
 * that shows on everything says nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssetCard } from '../asset-card'
import type { Asset } from '@/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/stores/view-store', () => ({ useViewStore: () => ({ layout: 'grid', cardSize: 'm' }) }))

const base = {
  id: 'a1', project_id: 'p1', name: 'clip.mov', asset_type: 'video',
  status: 'in_review', created_at: new Date().toISOString(),
} as unknown as Asset

const card = (overrides: Partial<Asset>, versionCount = 2) =>
  render(<AssetCard asset={{ ...base, ...overrides } as Asset} projectId="p1" versionCount={versionCount} />)

describe('version badge', () => {
  const badge = () => screen.queryByTestId('unseen-version-badge')

  it('stays visible after the asset has been seen, showing the plain version', () => {
    // THE BUG (§111): the whole element was gated on has_unseen_version, so
    // opening an asset removed the version indicator from the card entirely.
    card({ has_unseen_version: false }, 3)
    expect(badge()).toBeTruthy()
    expect(badge()!.textContent).toContain('V3')
    expect(badge()!.textContent).not.toContain('New Version')
    expect(badge()!.dataset.unseen).toBe('false')
  })

  it('is the SAME element when unseen, expanded — not a second one', () => {
    // "size varies by state", not two components: one testid, one node.
    card({ has_unseen_version: true }, 3)
    expect(screen.getAllByTestId('unseen-version-badge')).toHaveLength(1)
    expect(badge()!.textContent).toContain('V3')
    expect(badge()!.textContent).toContain('New Version')
    expect(badge()!.dataset.unseen).toBe('true')
  })

  it('does not render at all for a single-version asset', () => {
    card({ has_unseen_version: false }, 1)
    expect(badge()).toBeNull()
    // Even if the flag were somehow set — "V1 · New Version" is nonsense.
    card({ has_unseen_version: true }, 1)
    expect(screen.queryAllByTestId('unseen-version-badge')).toHaveLength(0)
  })

  it('treats an absent flag as seen rather than unseen', () => {
    // Anonymous/share callers get no seen-state; undefined must not read as
    // "new".
    card({}, 2)
    expect(badge()!.dataset.unseen).toBe('false')
    expect(badge()!.textContent).not.toContain('New Version')
  })

  it('sits at the bottom of the thumbnail, beside the comment count', () => {
    // Moved off the top strip, which it shared with the star rating: the wide
    // "New Version" text crowded the rating chip on narrow cards.
    card({ has_unseen_version: true }, 2)
    const row = badge()!.parentElement as HTMLElement
    expect(row.className).toContain('bottom-2')
    expect(row.className).toContain('left-2')
    expect(row.className).not.toContain('top-2')
  })

  it('keeps the version number readable when the label is suppressed', () => {
    // Below ~200px of card the label is hidden by a container query, so the
    // number — the part that must always be legible — is NOT inside it.
    card({ has_unseen_version: true }, 4)
    const label = badge()!.querySelector('.version-badge-label') as HTMLElement
    expect(label).toBeTruthy()
    expect(label.textContent).toContain('New Version')
    expect(label.textContent).not.toContain('V4')
    expect(badge()!.textContent).toContain('V4')
  })
})
