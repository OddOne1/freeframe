import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNotificationStore } from '../notification-store'
import type { Notification } from '@/types'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    // §120 — the store POSTs; this mock only had `patch`, so both read tests
    // have been failing with "api.post is not a function" since the endpoints
    // moved to /me/notifications. Stale test, not a stale store.
    post: vi.fn(),
  },
}))

import { api } from '@/lib/api'

const mockNotifications: Notification[] = [
  {
    id: 'n1',
    user_id: 'user-1',
    comment_id: null,
    asset_id: 'asset-1',
    type: 'comment',
    read: false,
    created_at: '2024-01-01T00:00:00Z',
    asset_name: null,
    actor_name: null,
    comment_preview: null,
    project_id: null,
  },
  {
    id: 'n2',
    user_id: 'user-1',
    comment_id: null,
    asset_id: 'asset-2',
    type: 'mention',
    read: true,
    created_at: '2024-01-02T00:00:00Z',
    asset_name: null,
    actor_name: null,
    comment_preview: null,
    project_id: null,
  },
]

describe('Notification store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      isLoading: false,
    })
  })

  it('has correct initial state', () => {
    const state = useNotificationStore.getState()
    expect(state.notifications).toEqual([])
    expect(state.unreadCount).toBe(0)
    expect(state.isLoading).toBe(false)
  })

  it('incrementUnread increments the unread count', () => {
    useNotificationStore.setState({ unreadCount: 3 })
    useNotificationStore.getState().incrementUnread()
    expect(useNotificationStore.getState().unreadCount).toBe(4)
  })

  it('incrementUnread increments from 0', () => {
    useNotificationStore.getState().incrementUnread()
    expect(useNotificationStore.getState().unreadCount).toBe(1)
  })

  it('fetchNotifications loads notifications and updates unread count', async () => {
    vi.mocked(api.get).mockResolvedValue(mockNotifications)

    await useNotificationStore.getState().fetchNotifications()

    const state = useNotificationStore.getState()
    expect(state.notifications).toEqual(mockNotifications)
    expect(state.unreadCount).toBe(1) // only n1 is unread
    expect(state.isLoading).toBe(false)
  })

  it('markAllRead resets unread count to 0', async () => {
    vi.mocked(api.post).mockResolvedValue(undefined)
    useNotificationStore.setState({ notifications: mockNotifications, unreadCount: 1 })

    await useNotificationStore.getState().markAllRead()

    const state = useNotificationStore.getState()
    expect(state.unreadCount).toBe(0)
    expect(state.notifications.every((n) => n.read)).toBe(true)
    expect(api.post).toHaveBeenCalledWith('/me/notifications/read-all')
  })

  it('markAsRead marks a specific notification as read', async () => {
    vi.mocked(api.post).mockResolvedValue(undefined)
    useNotificationStore.setState({ notifications: mockNotifications, unreadCount: 1 })

    await useNotificationStore.getState().markAsRead('n1')

    const state = useNotificationStore.getState()
    expect(state.notifications.find((n) => n.id === 'n1')?.read).toBe(true)
    expect(state.unreadCount).toBe(0)
    expect(api.post).toHaveBeenCalledWith('/me/notifications/n1/read')
  })

  describe('§120 — the badge clears before the round trip, not after', () => {
    it('drops the count synchronously, without waiting for the server', async () => {
      // The reported bug: the dot outlived the click by a whole round trip,
      // and the drawer then navigated away before it could ever paint.
      let resolve!: () => void
      vi.mocked(api.post).mockReturnValue(new Promise<void>((r) => { resolve = r }) as never)
      useNotificationStore.setState({ notifications: mockNotifications, unreadCount: 1 })

      const pending = useNotificationStore.getState().markAsRead('n1')
      // Not awaited yet — this is the instant the user sees.
      expect(useNotificationStore.getState().unreadCount).toBe(0)

      resolve()
      await pending
      expect(useNotificationStore.getState().unreadCount).toBe(0)
    })

    it('puts the dot back if the write fails', async () => {
      // A cleared dot over a failed write is a lie until the next refetch.
      vi.mocked(api.post).mockRejectedValue(new Error('offline'))
      useNotificationStore.setState({ notifications: mockNotifications, unreadCount: 1 })

      await expect(useNotificationStore.getState().markAsRead('n1')).rejects.toThrow('offline')

      const state = useNotificationStore.getState()
      expect(state.unreadCount).toBe(1)
      expect(state.notifications.find((n) => n.id === 'n1')?.read).toBe(false)
    })

    it('restores every notification if mark-all fails', async () => {
      vi.mocked(api.post).mockRejectedValue(new Error('offline'))
      useNotificationStore.setState({ notifications: mockNotifications, unreadCount: 1 })

      await expect(useNotificationStore.getState().markAllRead()).rejects.toThrow('offline')

      expect(useNotificationStore.getState().unreadCount).toBe(1)
      expect(useNotificationStore.getState().notifications.some((n) => !n.read)).toBe(true)
    })

    it('reads one of several without clearing the rest', async () => {
      // Intended semantics, confirmed from the existing UI rather than
      // assumed: per-item read on click, plus an explicit "Mark all read"
      // button and an Unread tab. Opening the panel deliberately marks
      // nothing — otherwise both of those stop meaning anything.
      vi.mocked(api.post).mockResolvedValue(undefined)
      const two = [
        { ...mockNotifications[0], id: 'a', read: false },
        { ...mockNotifications[0], id: 'b', read: false },
      ]
      useNotificationStore.setState({ notifications: two, unreadCount: 2 })

      await useNotificationStore.getState().markAsRead('a')

      const state = useNotificationStore.getState()
      expect(state.unreadCount).toBe(1)
      expect(state.notifications.find((n) => n.id === 'b')?.read).toBe(false)
    })

    it('does not send a second write for something already read', async () => {
      vi.mocked(api.post).mockResolvedValue(undefined)
      useNotificationStore.setState({
        notifications: [{ ...mockNotifications[0], id: 'a', read: true }],
        unreadCount: 0,
      })

      await useNotificationStore.getState().markAsRead('a')
      expect(api.post).not.toHaveBeenCalled()
    })
  })
})
