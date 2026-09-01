/**
 * The uploads panel finds in-flight assets it cannot page to (CLAUDE.md §113).
 *
 * The panel's list came only from recency pages — 20 at a time, further pages
 * only on scroll. A still-processing asset with enough newer ones behind it
 * therefore never re-entered the list after a reload: absent entirely, not
 * stuck at 0%, while its own detail view showed the truth. Neither the 5s poll
 * nor the SSE handlers could recover it, because both only update items that
 * are already present.
 *
 * The assertions that matter are about PRESENCE, and about a real percent
 * surviving a reload — a test that only checked progress would pass against
 * the bug.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn() },
}))

import { api } from '@/lib/api'

async function freshStore() {
  vi.resetModules()
  const mod = await import('../upload-store')
  return mod.useUploadStore
}

function asset(id: string, status: string, progress: number | null = null) {
  return {
    id, project_id: 'p1', name: `${id}.mov`, asset_type: 'video',
    created_at: new Date().toISOString(),
    latest_version: {
      id: `v-${id}`, asset_id: id, version_number: 1,
      processing_status: status,
      processing_progress: progress,
      created_at: new Date().toISOString(),
      files: [{ original_filename: `${id}.mov`, file_size_bytes: 10, mime_type: 'video/quicktime' }],
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('processing discovery', () => {
  it('asks for in-flight assets without paging, and adds them to the list', async () => {
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([asset('a1', 'processing', 42)])

    await useStore.getState().fetchProcessing()

    const url = String((api.get as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(url).toContain('processing=true')
    // No skip/limit: capping this by recency would reintroduce the exact bug
    // it exists to close.
    expect(url).not.toContain('skip=')
    expect(url).not.toContain('limit=')

    const files = useStore.getState().files
    expect(files).toHaveLength(1)
    expect(files[0].assetId).toBe('a1')
  })

  it('carries the PERSISTED percent, not a 0/100 guess from the status', async () => {
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([asset('a1', 'processing', 42)])
    await useStore.getState().fetchProcessing()
    expect(useStore.getState().files[0].processingProgress).toBe(42)
  })

  it('shows 0 for a job that has started but not advanced, and for one with no report', async () => {
    // NOTE, so nobody reads more into this than it proves: the source uses
    // `??` rather than `||`, but the fallback is itself 0, so the two are
    // indistinguishable here and this test cannot tell them apart. `??` is
    // still the right operator — it stays correct if the fallback ever
    // becomes something other than 0 — but that is a claim about the future,
    // not something asserted below.
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      asset('a1', 'processing', 0), asset('a2', 'processing', null),
    ])
    await useStore.getState().fetchProcessing()
    const byId = Object.fromEntries(useStore.getState().files.map((f) => [f.assetId, f]))
    expect(byId.a1.processingProgress).toBe(0)
    expect(byId.a2.processingProgress).toBe(0)
  })

  it('a ready asset still reads 100 regardless of its stored percent', async () => {
    // ffmpeg's last progress line is often short of 100; a finished asset
    // showing 98% reads as stalled.
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([asset('a1', 'ready', 98)])
    await useStore.getState().fetchProcessing()
    expect(useStore.getState().files[0].processingProgress).toBe(100)
  })

  it('does not disturb entries already in the list', async () => {
    // It runs alongside the history fetch, not instead of it, and both merge
    // through the same path.
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([asset('a1', 'processing', 10)])
    await useStore.getState().fetchProcessing()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([asset('a2', 'processing', 20)])
    await useStore.getState().fetchProcessing()
    const ids = useStore.getState().files.map((f) => f.assetId).sort()
    expect(ids).toEqual(['a1', 'a2'])
  })

  it('a failed discovery leaves the panel usable', async () => {
    const useStore = await freshStore()
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))
    await expect(useStore.getState().fetchProcessing()).resolves.toBeUndefined()
    expect(useStore.getState().files).toEqual([])
  })
})
