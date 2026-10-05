/**
 * The SSE hook, now ticket-authenticated (§211).
 *
 * Every connection used to put the user's access token in the URL, because
 * `EventSource` cannot send an Authorization header. §209 found what that
 * cost: a full-API-scope bearer token in Cloudflare's logs, Traefik's logs
 * and the browser's history, on an endpoint that never checked `tv` — so a
 * user signed out by §207 kept streaming.
 *
 * `connect()` is therefore ASYNC now: it mints a ticket first. That is why
 * the assertions below wait rather than reading `MockEventSource.instances`
 * on the next line; the pre-§211 version of this file could do the latter and
 * every test here had to change for it.
 *
 * The two properties §211 adds, and what would break without them:
 *   - a FRESH ticket per connect. Tickets are single-use server-side, so a
 *     reconnect that replayed one would 401 forever.
 *   - no reliance on EventSource's native retry. It reconnects by itself, to
 *     the same URL, which after a failure holds a spent ticket — an infinite
 *     401 loop on its own schedule, ignoring our backoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiError } from '@/lib/api'

// `vi.hoisted` because `vi.mock` is itself hoisted above this file's imports,
// so a plain `const post = vi.fn()` is still uninitialised when the factory
// below runs ("Cannot access 'post' before initialization").
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
  }
})

import { useSSE } from '../use-sse'

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2

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
    if (!this.listeners[type]) {
      this.listeners[type] = []
    }
    this.listeners[type].push(handler)
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler)
    }
  }

  close() {
    this.closed = true
  }

  // Test helper: emit a named event
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    this.listeners[type]?.forEach((fn) => fn(event))
  }

  static instances: MockEventSource[] = []
  static reset() {
    MockEventSource.instances = []
  }
}

/** A different ticket every time, so "did it reuse one?" is answerable. */
let ticketSeq = 0
function freshTickets() {
  ticketSeq = 0
  post.mockImplementation(async () => ({ ticket: `tkt-${++ticketSeq}` }))
}

/** Wait for the async connect to have produced the Nth EventSource. */
async function waitForInstances(n: number) {
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(n))
}

