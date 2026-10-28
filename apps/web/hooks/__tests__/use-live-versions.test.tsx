/**
 * §242 — the version list follows reality while the page is open, and says
 * when a version arrived from someone else.
 *
 * THE BUG these start from: the owner was inside an asset while a new version
 * uploaded and transcoded. The dropdown kept showing v8 "Uploading", greyed,
 * with a disabled trash icon, while v4/v5/v7 showed DONE — until he reloaded.
 * The data was stale, not wrong: `/assets/{id}/versions` was read once, on
 * mount, and the project's SSE channel (which already carries
 * `transcode_complete`) was consumed by the uploads panel and the transcript
 * and by nothing else.
 *
 * So there are three ways in, and each is tested on its own because each
 * covers a case the others cannot:
 *
 *   SSE          instant, but Redis pub/sub has no replay — an event
 *                published while the connection was down is gone;
 *   the 5s poll  survives that, and must stop by itself, or every open
 *                asset page polls forever;
 *   the upload   the uploader's own tab, before any event arrives.
 *   store
 *
 * The indicator is diffed against what THIS page instance knew at open, so
 * opening an asset an hour after v9 landed shows nothing — and the uploader
 * is never told about their own upload.
 *
 * The harness wires the hook exactly as the asset page does (the three SSE
 * handlers, the real `VersionSwitcher`, selection through the review store),
 * and `app/(dashboard)/projects/[id]/assets/[assetId]/__tests__/
 * live-version-indicator.test.tsx` holds the page to that same wiring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'

// Hoisted: `vi.mock` runs above this file's imports, so a plain const is
// still uninitialised when the factory below executes.
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn(), upload: vi.fn() },
  }
})

import { useReviewStore } from '@/stores/review-store'
import { useUploadStore } from '@/stores/upload-store'
import { useSSE } from '@/hooks/use-sse'
import { VersionSwitcher } from '@/components/review/version-switcher'
import type { UploadFile } from '@/stores/upload-store'
import type { AssetVersion } from '@/types'
import {
  useLiveVersions,
  VERSION_POLL_INTERVAL_MS,
  VERSION_REFETCH_WINDOW_MS,
  type UseLiveVersionsResult,
} from '../use-live-versions'

const ASSET = 'asset-1'
const OTHER_ASSET = 'asset-2'
const PROJECT = 'proj-1'
const ME = 'user-me'
const THEM = 'user-them'

type Status = AssetVersion['processing_status']

function version(
  n: number,
  status: Status = 'ready',
  createdBy: string | null = THEM,
  failureStage: AssetVersion['failure_stage'] = null,
): AssetVersion {
  return {
    id: `ver-${n}`,
    asset_id: ASSET,
    version_number: n,
    processing_status: status,
    failure_stage: failureStage,
    created_by: createdBy,
    created_at: '2026-10-28T09:00:00Z',
    deleted_at: null,
    files: [],
  } as AssetVersion
}

// ─── A fake SSE source, the same shape hooks/__tests__/use-sse.test.ts uses ──

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    ;(this.listeners[type] ??= []).push(handler)
  }
  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler)
  }
  close() {
    this.closed = true
  }
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    this.listeners[type]?.forEach((fn) => fn(event))
  }
  static reset() {
    MockEventSource.instances = []
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

/** What the server would answer `/assets/{id}/versions` with right now. */
let serverVersions: AssetVersion[] = []
const fetchSpy = vi.fn()
const seenSpy = vi.fn()
/** The hook's handles, so a test can drive events without an EventSource. */
const live: { current: UseLiveVersionsResult | null } = { current: null }

