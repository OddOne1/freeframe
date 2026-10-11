'use client'

import * as React from 'react'

/**
 * What a card click MEANS, decided per gesture by the pointer that made it
 * (§227b item 1).
 *
 * The bug: `asset-grid.tsx` opened an asset on `onDoubleClick` and the grid
 * folder card did the same, so on a phone a single tap selected and nothing
 * visible happened. §227 removed the Comments tab that used to make that
 * selection worth something, so a tap became a dead gesture and a
 * double-tap the only way into the viewer.
 *
 * The decision is per GESTURE, not per device, and that distinction is the
 * whole reason this file exists:
 *
 *  - A tap and a mouse click both arrive as `click`, so `onClick` alone
 *    cannot tell them apart.
 *  - The `click` event is NOT reliably a `PointerEvent` — in jsdom (and in
 *    Safari) `click.pointerType` is `undefined` even for a real mouse
 *    gesture, measured. So the type is recorded on `pointerdown`, where it
 *    is always present, and read by the click that follows.
 *  - No width breakpoint and no device-level `(hover: none)` test: an iPad
 *    with a trackpad must open on a finger tap and select on a trackpad
 *    click, within the same second, on the same card. A media query cannot
 *    express that; the gesture that is actually happening can.
 *
 * `(hover: none)` stays what it was — a CSS visibility rule for controls
 * that would otherwise only appear on hover. It decides what is PAINTED,
 * never what a click does.
 *
 * One instance per component serves every card it renders: a pointer
 * gesture is a global, serial thing — pointerdown and the click it causes
 * are adjacent, and there is no second finger pressing a different card
 * in between.
 */
export type GesturePointer = 'mouse' | 'touch' | 'pen'

/**
 * Anything that is not a finger or a stylus is treated as a mouse — which
 * is also what an unknown or absent `pointerType` gets. Defaulting the
 * other way would hand single-click-opens to every mouse user the moment a
 * browser stopped telling us, and "desktop behaviour is exactly as today"
 * is the constraint that must survive a surprise.
 */
export function coarsePointer(pointerType: string | null | undefined): GesturePointer {
  return pointerType === 'touch' || pointerType === 'pen' ? pointerType : 'mouse'
}

/** What the click belonging to the recorded gesture should do. */
export type TapIntent = 'open' | 'toggle' | 'select'

export interface TapIntentOptions {
  /**
   * Is anything in this view selected right now? Then a tap extends or
   * undoes that selection instead of navigating away from it — the
   * standard multi-select rule, and on a phone the only way a second item
   * can ever be added once a tap opens.
   */
  selectionActive?: boolean
  /**
   * For the one surface where a plain MOUSE click already opens today: the
   * list layout's folder rows. "Mouse behaviour is unchanged" outranks any
   * wish to make the four surfaces agree, so that row keeps its
   * single-click open rather than quietly becoming a select.
   */
  mouseClickOpens?: boolean
}

export function usePointerGesture() {
  /**
   * `mouse` until a pointerdown says otherwise, so a synthetic or
   * programmatic click — one with no gesture in front of it — behaves the
   * way the desktop always has.
   */
  const pointer = React.useRef<GesturePointer>('mouse')

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    pointer.current = coarsePointer(e.pointerType)
  }, [])

  const tapIntent = React.useCallback(
    ({ selectionActive = false, mouseClickOpens = false }: TapIntentOptions = {}): TapIntent => {
      if (pointer.current !== 'mouse') return selectionActive ? 'toggle' : 'open'
      return mouseClickOpens ? 'open' : 'select'
    },
    [],
  )

  /**
   * A double-click opens only when it was made with a mouse. A double TAP
   * would otherwise open twice: its first tap has already opened the item,
   * and `dblclick` fires after both clicks.
   */
  const doubleOpens = React.useCallback(() => pointer.current === 'mouse', [])

  return { onPointerDown, tapIntent, doubleOpens }
}
