/**
 * §121 — a version from one asset must never be paired with another asset.
 *
 * The reported symptom was GET /assets/{id}/transcript?version_id=... 404ing,
 * with an asset id and a version id that belong to two DIFFERENT assets. The
 * endpoint was right to refuse: that version really is not that asset's.
 *
 * The window is in the provider. currentVersion lives in a global store, and
 * fetchAsset sets the new asset a full network round trip before it can set
 * the new version — it has to fetch /assets/{id}/versions in between. For the
 * whole of that round trip the app held the NEW asset next to the OLD
 * asset's version, and every consumer builds a request out of that pair:
 * transcript, stream, comments, approvals.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { useReviewStore } from '@/stores/review-store'

const requests: string[] = []
let resolveVersions!: (v: unknown) => void

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => {
      requests.push(path)
      if (path.endsWith('/versions')) {
        // Held open, so the test can inspect the exact window the bug lived in.
        return new Promise((r) => { resolveVersions = r })
      }
      if (path.startsWith('/assets/') && path.includes('/comments')) return Promise.resolve([])
      return Promise.resolve({
        id: path.replace('/assets/', ''),
        asset_type: 'video',
        latest_version: { id: 'v-new', version_number: 2, processing_status: 'ready' },
      })
    },
    post: vi.fn(),
  },
}))
vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveApiMediaUrl: (u: string | null) => u,
}))

import { ReviewProvider } from '../review-provider'

beforeEach(() => {
  requests.length = 0
  useReviewStore.setState({
    currentVersion: { id: 'v-OLD-asset', version_number: 1 } as never,
  })
})

describe('navigating from one asset to another', () => {
  it('clears the previous asset’s version before the new asset loads', async () => {
    render(<ReviewProvider assetId="asset-NEW"><div /></ReviewProvider>)

    // The instant the provider mounts for a different asset, the stale
    // version must be gone — this is the whole fix.
    await waitFor(() => {
      expect(useReviewStore.getState().currentVersion).toBeNull()
    })
  })

  it('never pairs the new asset with the old version in a request', async () => {
    render(<ReviewProvider assetId="asset-NEW"><div /></ReviewProvider>)
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    // Nothing may carry the previous asset's version id.
    expect(requests.some((r) => r.includes('v-OLD-asset'))).toBe(false)
  })

  it('clears again when the route changes asset WITHOUT a remount', async () => {
    // The real navigation: same page component, new assetId. An effect that
    // is not keyed on assetId runs once on mount and never again, so the
    // stale version survives exactly the transition this exists to stop.
    const { rerender } = render(
      <ReviewProvider assetId="asset-ONE"><div /></ReviewProvider>,
    )
    await waitFor(() => expect(resolveVersions).toBeDefined())
    resolveVersions([{ id: 'v-one', version_number: 1, processing_status: 'ready' }])
    await waitFor(() => {
      expect(useReviewStore.getState().currentVersion?.id).toBe('v-one')
    })

    rerender(<ReviewProvider assetId="asset-TWO"><div /></ReviewProvider>)

    await waitFor(() => {
      expect(useReviewStore.getState().currentVersion).toBeNull()
    })
  })

  it('adopts the new asset’s version once it actually arrives', async () => {
    render(<ReviewProvider assetId="asset-NEW"><div /></ReviewProvider>)
    await waitFor(() => expect(resolveVersions).toBeDefined())

    resolveVersions([{ id: 'v-new', version_number: 2, processing_status: 'ready' }])

    await waitFor(() => {
      expect(useReviewStore.getState().currentVersion?.id).toBe('v-new')
    })
  })
})

describe('the store', () => {
  it('accepts null, so the clear is expressible at all', () => {
    // The setter was typed to take an AssetVersion only, while the state it
    // writes has always been nullable.
    useReviewStore.getState().setCurrentVersion(null)
    expect(useReviewStore.getState().currentVersion).toBeNull()
  })
})
