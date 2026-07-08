'use client'

import { useEffect } from 'react'
import { useThemeStore } from '@/stores/theme-store'
import { useAuthStore } from '@/stores/auth-store'

export function ThemeInitializer() {
  const theme = useThemeStore((s) => s.theme)
  const applyTheme = useThemeStore((s) => s.applyTheme)
  const syncFromServer = useThemeStore((s) => s.syncFromServer)
  const user = useAuthStore((s) => s.user)

  // Apply the persisted theme once Zustand's localStorage rehydration has
  // actually finished. Calling `applyTheme` directly on mount (using the
  // `theme` captured in this render's closure) races the async rehydration:
  // if hydration lands after this effect runs, `theme` here is still the
  // hardcoded 'dark' default, and `resolvedTheme` gets locked to 'dark' in
  // React state even though the store's `theme` field later updates
  // correctly — because this effect has an empty dep array and never
  // re-fires. `persist.onFinishHydration` (and the `hasHydrated` check for
  // when it's already done by the time we get here) sidesteps the race by
  // reacting to the real hydration event instead of guessing at timing.
  useEffect(() => {
    const applyFromState = (state: { theme: typeof theme }) => applyTheme(state.theme)

    if (useThemeStore.persist.hasHydrated()) {
      applyFromState(useThemeStore.getState())
    }

    const unsubscribe = useThemeStore.persist.onFinishHydration(applyFromState)
    return unsubscribe
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync from server when user loads (server wins if it has a value)
  useEffect(() => {
    if (user?.preferences) {
      syncFromServer(user.preferences)
    }
  }, [user?.preferences, syncFromServer])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme, applyTheme])

  return null
}
