/**
 * §121 — the asset-change effect must not depend on a store function's
 * identity.
 *
 * The first version of that fix did, and any consumer whose store hook
 * returns fresh functions per render then re-ran it every render — and since
 * it sets state, that is an infinite render loop. It hung a whole test
 * worker, and vitest reports a hung worker as SKIPPED with exit code 0, so
 * nothing failed: six tests silently stopped running and the suite still
 * looked green. That is why this asserts the property directly.
 *
 * The store mock below deliberately returns new functions on every call,
 * which is the shape that triggered it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import * as React from 'react'

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) =>
      path.endsWith('/versions')
        ? Promise.resolve([])
        : Promise.resolve({ id: 'a', asset_type: 'video', latest_version: null }),
    post: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn(),
  },
}))

let renders = 0
vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => {
    renders += 1
    // Fresh identities every call — exactly what the mocked stores elsewhere
    // in this suite do, and what a selector-less hook may do in general.
    return {
      setCurrentAsset: () => {},
      setCurrentVersion: () => {},
      setPlayheadTime: () => {},
      currentVersion: null,
      isDrawingMode: false,
      focusedCommentId: null,
    }
  },
}))

import { ReviewProvider } from '../review-provider'

describe('ReviewProvider', () => {
  it('settles instead of re-rendering forever', async () => {
    renders = 0
    render(<ReviewProvider assetId="asset-1"><div data-testid="child" /></ReviewProvider>)

    await waitFor(() => expect(renders).toBeGreaterThan(0))
    const settled = renders
    await new Promise((r) => setTimeout(r, 250))

    // A loop climbs without bound in a quarter second; a settled tree adds
    // at most the handful of renders its own fetches cause.
    expect(renders - settled).toBeLessThan(20)
  }, 3000)
})