describe('useSSE hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.reset()
    freshTickets()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates EventSource with correct URL', async () => {
    renderHook(() => useSSE('project-123'))
    await waitForInstances(1)
    expect(MockEventSource.instances[0].url).toContain('/events/project-123')
  })

  it('mints a ticket for this project and puts THAT in the URL', async () => {
    renderHook(() => useSSE('project-123'))
    await waitForInstances(1)

    expect(post).toHaveBeenCalledWith('/events/ticket?project_id=project-123')
    expect(MockEventSource.instances[0].url).toContain('ticket=tkt-1')
  })

  it('no longer puts an access token in the URL', async () => {
    // §211's point. The whole reason this hook changed.
    renderHook(() => useSSE('project-123'))
    await waitForInstances(1)

    expect(MockEventSource.instances[0].url).not.toContain('token=')
  })

  it('does not create EventSource when projectId is null', async () => {
    renderHook(() => useSSE(null))
    await new Promise((r) => setTimeout(r, 20))
    expect(MockEventSource.instances).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('does not create EventSource when enabled is false', async () => {
    renderHook(() => useSSE('project-123', { enabled: false }))
    await new Promise((r) => setTimeout(r, 20))
    expect(MockEventSource.instances).toHaveLength(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('sets isConnected to true when connection opens', async () => {
    const { result } = renderHook(() => useSSE('project-123'))
    await waitForInstances(1)
    expect(result.current.isConnected).toBe(false)
    act(() => {
      MockEventSource.instances[0].onopen?.()
    })
    expect(result.current.isConnected).toBe(true)
  })

  it('sets isConnected to false and closes on error', async () => {
    const { result } = renderHook(() => useSSE('project-123'))
    await waitForInstances(1)

    act(() => {
      MockEventSource.instances[0].onopen?.()
    })
    expect(result.current.isConnected).toBe(true)

    act(() => {
      MockEventSource.instances[0].onerror?.()
    })
    expect(result.current.isConnected).toBe(false)
    // §211 — closing is load-bearing, not tidiness: it stops EventSource's
    // own retry, which would reuse the spent ticket in this URL.
    expect(MockEventSource.instances[0].closed).toBe(true)
  })

  it('calls onNewComment callback when new_comment event fires', async () => {
    const onNewComment = vi.fn()
    renderHook(() => useSSE('project-123', { onNewComment }))
    await waitForInstances(1)

    act(() => {
      MockEventSource.instances[0].emit('new_comment', {
        asset_id: 'a1',
        comment_id: 'c1',
        author: 'Alice',
      })
    })

    expect(onNewComment).toHaveBeenCalledWith({
      asset_id: 'a1',
      comment_id: 'c1',
      author: 'Alice',
    })
  })

  it('cleans up EventSource on unmount', async () => {
    const { unmount } = renderHook(() => useSSE('project-123'))
    await waitForInstances(1)
    const instance = MockEventSource.instances[0]
    unmount()
    expect(instance.closed).toBe(true)
  })
})

// ── §211 (d) — a new ticket every reconnect ────────────────────────────────

describe('reconnecting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.reset()
    freshTickets()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('schedules reconnect with backoff after error, and mints a NEW ticket', async () => {
    renderHook(() => useSSE('project-123'))
    await waitForInstances(1)
    expect(MockEventSource.instances[0].url).toContain('ticket=tkt-1')

    act(() => {
      MockEventSource.instances[0].onerror?.()
    })
    // Nothing yet — waiting out the backoff.
    expect(MockEventSource.instances).toHaveLength(1)

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2), {
      timeout: 3000,
    })

    // The property that matters: a DIFFERENT ticket. A reused one is spent
    // server-side and would 401 forever.
    expect(post).toHaveBeenCalledTimes(2)
    expect(MockEventSource.instances[1].url).toContain('ticket=tkt-2')
    expect(MockEventSource.instances[1].url).not.toContain('ticket=tkt-1')
  })

  it('never reuses a ticket across several reconnects', async () => {
    // Fake timers, advanced ASYNCHRONOUSLY: the backoff is 1s, 2s, 4s, so
    // three reconnects is 7 seconds of real waiting — past the default test
    // timeout. `advanceTimersByTimeAsync` also flushes the microtasks the
    // ticket fetch awaits, which `advanceTimersByTime` would not.
    vi.useFakeTimers()
    renderHook(() => useSSE('project-123'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(MockEventSource.instances).toHaveLength(1)

    const backoffs = [1000, 2000, 4000]
    for (let i = 0; i < backoffs.length; i++) {
      act(() => {
        MockEventSource.instances[i].onerror?.()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(backoffs[i] + 50)
      })
      expect(MockEventSource.instances).toHaveLength(i + 2)
    }

    const tickets = MockEventSource.instances.map(
      (es) => new URL(es.url, 'http://localhost').searchParams.get('ticket'),
    )
    expect(new Set(tickets).size).toBe(tickets.length)
    expect(tickets).toEqual(['tkt-1', 'tkt-2', 'tkt-3', 'tkt-4'])
  })
})

// ── §211 (d) — a dead session stops the loop ───────────────────────────────

describe('when the ticket request is refused', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a 401 opens no stream and does NOT retry', async () => {
    // The session is gone. `api.post` has already tried a refresh and, on a
    // real rejection, cleared the session and sent the browser to /login
    // (§129) — so retrying here would be a loop against an endpoint that
    // cannot start succeeding.
    post.mockRejectedValue(new ApiError(401, 'Not authenticated'))

    renderHook(() => useSSE('project-123'))

    await new Promise((r) => setTimeout(r, 1500))
    expect(MockEventSource.instances).toHaveLength(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a 403 also stops, rather than hammering a project it cannot read', async () => {
    post.mockRejectedValue(new ApiError(403, 'Not a project member'))

    renderHook(() => useSSE('project-123'))

    await new Promise((r) => setTimeout(r, 1500))
    expect(MockEventSource.instances).toHaveLength(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a network error DOES retry, with a fresh attempt', async () => {
    // Distinguished from the two above on purpose: a blip is temporary, a
    // dead session is not.
    post.mockRejectedValueOnce(new Error('Failed to fetch'))
    post.mockImplementation(async () => ({ ticket: 'tkt-after-blip' }))

    renderHook(() => useSSE('project-123'))

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1), {
      timeout: 3000,
    })
    expect(MockEventSource.instances[0].url).toContain('ticket=tkt-after-blip')
  })

  it('reports disconnected while it cannot get a ticket', async () => {
    post.mockRejectedValue(new ApiError(401, 'Not authenticated'))
    const { result } = renderHook(() => useSSE('project-123'))

    await new Promise((r) => setTimeout(r, 100))
    expect(result.current.isConnected).toBe(false)
  })
})

describe('useSSE with relative NEXT_PUBLIC_API_URL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.reset()
    freshTickets()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  // Regression for issue #46: deployments behind nginx set NEXT_PUBLIC_API_URL
  // to a relative path like "/api". `new URL("/api/events/abc")` throws
  // "Failed to construct 'URL': Invalid URL" without a base, crashing the
  // dashboard the moment UploadSSEBridge first opens an SSE connection.
  it('builds a valid URL when NEXT_PUBLIC_API_URL is a relative path', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')
    vi.resetModules()
    const { useSSE: useSSEFresh } = await import('../use-sse')

    expect(() => renderHook(() => useSSEFresh('project-123'))).not.toThrow()
    await waitForInstances(1)
    expect(MockEventSource.instances[0].url).toContain('/api/events/project-123')
  })
})
