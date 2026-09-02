/**
 * §117 bug C — the processing poll must have a floor.
 *
 * refreshProcessingItems runs every 5s from a layout-level bridge, over a
 * store PERSISTED in localStorage, for every file still marked 'processing'
 * — whatever page is open. An asset that never leaves that state is therefore
 * re-fetched by id every 5 seconds, forever, across reloads and unrelated
 * pages, with every error swallowed. That is what produced repeated requests
 * for an asset id belonging to no part of the current page.
 *
 * It became permanent because process_asset was never a registered Celery
 * task (§115), so nothing moved those rows on. That is fixed; this is the
 * client-side floor that stops the spinning regardless of the cause.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const get = vi.fn(async (_url: string) => ({
  latest_version: { processing_status: 'processing', processing_progress: 10 },
}))
vi.mock('@/lib/api', () => ({ api: { get: (u: string) => get(u), post: vi.fn(), delete: vi.fn() } }))

import { useUploadStore } from '../upload-store'

const HOUR = 60 * 60 * 1000

function seed(createdAt: number) {
  useUploadStore.setState({
    files: [{
      id: 'f1', fileName: 'a.mov', fileSize: 1, fileType: 'video/quicktime',
      projectId: 'p1', assetName: 'a', progress: 100, processingProgress: 10,
      status: 'processing', assetId: 'asset-1', createdAt,
    }],
  } as never)
}

beforeEach(() => { get.mockClear() })

describe('processing poll floor', () => {
  it('keeps polling an item that is still plausibly transcoding', async () => {
    seed(Date.now() - 1 * HOUR)
    await useUploadStore.getState().refreshProcessingItems()
    expect(get).toHaveBeenCalledWith('/assets/asset-1')
    expect(useUploadStore.getState().files[0].status).toBe('processing')
  })

  it('stops polling one that has outlived any real transcode', async () => {
    seed(Date.now() - 12 * HOUR)
    await useUploadStore.getState().refreshProcessingItems()
    expect(get).not.toHaveBeenCalled()
  })

  it('marks that item failed, so it leaves the processing set for good', async () => {
    seed(Date.now() - 12 * HOUR)
    await useUploadStore.getState().refreshProcessingItems()
    const f = useUploadStore.getState().files[0]
    expect(f.status).toBe('failed')
    expect(f.error).toMatch(/did not finish/i)
  })

  it('does not poll again on the next tick once it has been failed', async () => {
    seed(Date.now() - 12 * HOUR)
    await useUploadStore.getState().refreshProcessingItems()
    get.mockClear()
    await useUploadStore.getState().refreshProcessingItems()
    expect(get).not.toHaveBeenCalled()
  })
})
