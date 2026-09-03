/**
 * §120 — clicking a notification must not lose the read.
 *
 * The drawer fired markAsRead and then set window.location.href in the same
 * tick. That starts a full document unload, and a fetch still in flight when
 * that happens is not guaranteed to be delivered — so the read could be lost
 * for exactly the notifications that have somewhere to go, which is most of
 * them. It also meant the optimistic state change never got a frame to paint
 * before the page was torn down.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const markAsRead = vi.fn(() => Promise.resolve())
let storeValue: Record<string, unknown> = {}
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => storeValue,
}))

import { NotificationDrawer } from '../notification-drawer'

const notification = {
  id: 'n1', user_id: 'u1', comment_id: null, asset_id: null, project_id: null,
  type: 'comment' as const, read: false, created_at: '2024-01-01T00:00:00Z',
  asset_name: null, actor_name: 'Ada', comment_preview: 'hi',
}

beforeEach(() => {
  markAsRead.mockClear()
  storeValue = {
    markAsRead,
    markAllRead: vi.fn(() => Promise.resolve()),
    notifications: [notification],
    unreadCount: 1,
    isLoading: false,
    fetchNotifications: vi.fn(),
  }
})

/** The handler's own body. Anchored from its start: `return (` appears
 *  earlier in the file too, and an unanchored search sliced the wrong
 *  region — which made one of these assertions compare unrelated offsets. */
function handlerSource(): string {
  const src = readFileSync(join(__dirname, '..', 'notification-drawer.tsx'), 'utf8')
  const start = src.indexOf('async function handleClick')
  return src
    .slice(start, src.indexOf('return (', start))
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

describe('reading a notification', () => {
  it('marks it read on click', async () => {
    render(<NotificationDrawer open onClose={vi.fn()} />)
    await userEvent.click(screen.getByText(/Ada/))
    expect(markAsRead).toHaveBeenCalledWith('n1')
  })

  it('awaits the write before navigating away', () => {
    // Asserted at the source: jsdom cannot perform or observe a real document
    // unload, so the ordering that matters here has no runtime signal to
    // check. What is checked is that the await exists and precedes the
    // navigation.
    const code = handlerSource()
    expect(code).toContain('await markAsRead(')
    expect(code.indexOf('await markAsRead(')).toBeLessThan(code.indexOf('window.location.href'))
  })

  it('still navigates when the write fails', () => {
    // Failing to record a read is not a reason to refuse to go where the
    // user asked to go.
    const code = handlerSource()
    expect(code).toContain('catch')
    expect(code.indexOf('catch')).toBeLessThan(code.indexOf('window.location.href'))
  })
})
