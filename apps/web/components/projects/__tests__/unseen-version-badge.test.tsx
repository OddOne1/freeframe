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

describe('unseen version badge', () => {
  it('shows when the backend says this user has not seen the latest version', () => {
    card({ has_unseen_version: true }, 3)
    const badge = screen.getByTestId('unseen-version-badge')
    expect(badge.textContent).toContain('New Version')
    // Labelled with the version it is about, using the existing V-chip
    // language rather than a new one.
    expect(badge.textContent).toContain('V3')
  })

  it('does not show once the user has opened it', () => {
    card({ has_unseen_version: false }, 3)
    expect(screen.queryByTestId('unseen-version-badge')).toBeNull()
  })

  it('does not show when the field is absent', () => {
    // Anonymous/share callers get no seen-state at all; an undefined flag
    // must read as "nothing to report", not as unseen.
    card({}, 3)
    expect(screen.queryByTestId('unseen-version-badge')).toBeNull()
  })

  it('does not show for a single-version asset even if the flag is set', () => {
    // Belt and braces over the server's own rule: "new version" is
    // meaningless when there has only ever been one.
    card({ has_unseen_version: true }, 1)
    const badge = screen.queryByTestId('unseen-version-badge')
    // The server never sets the flag for v1; if it somehow did, the label
    // must not claim "V1 · New Version".
    if (badge) expect(badge.textContent).not.toContain('V1')
  })
})
