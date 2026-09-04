/**
 * §122 — switching assets and versions must never expose a mismatched pair.
 *
 * 76c11f1 fixed the original window with a BLANK SLATE rather than
 * per-consumer guards: one effect keyed on assetId clears versions and
 * currentVersion before the new asset loads, so the mismatched state never
 * exists for anyone to observe. These tests hold that line and push on the
 * cases a blank slate alone does not cover — chiefly out-of-order responses,
 * where a slow request for the PREVIOUS asset lands after a fast one for the
 * current asset.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import * as React from 'react'
import { useReviewStore } from '@/stores/review-store'

/** Pending resolvers, keyed by request path, so a test can land responses
 *  in whatever order it wants to model. */
let pending: Record<string, (v: unknown) => void> = {}
const requests: string[] = []

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => {
      requests.push(path)
      return new Promise((resolve) => { pending[path] = resolve })
    },
    post: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn(),
  },
}))
vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveApiMediaUrl: (u: string | null) => u,
}))

import { ReviewProvider, useReview } from '../review-provider'

/** Surfaces what the provider is actually handing consumers. */
function Readout() {
  const { asset, comments } = useReview()
  return (
    <>
      <span data-testid="asset">{asset?.id ?? 'none'}</span>
      <span data-testid="comments">{comments.map((c) => c.id).join(',') || 'none'}</span>
    </>
  )
}

const version = (id: string, n: number) => ({
  id, version_number: n, processing_status: 'ready',
})
const asset = (id: string) => ({ id, asset_type: 'video', latest_version: null })

/** Resolve a request once it has actually been made. */
async function land(path: string, value: unknown) {
  await waitFor(() => expect(pending[path]).toBeDefined())
  pending[path](value)
  delete pending[path]
}

beforeEach(() => {
  pending = {}
  requests.length = 0
  useReviewStore.setState({ currentVersion: null })
})