function Harness({
  userId = ME as string | null,
  withSSE = false,
}: {
  userId?: string | null
  withSSE?: boolean
}) {
  const [versions, setVersions] = React.useState<AssetVersion[]>([])

  const refetchVersions = React.useCallback(async () => {
    fetchSpy()
    setVersions(serverVersions)
  }, [])

  // The provider's own shape: the list lands a round trip AFTER mount (so the
  // first thing the hook sees is `[]`), and the highest ready version is
  // selected — review-provider.tsx's fetchAsset.
  React.useEffect(() => {
    setVersions(serverVersions)
    const ready = [...serverVersions]
      .sort((a, b) => b.version_number - a.version_number)
      .find((v) => v.processing_status === 'ready')
    if (ready) useReviewStore.getState().setCurrentVersion(ready)
  }, [])

  const currentVersion = useReviewStore((s) => s.currentVersion)
  const result = useLiveVersions({
    assetId: ASSET,
    versions,
    refetchVersions,
    currentUserId: userId,
    currentVersionNumber: currentVersion?.version_number ?? null,
    onNewVersionSeen: seenSpy,
  })
  live.current = result

  // The asset page's three lines, verbatim.
  useSSE(withSSE ? PROJECT : null, {
    onTranscodeComplete: (d) => result.onVersionEvent(d.asset_id),
    onTranscodeFailed: (d) => result.onVersionEvent(d.asset_id),
    onTranscodeProgress: (d) => result.onVersionProgress(d.asset_id),
  })

  const flagged = versions
    .filter((v) => result.newVersionIds.has(v.id))
    .map((v) => `v${v.version_number}`)
    .join(',')

  return (
    <>
      <span data-testid="rows">
        {versions.map((v) => `v${v.version_number}:${v.processing_status}`).join(' ')}
      </span>
      <span data-testid="flagged">{flagged || 'none'}</span>
      <VersionSwitcher versions={versions} newVersionIds={result.newVersionIds} />
    </>
  )
}

const rows = () => screen.getByTestId('rows').textContent
const flagged = () => screen.getByTestId('flagged').textContent
const dot = () => screen.queryByTestId('new-version-dot')

/** One event through the hook's own entry point, as the page's SSE handler
 *  would, plus whatever the resulting fetch resolves. */
async function sendEvent(kind: 'status' | 'progress' = 'status', assetId = ASSET) {
  await act(async () => {
    if (kind === 'progress') live.current!.onVersionProgress(assetId)
    else live.current!.onVersionEvent(assetId)
  })
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  serverVersions = []
  live.current = null
  useReviewStore.getState().reset()
  useUploadStore.setState({ files: [] })
  post.mockImplementation(async () => ({ ticket: 'tkt-1' }))
})

// ─────────────────────────────────────────────────────────────────────────────

