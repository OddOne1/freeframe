import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => get(...args) },
  ApiError: class ApiError extends Error {},
}))

import { snippetApi, snippetKeys } from '../snippet-api'

beforeEach(() => get.mockReset())

describe('snippetApi.exportDownloadUrl', () => {
  it('asks the server again, so the URL carries the name decided now', async () => {
    get.mockResolvedValueOnce({
      status: 'done',
      progress: 1,
      download_url: '/stream/hls/clip.mp4?token=t&download=Old%20name_9x16.mp4',
      error: null,
    })
    get.mockResolvedValueOnce({
      status: 'done',
      progress: 1,
      download_url: '/stream/hls/clip.mp4?token=t&download=New%20name_9x16.mp4',
      error: null,
    })
    expect(await snippetApi.exportDownloadUrl('e1')).toContain('download=Old%20name_9x16.mp4')
    expect(await snippetApi.exportDownloadUrl('e1')).toContain('download=New%20name_9x16.mp4')
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenLastCalledWith(snippetKeys.export('e1'))
  })

  it('returns the URL raw, for triggerBrowserDownload to resolve once', async () => {
    get.mockResolvedValueOnce({ status: 'done', progress: 1, download_url: '/stream/hls/x.mp4?token=t', error: null })
    expect(await snippetApi.exportDownloadUrl('e1')).toBe('/stream/hls/x.mp4?token=t')
  })

  it.each(['expired', 'failed', 'queued', ''])('is null once the export is %j, not done', async (status) => {
    get.mockResolvedValueOnce({ status, progress: 0, download_url: '/stream/hls/x.mp4?token=t', error: null })
    expect(await snippetApi.exportDownloadUrl('e1')).toBeNull()
  })

  it('is null for a done export without a URL', async () => {
    get.mockResolvedValueOnce({ status: 'done', progress: 1, download_url: null, error: null })
    expect(await snippetApi.exportDownloadUrl('e1')).toBeNull()
  })

  it('passes a failed request on, so the caller can fall back', async () => {
    get.mockRejectedValueOnce(new Error('offline'))
    await expect(snippetApi.exportDownloadUrl('e1')).rejects.toThrow('offline')
  })
})