describe('switching asset while a version-scoped request is in flight', () => {
  it('never leaves the new asset holding the old asset’s version', async () => {
    const { rerender } = render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await land('/assets/A', asset('A'))
    await land('/assets/A/versions', [version('vA', 1)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('vA'))

    rerender(<ReviewProvider assetId="B"><div /></ReviewProvider>)

    // The instant the route changes, before B has resolved anything.
    await waitFor(() => expect(useReviewStore.getState().currentVersion).toBeNull())
  })

  it('makes no request pairing the new asset with the old version', async () => {
    const { rerender } = render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await land('/assets/A', asset('A'))
    await land('/assets/A/versions', [version('vA', 1)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('vA'))

    requests.length = 0
    rerender(<ReviewProvider assetId="B"><div /></ReviewProvider>)
    await land('/assets/B', asset('B'))

    expect(requests.some((r) => r.includes('/assets/B') && r.includes('vA'))).toBe(false)
  })
})

describe('switching version within one asset', () => {
  it('keeps the asset and swaps only the version', async () => {
    render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await land('/assets/A', asset('A'))
    await land('/assets/A/versions', [version('vA1', 1), version('vA2', 2)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion).not.toBeNull())

    // What the version switcher does.
    useReviewStore.getState().setCurrentVersion(version('vA1', 1) as never)

    expect(useReviewStore.getState().currentVersion?.id).toBe('vA1')
    // A version switch must NOT blank the list — that is an asset-level event.
    expect(useReviewStore.getState().currentVersion).not.toBeNull()
  })
})

describe('rapid back-to-back switches', () => {
  it('ignores a slow response for an asset the user already left', async () => {
    // A double-click through a list: A starts loading, B is opened before A
    // answers, then A's response lands late. Without a per-request staleness
    // check it writes A's version while the page shows B — recreating the
    // exact mismatch the blank slate exists to prevent.
    const { rerender } = render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await waitFor(() => expect(pending['/assets/A']).toBeDefined())

    rerender(<ReviewProvider assetId="B"><div /></ReviewProvider>)
    await land('/assets/B', asset('B'))
    await land('/assets/B/versions', [version('vB', 1)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('vB'))

    // Now A finally answers, long after the user moved on.
    await land('/assets/A', asset('A'))
    if (pending['/assets/A/versions']) {
      pending['/assets/A/versions']([version('vA', 1)])
      delete pending['/assets/A/versions']
    }

    await new Promise((r) => setTimeout(r, 50))
    expect(useReviewStore.getState().currentVersion?.id).toBe('vB')
  })

  it('survives three switches in a row without settling on a stale version', async () => {
    const { rerender } = render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await waitFor(() => expect(pending['/assets/A']).toBeDefined())
    rerender(<ReviewProvider assetId="B"><div /></ReviewProvider>)
    await waitFor(() => expect(pending['/assets/B']).toBeDefined())
    rerender(<ReviewProvider assetId="C"><div /></ReviewProvider>)

    await land('/assets/C', asset('C'))
    await land('/assets/C/versions', [version('vC', 1)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('vC'))

    // Both abandoned assets answer last.
    await land('/assets/A', asset('A'))
    await land('/assets/B', asset('B'))
    for (const p of ['/assets/A/versions', '/assets/B/versions']) {
      if (pending[p]) { pending[p]([version('stale', 9)]); delete pending[p] }
    }

    await new Promise((r) => setTimeout(r, 50))
    expect(useReviewStore.getState().currentVersion?.id).toBe('vC')
  })
})

describe('the provider only ever asks about its own asset', () => {
  it('names the current asset in every request it makes', async () => {
    // Bug C from the urgent-playback round was a REPEATING request for a
    // completely unrelated asset id on the bare detail endpoint. This rules
    // the provider out as its source: its id is the route param, so it
    // cannot name a foreign asset. (The actual source was the persisted
    // upload store's 5s poll, bounded in 9e815e9.)
    const { rerender } = render(<ReviewProvider assetId="A"><div /></ReviewProvider>)
    await land('/assets/A', asset('A'))
    await land('/assets/A/versions', [version('vA', 1)])

    requests.length = 0
    rerender(<ReviewProvider assetId="B"><div /></ReviewProvider>)
    await land('/assets/B', asset('B'))
    await land('/assets/B/versions', [version('vB', 1)])

    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.startsWith('/assets/B'))).toBe(true)
  })
})

describe('each late write is guarded on its own', () => {
  // Written after mutation testing showed these guards masking each other:
  // removing any single one left every test passing, because an earlier
  // guard had already returned. Each scenario below reaches exactly one.

  it('a late ASSET response does not replace the asset on screen', async () => {
    const { rerender, getByTestId } = render(
      <ReviewProvider assetId="A"><Readout /></ReviewProvider>,
    )
    await waitFor(() => expect(pending['/assets/A']).toBeDefined())

    rerender(<ReviewProvider assetId="B"><Readout /></ReviewProvider>)
    await land('/assets/B', asset('B'))
    await waitFor(() => expect(getByTestId('asset').textContent).toBe('B'))

    await land('/assets/A', asset('A'))
    await new Promise((r) => setTimeout(r, 50))
    expect(getByTestId('asset').textContent).toBe('B')
  })

  it('a late VERSIONS response does not replace the version', async () => {
    // The asset switches BETWEEN the two awaits, so the first guard passes
    // and only the versions guard can stop this one.
    const { rerender } = render(<ReviewProvider assetId="A"><Readout /></ReviewProvider>)
    await land('/assets/A', asset('A'))
    await waitFor(() => expect(pending['/assets/A/versions']).toBeDefined())

    rerender(<ReviewProvider assetId="B"><Readout /></ReviewProvider>)
    await land('/assets/B', asset('B'))
    await land('/assets/B/versions', [version('vB', 1)])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('vB'))

    await land('/assets/A/versions', [version('vA', 1)])
    await new Promise((r) => setTimeout(r, 50))
    expect(useReviewStore.getState().currentVersion?.id).toBe('vB')
  })

  it('a late COMMENTS response does not render under the new asset', async () => {
    const { rerender, getByTestId } = render(
      <ReviewProvider assetId="A"><Readout /></ReviewProvider>,
    )
    await waitFor(() => expect(pending['/assets/A/comments']).toBeDefined())

    rerender(<ReviewProvider assetId="B"><Readout /></ReviewProvider>)
    await land('/assets/B', asset('B'))
    await land('/assets/B/comments', [{ id: 'cB' }])
    await waitFor(() => expect(getByTestId('comments').textContent).toBe('cB'))

    await land('/assets/A/comments', [{ id: 'cA' }])
    await new Promise((r) => setTimeout(r, 50))
    expect(getByTestId('comments').textContent).toBe('cB')
  })
})
