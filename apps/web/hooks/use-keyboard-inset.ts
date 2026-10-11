'use client'

import * as React from 'react'

/**
 * How many CSS pixels of the layout viewport the on-screen keyboard covers.
 *
 * On iOS Safari the LAYOUT viewport does not shrink when the keyboard comes
 * up — `100dvh`, `position: fixed` and `inset-0` all keep measuring the
 * full screen, so a comment input pinned to the bottom of the page ends up
 * behind the keyboard. What does change is the VISUAL viewport, which is
 * what `window.visualViewport` reports.
 *
 * The inset is `innerHeight - (visualViewport.height + visualViewport.offsetTop)`:
 * the band at the bottom of the layout viewport that is no longer visible.
 * `offsetTop` matters because Safari also scrolls the visual viewport up to
 * keep the focused field in view, and without it the inset double-counts
 * that shift and pushes the input off the top.
 *
 * Returns 0 when there is no `visualViewport` (older browsers, jsdom, the
 * server) and on every desktop, where the keyboard is hardware. 0 means
 * "change nothing", so an environment that cannot answer costs nothing.
 *
 * NOT TESTED on a real iPhone — see the §228 report. Chromium's device
 * emulation has no software keyboard, so what is verified here is that the
 * inset is applied, that it is 0 without a keyboard, and that the input
 * stays inside the visual viewport when the inset is simulated.
 */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = React.useState(0)

  React.useEffect(() => {
    if (!enabled) {
      setInset(0)
      return
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
    if (!vv) return

    const update = () => {
      const covered = window.innerHeight - (vv.height + vv.offsetTop)
      // Rounded and floored: sub-pixel noise from Safari's zoom would
      // otherwise re-render this on every scroll frame, and a negative
      // value (which happens mid-pinch) must never pull the input down.
      setInset(Math.max(0, Math.round(covered)))
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [enabled])

  return inset
}
