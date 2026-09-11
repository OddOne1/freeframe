/**
 * The zip download dialog, both surfaces (CLAUDE.md §143).
 *
 * The behaviour most worth pinning is the one that is invisible when it
 * works: a cache hit must go STRAIGHT to the download. Flashing
 * "Compacting…" for a sub-second response reads as a glitch rather than as
 * the fast path, so "no progress message on reuse" is asserted directly
 * rather than inferred from timing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { BatchDownloadDialog, type BatchDownloadApi } from '../batch-download-dialog'
import type { ZipExportOptionsResponse } from '@/types'

let downloads: string[] = []
vi.mock('@/lib/download', () => ({
  triggerBrowserDownload: (u: string) => {
    downloads.push(u)
    return true
  },
}))

const OPTIONS_ONE_VARIANT: ZipExportOptionsResponse = {
  variants: ['raw'],
  assets: [
    { asset_id: 'a1', asset_name: 'one.mov', versions: [] },
    { asset_id: 'a2', asset_name: 'two.mov', versions: [] },
  ],
}

const OPTIONS_RICH: ZipExportOptionsResponse = {
  variants: ['raw', 'proxy_1080p'],
  assets: [
    {
      asset_id: 'a1',
      asset_name: 'multi.mov',
      versions: [
        { version_id: 'v2', version_number: 2, is_latest: true },
        { version_id: 'v1', version_number: 1, is_latest: false },
      ],
    },
    { asset_id: 'a2', asset_name: 'single.mov', versions: [] },
  ],
}

function makeApi(
  over: Partial<BatchDownloadApi> = {},
  options: ZipExportOptionsResponse = OPTIONS_ONE_VARIANT,
) {
  return {
    fetchOptions: vi.fn(async () => options as never),
    start: vi.fn(async () => ({
      export_id: 'e1', status: 'pending', reused: false, ready: false,
      file_count: 2, files_done: 0, total_bytes: 0, files: [],
    } as never)),
    poll: vi.fn(async () => ({
      export_id: 'e1', status: 'ready', reused: false, ready: true,
      url: '/stream/hls/x.zip?token=t', file_count: 2, files_done: 2,
      total_bytes: 10, files: [],
    } as never)),
    ...over,
  } as BatchDownloadApi
}

function renderDialog(api: BatchDownloadApi, ids = ['a1', 'a2']) {
  const onOpenChange = vi.fn()
  render(
    <BatchDownloadDialog open onOpenChange={onOpenChange} assetIds={ids} api={api} />,
  )
  return { onOpenChange }
}

beforeEach(() => {
  downloads = []
  vi.clearAllMocks()
})

// ── the cache-hit fast path ──────────────────────────────────────────────

describe('cache hit', () => {
  it('downloads immediately and never shows the progress message', async () => {
    const api = makeApi({
      start: vi.fn(async () => ({
        export_id: 'cached', status: 'ready', reused: true, ready: true,
        url: '/stream/hls/cached.zip?token=t', file_count: 2, files_done: 2,
        total_bytes: 10, files: [],
      } as never)),
    })
    renderDialog(api)
    await screen.findByRole('button', { name: /download zip/i })
    await userEvent.click(screen.getByRole('button', { name: /download zip/i }))

    // The mock records what the dialog PASSES; adding the /api prefix is
    // triggerBrowserDownload's job and is covered by §141's tests.
    await waitFor(() => expect(downloads).toEqual(['/stream/hls/cached.zip?token=t']))
    // The whole point: no "Compacting…" flash for a sub-second response.
    expect(screen.queryByTestId('zip-progress')).not.toBeInTheDocument()
    expect(api.poll).not.toHaveBeenCalled()
  })

  it('closes the dialog rather than leaving it open behind the download', async () => {
    const api = makeApi({
      start: vi.fn(async () => ({
        export_id: 'cached', status: 'ready', reused: true, ready: true,
        url: '/x.zip', file_count: 1, files_done: 1, total_bytes: 1, files: [],
      } as never)),
    })
    const { onOpenChange } = renderDialog(api)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})

// ── the cold build path ──────────────────────────────────────────────────

describe('cold build', () => {
  it('shows one progress message with a file count, then downloads', async () => {
    let polls = 0
    const api = makeApi({
      poll: vi.fn(async () => {
        polls += 1
        return polls < 2
          ? { export_id: 'e1', status: 'building', reused: false, ready: false,
              file_count: 2, files_done: 1, total_bytes: 0, files: [] }
          : { export_id: 'e1', status: 'ready', reused: false, ready: true,
              url: '/built.zip', file_count: 2, files_done: 2, total_bytes: 9, files: [] }
      }) as never,
    })
    renderDialog(api)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))

    const msg = await screen.findByTestId('zip-progress')
    expect(msg).toHaveTextContent(/Compacting 2 files into a zip/i)
    // One message covering gather+zip — there is no render phase.
    expect(screen.queryByText(/rendering/i)).not.toBeInTheDocument()

    await waitFor(() => expect(downloads).toEqual(['/built.zip']), { timeout: 10000 })
  }, 20000)

  it('offers Cancel while building and stops waiting when pressed', async () => {
    // The build FINISHES shortly after the cancel — deliberately, because
    // that is what really happens: the worker keeps going and warms the
    // cache. So a vacuous version of this test (one that never becomes
    // ready) would pass even if Cancel did nothing.
    let polls = 0
    const api = makeApi({
      poll: vi.fn(async () => {
        polls += 1
        return polls < 2
          ? { export_id: 'e1', status: 'building', reused: false, ready: false,
              file_count: 2, files_done: 0, total_bytes: 0, files: [] }
          : { export_id: 'e1', status: 'ready', reused: false, ready: true,
              url: '/late.zip', file_count: 2, files_done: 2, total_bytes: 1, files: [] }
      }) as never,
    })
    const { onOpenChange } = renderDialog(api)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))
    await screen.findByTestId('zip-progress')

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // No download may arrive after cancelling, even though the build
    // completes and the server-side archive is cached.
    await new Promise((r) => setTimeout(r, 3000))
    expect(downloads).toEqual([])
  }, 20000)

  it('surfaces a failed build instead of spinning forever', async () => {
    const api = makeApi({
      poll: vi.fn(async () => ({
        export_id: 'e1', status: 'failed', reused: false, ready: false,
        file_count: 2, files_done: 0, total_bytes: 0, error: 'disk full', files: [],
      } as never)),
    })
    renderDialog(api)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))
    expect(await screen.findByText(/disk full/i)).toBeInTheDocument()
  })
})

// ── pickers appear only when there is a choice ───────────────────────────

describe('controls', () => {
  it('hides the quality picker when only one variant is available', async () => {
    renderDialog(makeApi())
    await screen.findByRole('button', { name: /download zip/i })
    expect(screen.queryByLabelText('Quality')).not.toBeInTheDocument()
  })

  it('shows the quality picker when two or more are, and sends the choice', async () => {
    const api = makeApi({}, OPTIONS_RICH)
    renderDialog(api)
    const picker = await screen.findByLabelText('Quality')
    await userEvent.selectOptions(picker, 'proxy_1080p')
    await userEvent.click(screen.getByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    expect((api.start as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('proxy_1080p')
  })

  it('shows a version selector only for assets with a choice', async () => {
    renderDialog(makeApi({}, OPTIONS_RICH))
    await screen.findByRole('button', { name: /download zip/i })
    expect(screen.getByLabelText('Version for multi.mov')).toBeInTheDocument()
    expect(screen.queryByLabelText('Version for single.mov')).not.toBeInTheDocument()
  })

  it('sends no version_id by default, so the server picks the latest', async () => {
    const api = makeApi({}, OPTIONS_RICH)
    renderDialog(api)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    const items = (api.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(items.every((i: Record<string, unknown>) => !('version_id' in i))).toBe(true)
  })

  it('sends an explicitly chosen older version', async () => {
    const api = makeApi({}, OPTIONS_RICH)
    renderDialog(api)
    await userEvent.selectOptions(await screen.findByLabelText('Version for multi.mov'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    const items = (api.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(items.find((i: { asset_id: string }) => i.asset_id === 'a1').version_id).toBe('v1')
  })

  it('re-selecting the latest clears the override rather than pinning it', async () => {
    // Pinning would change the cache key for a selection that is
    // semantically identical to the default, forcing a needless rebuild.
    const api = makeApi({}, OPTIONS_RICH)
    renderDialog(api)
    const sel = await screen.findByLabelText('Version for multi.mov')
    await userEvent.selectOptions(sel, 'v1')
    await userEvent.selectOptions(sel, 'v2')   // v2 is the latest
    await userEvent.click(screen.getByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    const items = (api.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(items.every((i: Record<string, unknown>) => !('version_id' in i))).toBe(true)
  })

  it('"Download latest versions on all" clears every override', async () => {
    const api = makeApi({}, OPTIONS_RICH)
    renderDialog(api)
    const sel = await screen.findByLabelText('Version for multi.mov')
    await userEvent.selectOptions(sel, 'v1')
    expect((sel as HTMLSelectElement).value).toBe('v1')

    await userEvent.click(screen.getByRole('button', { name: /download latest versions on all/i }))
    expect((sel as HTMLSelectElement).value).toBe('v2')

    await userEvent.click(screen.getByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    const items = (api.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(items.every((i: Record<string, unknown>) => !('version_id' in i))).toBe(true)
  })
})

// ── the original complaint ───────────────────────────────────────────────

describe('the popup-spam bug', () => {
  it('triggers exactly ONE download for a many-file selection', async () => {
    // The whole reason §143 exists: N staggered iframe downloads made the
    // browser re-prompt once per remaining file.
    const many = Array.from({ length: 25 }, (_, i) => `a${i}`)
    const api = makeApi({
      fetchOptions: vi.fn(async () => ({
        variants: ['raw'],
        assets: many.map((id) => ({ asset_id: id, asset_name: `${id}.mov`, versions: [] })),
      } as never)),
      start: vi.fn(async () => ({
        export_id: 'e1', status: 'ready', reused: false, ready: true,
        url: '/one.zip', file_count: 25, files_done: 25, total_bytes: 5, files: [],
      } as never)),
    })
    renderDialog(api, many)
    await userEvent.click(await screen.findByRole('button', { name: /download zip/i }))
    await waitFor(() => expect(downloads).toHaveLength(1))
  })
})
