import { create } from 'zustand'
import { Notification } from '@/types'
import { api } from '@/lib/api'

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  isLoading: boolean
  fetchNotifications: () => Promise<void>
  markAsRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  incrementUnread: () => void
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,

  fetchNotifications: async () => {
    set({ isLoading: true })
    try {
      const notifications = await api.get<Notification[]>('/me/notifications')
      const unreadCount = notifications.filter((n) => !n.read).length
      set({ notifications, unreadCount })
    } finally {
      set({ isLoading: false })
    }
  },

  /**
   * §120 — the badge clears FIRST, then the write is sent.
   *
   * It used to await the POST before touching local state, so the dot
   * outlived the click by a whole round trip. Worse, the drawer's item
   * handler fires this and then immediately sets window.location.href: the
   * document starts unloading while the update is still pending, so the
   * state change never painted and, for a request still in flight, may never
   * have reached the server either. Same shape as §31's share-link toggles,
   * fixed the same way.
   *
   * Rolls back on failure rather than swallowing it: a dot that reappears is
   * the truth (the read did not persist), where a dot that stays cleared
   * over a failed write is a lie until the next refetch.
   */
  markAsRead: async (id: string) => {
    const previous = get().notifications
    if (!previous.some((n) => n.id === id && !n.read)) return

    const notifications = previous.map((n) => (n.id === id ? { ...n, read: true } : n))
    set({ notifications, unreadCount: notifications.filter((n) => !n.read).length })

    try {
      await api.post(`/me/notifications/${id}/read`)
    } catch (err) {
      set({ notifications: previous, unreadCount: previous.filter((n) => !n.read).length })
      throw err
    }
  },

  markAllRead: async () => {
    const previous = get().notifications
    const previousUnread = get().unreadCount
    set({
      notifications: previous.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    })

    try {
      await api.post('/me/notifications/read-all')
    } catch (err) {
      set({ notifications: previous, unreadCount: previousUnread })
      throw err
    }
  },

  incrementUnread: () => {
    set((state) => ({ unreadCount: state.unreadCount + 1 }))
  },
}))