describe('a status change on the project SSE channel', () => {
  beforeEach(() => {
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function connected(userId: string | null = ME) {
    render(<Harness userId={userId} withSSE />)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    return MockEventSource.instances[0]
  }

  it('flips an uploading version to DONE in the open dropdown, with no reload', async () => {
    const user = userEvent.setup()
    serverVersions = [version(7, 'ready'), version(8, 'uploading')]
    const es = await connected()
    await waitFor(() => expect(rows()).toBe('v7:ready v8:uploading'))

    await user.click(screen.getByRole('button', { name: /^v7/ }))
    expect(await screen.findByText('Uploading')).toBeInTheDocument()

    // The transcode finishes. THE EVENT IS ALL THE PAGE GETS: it names the
    // asset and the version and says nothing about the new status.
    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await act(async () => {
      es.emit('transcode_complete', { asset_id: ASSET, version_id: 'ver-8' })
    })

    await waitFor(() => expect(rows()).toBe('v7:ready v8:ready'))
    expect(screen.queryByText('Uploading')).not.toBeInTheDocument()
    expect(screen.getAllByText('DONE')).toHaveLength(2)
  })

  it('refetches on a failed transcode too — the row has to stop spinning', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'processing')]
    const es = await connected()
    await waitFor(() => expect(rows()).toBe('v7:ready v8:processing'))
    fetchSpy.mockClear()

    serverVersions = [version(7, 'ready'), version(8, 'failed')]
    await act(async () => {
      // `transcode_failed` carries {asset_id, error} and no version id.
      es.emit('transcode_failed', { asset_id: ASSET, error: 'ffmpeg exited 1' })
    })

    await waitFor(() => expect(rows()).toBe('v7:ready v8:failed'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores events about the other assets on the same project channel', async () => {
    serverVersions = [version(7, 'ready')]
    const es = await connected()
    await waitFor(() => expect(rows()).toBe('v7:ready'))
    fetchSpy.mockClear()

    await act(async () => {
      es.emit('transcode_complete', { asset_id: OTHER_ASSET, version_id: 'x' })
      es.emit('transcode_progress', { asset_id: OTHER_ASSET, percent: 40 })
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('opening the dropdown does not clear the indicator', async () => {
    const user = userEvent.setup()
    serverVersions = [version(7, 'ready')]
    await connected()
    await waitFor(() => expect(rows()).toBe('v7:ready'))

    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await sendEvent()
    await waitFor(() => expect(flagged()).toBe('v8'))

    // Looking at a list of versions is not reading the new one.
    await user.click(screen.getByRole('button', { name: /^v7/ }))
    expect(await screen.findByTestId('new-version-tag-8')).toBeInTheDocument()
    expect(flagged()).toBe('v8')
    expect(dot()).toBeInTheDocument()
    expect(seenSpy).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the fallback poll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function mounted(userId: string | null = ME) {
    render(<Harness userId={userId} />)
    await act(async () => {})
  }

  it('brings an uploading version to ready with no event at all', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'uploading')]
    await mounted()
    expect(rows()).toBe('v7:ready v8:uploading')

    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await advance(VERSION_POLL_INTERVAL_MS)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(rows()).toBe('v7:ready v8:ready')
  })

  it('stops as soon as nothing is in flight, and never polls an idle asset', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'processing')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await advance(VERSION_POLL_INTERVAL_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Four more intervals over a list that has nothing left to wait for.
    await advance(VERSION_POLL_INTERVAL_MS * 4)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('polls nothing when the asset was already idle at open', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    await advance(VERSION_POLL_INTERVAL_MS * 10)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pauses while the tab is hidden and catches up once on return', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'processing')]
    await mounted()

    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await advance(VERSION_POLL_INTERVAL_MS * 6)
    expect(fetchSpy).not.toHaveBeenCalled()

    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    visibility.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // One catch-up read immediately, rather than up to 5s of staleness.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(rows()).toBe('v7:ready v8:ready')
    visibility.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns a burst of events into one leading and one trailing fetch', async () => {
    serverVersions = [version(7, 'ready')]
    render(<Harness />)
    await act(async () => {})

    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    for (let i = 0; i < 6; i++) await sendEvent()

    // The first event is served immediately; the other five share the
    // window's single trailing fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await advance(VERSION_REFETCH_WINDOW_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // And nothing more afterwards: the burst is spent, not queued.
    await advance(VERSION_REFETCH_WINDOW_MS * 4)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does not refetch per progress tick — the dropdown shows no percentage', async () => {
    serverVersions = [version(7, 'ready')]
    render(<Harness />)
    await act(async () => {})

    // The one thing a percentage IS evidence of: a version this page has
    // never heard of has started processing.
    serverVersions = [version(7, 'ready'), version(8, 'processing')]
    await sendEvent('progress')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(rows()).toBe('v7:ready v8:processing')

    // From here the poll owns it, and ffmpeg's hundred reports cost nothing.
    for (let i = 0; i < 40; i++) await sendEvent('progress')
    await advance(VERSION_REFETCH_WINDOW_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('this tab’s own upload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function uploadRow(status: UploadFile['status'], versionId = 'ver-8'): UploadFile {
    return {
      id: 'up-1',
      fileName: 'take-2.mov',
      fileSize: 1,
      fileType: 'video/quicktime',
      projectId: PROJECT,
      assetName: 'take.mov',
      progress: 100,
      processingProgress: 0,
      status,
      assetId: ASSET,
      versionId,
      createdAt: Date.now(),
    }
  }

  it('refetches when /upload/complete lands, without waiting for an event', async () => {
    serverVersions = [version(7, 'ready')]
    render(<Harness />)
    await act(async () => {})
    useUploadStore.setState({ files: [uploadRow('uploading')] })
    await act(async () => {})
    expect(fetchSpy).not.toHaveBeenCalled()

    // `/upload/complete` returned: the row moves to `processing` and the
    // server now has a v8.
    serverVersions = [version(7, 'ready'), version(8, 'processing', ME)]
    await act(async () => {
      useUploadStore.setState({ files: [uploadRow('processing')] })
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(rows()).toBe('v7:ready v8:processing')
  })

  it('does not raise the dot for a version this tab uploaded with no created_by', async () => {
    serverVersions = [version(7, 'ready')]
    render(<Harness />)
    await act(async () => {})
    useUploadStore.setState({ files: [uploadRow('uploading')] })
    await act(async () => {})

    // Attribution comes off the version row, and this one has none — an
    // older row, or a version created by a service. The local upload row is
    // the fallback that still answers "this is mine".
    serverVersions = [version(7, 'ready'), version(8, 'ready', null)]
    await sendEvent()

    expect(rows()).toBe('v7:ready v8:ready')
    expect(flagged()).toBe('none')
    expect(dot()).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the “a new version arrived” indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function mounted(userId: string | null = ME) {
    render(<Harness userId={userId} />)
    await act(async () => {})
  }

  it('never raises for versions that already existed at open', async () => {
    // Someone else's v7 and v8, both ready, both there before the page was.
    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await mounted()

    expect(rows()).toBe('v7:ready v8:ready')
    expect(flagged()).toBe('none')
    expect(dot()).not.toBeInTheDocument()

    // Including after a refetch that changes nothing — the diff is against
    // the page's opening list, not against the previous response.
    await sendEvent()
    expect(flagged()).toBe('none')
  })

  it('raises for a colleague’s version that lands while the page is open', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(9, 'ready', THEM)]
    await sendEvent()

    expect(flagged()).toBe('v9')
    expect(dot()).toHaveAttribute('aria-label', 'New version v9 available')
  })

  it('does not raise for the current user’s own upload', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'ready', ME)]
    await sendEvent()

    expect(rows()).toBe('v7:ready v8:ready')
    expect(flagged()).toBe('none')
  })

  it('waits for ready: an uploading arrival shows its status and no dot', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'uploading', THEM)]
    await sendEvent()
    expect(rows()).toBe('v7:ready v8:uploading')
    expect(flagged()).toBe('none')

    serverVersions = [version(7, 'ready'), version(8, 'processing', THEM)]
    await advance(VERSION_POLL_INTERVAL_MS)
    expect(flagged()).toBe('none')

    serverVersions = [version(7, 'ready'), version(8, 'ready', THEM)]
    await advance(VERSION_POLL_INTERVAL_MS)
    expect(flagged()).toBe('v8')
  })

  it('never raises for a failed arrival, nor for §238’s incomplete upload', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'uploading', THEM)]
    await sendEvent()
    serverVersions = [version(7, 'ready'), version(8, 'failed', THEM, 'upload')]
    await advance(VERSION_POLL_INTERVAL_MS)

    expect(rows()).toBe('v7:ready v8:failed')
    expect(flagged()).toBe('none')
    expect(dot()).not.toBeInTheDocument()

    // And a later retry does not resurrect it.
    serverVersions = [version(7, 'ready'), version(8, 'ready', THEM)]
    await sendEvent()
    expect(flagged()).toBe('none')
  })

  it('shows one dot for several arrivals and names the latest', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'ready', THEM), version(9, 'ready', THEM)]
    await sendEvent()

    expect(flagged()).toBe('v8,v9')
    expect(screen.getAllByTestId('new-version-dot')).toHaveLength(1)
    expect(dot()).toHaveAttribute('aria-label', 'New version v9 available')
  })

  it('does not auto-switch the reader onto the new version', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()
    expect(useReviewStore.getState().currentVersion?.version_number).toBe(7)

    serverVersions = [version(7, 'ready'), version(9, 'ready', THEM)]
    await sendEvent()

    // They may be mid-comment on v7. The dot is the whole of the telling.
    expect(useReviewStore.getState().currentVersion?.version_number).toBe(7)
  })

  it('clears on selecting the new version, and records the view once', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(9, 'ready', THEM)]
    await sendEvent()
    expect(flagged()).toBe('v9')

    // What the switcher's row does when it is picked.
    await act(async () => {
      useReviewStore.getState().setCurrentVersion(serverVersions[1])
    })

    expect(flagged()).toBe('none')
    expect(dot()).not.toBeInTheDocument()
    expect(seenSpy).toHaveBeenCalledTimes(1)
  })

  it('clears only up to the version selected', async () => {
    serverVersions = [version(7, 'ready')]
    await mounted()

    serverVersions = [version(7, 'ready'), version(8, 'ready', THEM), version(9, 'ready', THEM)]
    await sendEvent()
    expect(flagged()).toBe('v8,v9')

    await act(async () => {
      useReviewStore.getState().setCurrentVersion(serverVersions[1]) // v8
    })

    expect(flagged()).toBe('v9')
    expect(dot()).toHaveAttribute('aria-label', 'New version v9 available')
    expect(seenSpy).toHaveBeenCalledTimes(1)
  })

  it('does not re-record a view for a selection that clears nothing', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'ready')]
    await mounted()

    await act(async () => {
      useReviewStore.getState().setCurrentVersion(serverVersions[0])
    })

    expect(seenSpy).not.toHaveBeenCalled()
  })

  it('keeps the selection put when statuses change under it', async () => {
    serverVersions = [version(7, 'ready'), version(8, 'processing', THEM)]
    await mounted()
    expect(useReviewStore.getState().currentVersion?.id).toBe('ver-7')

    serverVersions = [version(7, 'ready'), version(8, 'ready', THEM)]
    await advance(VERSION_POLL_INTERVAL_MS)

    expect(rows()).toBe('v7:ready v8:ready')
    expect(useReviewStore.getState().currentVersion?.id).toBe('ver-7')
    expect(screen.getByRole('button', { name: /^v7/ })).toBeInTheDocument()
  })
})
