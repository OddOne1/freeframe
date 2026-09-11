'use client'

import * as React from 'react'

/**
 * A viewer's own display choice, remembered for this tab only (§144).
 *
 * Deliberately sessionStorage, not localStorage and not the server:
 *  - server-side would mean one viewer's choice rewriting what every other
 *    holder of a public link sees, which is the share link creator's
 *    setting to make, not a guest's;
 *  - localStorage would outlive the visit, and the requirement is that a
 *    fresh visit shows the creator's default again.
 *
 * Reads in a layout effect rather than a `useState` initializer, and
 * reports `ready` so callers can hold off on work that depends on the
 * value. This page is server-rendered, so touching sessionStorage during
 * render would be a hydration mismatch — the same trap `useMediaQuery`
 * documents. `ready` exists so the share viewer can avoid firing its
 * first fetch with the creator default and then immediately re-fetching
 * with the stored sort.
 */
export function useSessionPreference<T extends string>(
  key: string,
  fallback: T,
  isValid: (v: string) => v is T,
): [T, (next: T) => void, boolean] {
  const [chosen, setChosen] = React.useState<T | null>(null)
  const [ready, setReady] = React.useState(false)

  React.useLayoutEffect(() => {
    let stored: string | null = null
    try {
      stored = window.sessionStorage.getItem(key)
    } catch {
      // Safari private mode throws on access. A viewer preference is not
      // worth breaking the page over — fall back to the creator's default.
    }
    setChosen(stored !== null && isValid(stored) ? stored : null)
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const update = React.useCallback(
    (next: T) => {
      setChosen(next)
      try {
        window.sessionStorage.setItem(key, next)
      } catch {
        // Same as above — the choice still applies for this render, it
        // just will not survive a folder navigation.
      }
    },
    [key],
  )

  // Null means "this viewer has not chosen", and while that holds the value
  // keeps TRACKING the creator's setting rather than freezing whatever it
  // happened to be at mount. That distinction is load-bearing: freezing it
  // would mean a link whose owner changes the sort no longer updates for
  // someone already looking at it, even though they never expressed a
  // preference of their own. Once they choose, their choice wins and the
  // creator's changes stop applying for the rest of the tab's session.
  const value = chosen ?? fallback

  return [value, update, ready]
}
