/**
 * §242 — a re-read of the version list refreshes the SELECTED version too.
 *
 * The provider keeps two things: the list, which the dropdown renders, and
 * `currentVersion` in the review store, which everything ELSE renders —
 * `renderMediaViewer` shows the player only for
 * `processing_status === 'ready'`, and §238's "Upload didn't finish" panel
 * reads `failure_stage`. Both read a SNAPSHOT taken when the version was
 * chosen.
 *
 * So a refetch that updated only the list would have fixed the dropdown and
 * left the page itself stale: "Processing asset", spinning, over a version
 * the dropdown next to it already showed as DONE. That is the half of the
 * owner's complaint a dropdown-only fix would have missed.
 *
 * The other half of the same rule, and the one §242 must not break: it is
 * the SAME version, by id, with new fields — never a re-pick. Someone
 * reading v7 and typing a comment stays on v7 when v8 lands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import * as React from 'react'
import { useReviewStore } from '@/stores/review-store'

/** Pending resolvers keyed by path, so a test lands responses when it wants. */
let pending: Record<string, (v: unknown) => void> = {}
const requests: string[] = []

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => {
      requests.push(path)
      return new Promise((resolve) => {
        pending[path] = resolve
      })
    },
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}))

import { ReviewProvider, useReview } from '../review-provider'

const version = (id: string, n: number, status: string, failureStage: string | null = null) => ({
  id,
  asset_id: 'A',
  version_number: n,
  processing_status: status,
  failure_stage: failureStage,
  created_by: 'someone',
  created_at: '2026-10-28T09:00:00Z',
  deleted_at: null,
  files: [],
})

const asset = { id: 'A', asset_type: 'video', latest_version: null }

let refetch: (() => Promise<void>) | null = null

function Readout() {
  const { versions, refetchVersions } = useReview()
  refetch = refetchVersions
  return (
    <span data-testid="rows">
      {versions.map((v) => `v${v.version_number}:${v.processing_status}`).join(' ')}
    </span>
  )
}

async function land(path: string, value: unknown) {
  await waitFor(() => expect(pending[path]).toBeDefined())
  await act(async () => {
    pending[path](value)
    delete pending[path]
  })
}

function mount() {
  return render(
    <ReviewProvider assetId="A">
      <Readout />
    </ReviewProvider>,
  )
}

beforeEach(() => {
  pending = {}
  requests.length = 0
  refetch = null
  useReviewStore.getState().reset()
})

describe('refetchVersions', () => {
  it('moves the selected version to ready in place, without moving the selection', async () => {
    mount()
    await land('/assets/A', asset)
    // v2 is what the page opens on: the highest version, still transcoding,
    // so nothing is ready and the provider falls back to it.
    await land('/assets/A/versions', [version('v1', 1, 'ready'), version('v2', 2, 'processing')])
    await act(async () => {
      useReviewStore.getState().setCurrentVersion(version('v2', 2, 'processing') as never)
    })

    await act(async () => {
      void refetch!()
    })
    await land('/assets/A/versions', [version('v1', 1, 'ready'), version('v2', 2, 'ready')])

    const current = useReviewStore.getState().currentVersion
    expect(current?.id).toBe('v2')
    // The player's own gate. Before §242 this still said `processing`.
    expect(current?.processing_status).toBe('ready')
  })

  it('does not re-pick a newer version that arrives while one is selected', async () => {
    mount()
    await land('/assets/A', asset)
    await land('/assets/A/versions', [version('v7', 7, 'ready')])
    await waitFor(() => expect(useReviewStore.getState().currentVersion?.id).toBe('v7'))

    await act(async () => {
      void refetch!()
    })
    await land('/assets/A/versions', [version('v7', 7, 'ready'), version('v8', 8, 'ready')])

    // Mid-review on v7. A list that grew is not a reason to move anyone.
    expect(useReviewStore.getState().currentVersion?.id).toBe('v7')
  })

  it('carries §238’s failure_stage through, so the right panel stays right', async () => {
    mount()
    await land('/assets/A', asset)
    await land('/assets/A/versions', [version('v1', 1, 'ready'), version('v2', 2, 'uploading')])
    await act(async () => {
      useReviewStore.getState().setCurrentVersion(version('v2', 2, 'uploading') as never)
    })

    await act(async () => {
      void refetch!()
    })
    await land('/assets/A/versions', [
      version('v1', 1, 'ready'),
      version('v2', 2, 'failed', 'upload'),
    ])

    const current = useReviewStore.getState().currentVersion
    expect(current?.id).toBe('v2')
    expect(current?.failure_stage).toBe('upload')
  })

  it('leaves the selection alone when the selected version is gone from the list', async () => {
    mount()
    await land('/assets/A', asset)
    await land('/assets/A/versions', [version('v1', 1, 'ready'), version('v2', 2, 'ready')])
    await act(async () => {
      useReviewStore.getState().setCurrentVersion(version('v2', 2, 'ready') as never)
    })

    // Deleted from another tab (§239). Where to go next is the delete
    // flow's decision, not a side-effect of a poll.
    await act(async () => {
      void refetch!()
    })
    await land('/assets/A/versions', [version('v1', 1, 'ready')])

    expect(useReviewStore.getState().currentVersion?.id).toBe('v2')
  })

  it('drops an answer that arrives for the asset the page has left', async () => {
    const { rerender } = mount()
    await land('/assets/A', asset)
    await land('/assets/A/versions', [version('v1', 1, 'ready')])

    await act(async () => {
      void refetch!()
    })
    rerender(
      <ReviewProvider assetId="B">
        <Readout />
      </ReviewProvider>,
    )
    await land('/assets/A/versions', [version('v1', 1, 'ready'), version('v2', 2, 'ready')])

    // §122 from the other direction: a late answer for A must not fill B's
    // dropdown. The poll makes this an everyday case rather than a race.
    expect(useReviewStore.getState().currentVersion).toBeNull()
  })
})
