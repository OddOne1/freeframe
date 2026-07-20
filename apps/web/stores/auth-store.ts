import { create } from 'zustand'
import { User } from '@/types'
import { api } from '@/lib/api'
import { clearTokens } from '@/lib/auth'

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isSuperAdmin: boolean
  /** Superuser or above (i.e. not the bottom 'user' tier) -- can create
   * projects, send single invites, hold owner/admin on a project. */
  isSuperuserOrAbove: boolean
  isLoading: boolean
  setUser: (user: User) => void
  logout: () => void
  fetchUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  isAuthenticated: false,
  isSuperAdmin: false,
  isSuperuserOrAbove: false,
  isLoading: false,

  setUser: (user: User) => {
    set({
      user,
      isAuthenticated: true,
      isSuperAdmin: user.role === 'superadmin',
      isSuperuserOrAbove: user.role !== 'user',
    })
  },

  logout: () => {
    clearTokens()
    set({
      user: null,
      isAuthenticated: false,
      isSuperAdmin: false,
      isSuperuserOrAbove: false,
    })
  },

  fetchUser: async () => {
    set({ isLoading: true })
    try {
      const user = await api.get<User>('/auth/me')
      set({
        user,
        isAuthenticated: true,
        isSuperAdmin: user.role === 'superadmin',
        isSuperuserOrAbove: user.role !== 'user',
      })
    } catch {
      set({
        user: null,
        isAuthenticated: false,
        isSuperAdmin: false,
        isSuperuserOrAbove: false,
      })
    } finally {
      set({ isLoading: false })
    }
  },
}))
