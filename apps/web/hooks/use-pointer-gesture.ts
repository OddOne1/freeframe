'use client'

import * as React from 'react'

/**
 * What a click on a card MEANS, decided per gesture (§232 item 1).
 *
 * §227b made this hook because a tap and a mouse click arrive as the same
 * `click` event and had to mean different things: a tap opened, a click
 * selected, and a mouse needed a DOUBLE click to open. The owner, after
 * living with it: "we would want to open folders and assets on the first
 * click" — the same as a tap, on every pointer.
 *
 * So the pointer TYPE no longer decides anything, and nothing here reads
 * it any more. `coarsePointer`, the recorded `pointerType` and
 * `doubleOpens()` are gone rather than collapsed to a constant: a branch
 * that can only go one way is a branch someone will try to use again.
 *
 * Two things still have to be decided per gesture, and this is still the
 * one place that decides them:
 *
 *  1. A click that ENDED A DRAG must not open anything. HTML5 drag and
 *     drop (§223's move-onto-a-folder) normally swallows the click — but
 *     only once the browser has actually promoted the gesture to a drag.
 *     A press, a move and a release that the browser does NOT promote
 *     still ends in a `click`, at the release point, and before §232 that
 *     click only selected, so it was harmless. Now it would navigate.
 *     The guard is geometric and needs no drag API: remember where the
 *     pointer went DOWN and compare it with where the click landed.
 *
 *  2. The SECOND click of a double-click must not open a second time.
 *     Years of double-clicking this grid is muscle memory, and two opens
 *     is two `router.push`es — two history entries for one gesture, so
 *     one Back press would not get you out. `MouseEvent.detail` is the
 *     click count within the sequence, which is exactly the question.
 *
 * One instance per component serves every card it renders: a pointer
 * gesture is a global, serial thing — pointerdown and the click it causes
 * are adjacent, and there is no second finger pressing a different card
 * in between.
 */

/**
 * How far the pointer may travel between `pointerdown` and `click` and
 * still count as a click rather than a drag, in CSS pixels.
 *
 * 5 and not 0: a real click wobbles a pixel or two, and a trackpad tap
 * wobbles more than a mouse. 5 and not 20: a drag that is promoted by the
 * browser fires no click at all, so everything this number has to catch
 * is a gesture the browser decided was NOT a drag — and the only cost of
 * being strict is that a sloppy click does nothing instead of opening,
 * which is recoverable. Chromium's own drag threshold is also ~5px.
 */
const DRAG_SLOP_PX = 5

/** What the click belonging to the recorded gesture should do. */
export type TapIntent = 'open' | 'toggle' | 'ignore'

export interface TapIntentOptions {
  /**
   * Is anything in this view selected right now? Then a click extends or
   * undoes that selection instead of navigating away from it — the
   * standard multi-select rule, which §227b introduced for touch and
   * §232 extends to every pointer. It is also what makes single-click
   * open safe: with a selection on screen, no plain click can lose it.
   */
  selectionActive?: boolean
}

export function usePointerGesture() {
  /**
   * Where the pointer went down, or null when the click that is being
   * judged had no gesture in front of it at all — a programmatic
   * `.click()`, or a keyboard Enter, both of which report (0,0) and must
   * NOT be read as a 400px drag.
   */
  const origin = React.useRef<{ x: number; y: number } | null>(null)

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    origin.current = { x: e.clientX, y: e.clientY }
  }, [])

  const tapIntent = React.useCallback(
    (e: React.MouseEvent, { selectionActive = false }: TapIntentOptions = {}): TapIntent => {
      const from = origin.current
      // Consumed: one pointerdown belongs to one click. Leaving it would
      // let a stale origin judge the next gesture — e.g. a click whose
      // pointerdown was swallowed by a child that stops propagation.
      origin.current = null

      // The 2nd, 3rd, … click of a multi-click sequence. The first one has
      // already acted.
      if (e.detail > 1) return 'ignore'

      if (
        from &&
        (Math.abs(e.clientX - from.x) > DRAG_SLOP_PX ||
          Math.abs(e.clientY - from.y) > DRAG_SLOP_PX)
      ) {
        return 'ignore'
      }

      return selectionActive ? 'toggle' : 'open'
    },
    [],
  )

  return { onPointerDown, tapIntent }
}

/**
 * Enter opens, Space toggles the selection — on a card that has focus
 * (§232 item 1).
 *
 * Shared by all four surfaces for the same reason the click logic is:
 * four copies of "which key means what" is four chances to disagree.
 * Returns true when the key was handled, so the caller can leave
 * everything else — arrows, Backspace, Tab — completely alone.
 *
 * Space is `preventDefault`ed, because the default on a focused element
 * is to scroll the page.
 */
export function cardKeyIntent(e: React.KeyboardEvent): 'open' | 'toggle' | null {
  if (e.defaultPrevented) return null
  // A key pressed inside a control the card happens to contain — the
  // kebab button, the checkbox, a rename field — belongs to that control.
  if (e.target !== e.currentTarget) return null
  if (e.key === 'Enter') {
    e.preventDefault()
    return 'open'
  }
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault()
    return 'toggle'
  }
  return null
}
