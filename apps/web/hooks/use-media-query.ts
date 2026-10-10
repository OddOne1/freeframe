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

/**
 * Is the viewport at least `xl` RIGHT NOW? (§224)
 *
 * A one-shot read, not a subscription, for the one rule that needs it: a
 * right-hand panel starts closed below `xl`, because below `xl` it is an
 * overlay rather than a column and arriving to a covered page is not what
 * a persisted "open" meant. Called from an effect, never during render.
 *
 * Returns `true` when there is no `matchMedia` — on the server, and in a
 * test that has not stubbed it. `true` means "leave the panel alone", so
 * an environment that cannot answer the question changes nothing.
 */
export function viewportIsXlUp(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia(XL_UP).matches
}

/**
 * Tailwind's `md` breakpoint — where §224 puts the phone/tablet line.
 *
 * Phrased as a min-width rather than `(max-width: 767px)` so the hook's
 * `false` starting value means "not known to be wide", which is the safe
 * default for a decision that only ever ADDS a narrow-screen affordance.
 */
export const MD_UP = '(min-width: 768px)'
