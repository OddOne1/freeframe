'use client'

import * as React from 'react'

/**
 * Track a CSS media query from React (§142).
 *
 * Needed where a layout decision has to change BEHAVIOUR, not just
 * visibility: the share viewer's asset tap opens the full-screen viewer on
 * mobile because there is no side panel to show a selection in, and CSS
 * cannot rewrite a click handler.
 *
 * Starts false and resolves in a layout effect rather than reading
 * matchMedia during render: this component tree renders on the server,
 * where `window` does not exist, and a `useState` initializer that touched
 * it would be a hydration mismatch. The one-frame flash that would
 * otherwise cost us is avoided by keeping every purely-visual breakpoint in
 * Tailwind, where the server and client agree.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false)

  React.useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(query)
    setMatches(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Tailwind's `xl` breakpoint — where this app puts its right-hand panels. */
export const XL_UP = '(min-width: 1280px)'
