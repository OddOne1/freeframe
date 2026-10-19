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

/**
 * Below Tailwind's `md` — the phone range the asset viewer rebuilds (§228).
 *
 * Phrased as a `max-width`, unlike `MD_UP` above, and deliberately so: the
 * hook starts `false`, so `false` has to mean "not known to be a phone",
 * which is the EXISTING desktop/drawer layout. That is the server-safe
 * default — the server renders the same tree the first client render does,
 * and `useMediaQuery` resolves in a layout effect, before paint, so a real
 * phone never shows a frame of the desktop tree.
 *
 * `MD_UP` cannot be reused here: `!useMediaQuery(MD_UP)` starts `true`,
 * which would mount the phone tree on every desktop load.
 */
export const BELOW_MD = '(max-width: 767px)'

/**
 * Is this a phone-width viewport? (§228)
 *
 * The ONE JavaScript breakpoint in the asset viewer. Everything purely
 * visual about the top bar is a container query in globals.css; this exists
 * only where a DIFFERENT TREE has to mount — the single-screen phone layout
 * versus the drawer, where version/status/rating render, and whether the
 * player shows its compact transport row. CSS cannot move a component from
 * one parent to another.
 */
export function useIsPhone(): boolean {
  return useMediaQuery(BELOW_MD)
}

/**
 * Below Tailwind's `lg` — where a 760px table stops fitting (§229).
 *
 * `BELOW_MD` is the phone line everywhere else in this app, and the
 * Settings sidebar follows it. The Admin users TABLE needs a wider line,
 * and the arithmetic says so: the sidebar is 224px, so a 768px tablet
 * leaves 496px of content for a table that declares `min-w-[760px]`.
 * Measured at 768x1024 against the pre-§229 build, 118 of that page's
 * interactive controls were off the right edge of the screen, reachable
 * only by dragging the table sideways inside its own card.
 *
 * Narrowing the sidebar to icons at that range — the other option §229
 * offered — does not fix it: 768 − 56 = 712, still 48px short of the
 * table, and 148 short of the Projects page's 860px one. So the sidebar
 * keeps its labels at every width and the TABLE is what changes: below
 * `lg` a user is a card, which needs no particular width at all.
 *
 * Phrased as a `max-width` for the same reason as `BELOW_MD`: the hook
 * starts `false`, and `false` has to mean "not known to be narrow",
 * which is the existing table.
 */
export const BELOW_LG = '(max-width: 1023px)'

/** Is this viewport too narrow for Settings' widest table? (§229) */
export function useBelowLg(): boolean {
  return useMediaQuery(BELOW_LG)
}

/**
 * A short touch screen in landscape — "compact landscape" (§228c item 6).
 *
 * The owner, with an iPhone on its side: "if flipped on the side the view
 * is really messy." He is looking at the DESKTOP viewer: the phone layout
 * is chosen by `BELOW_MD`, and an iPhone in landscape is 844px wide, so it
 * gets the layout built for a 1440px monitor — the full desktop top bar,
 * the project rail, the desktop transport row, and no comments panel at
 * all, in 390px of height that Safari's own chrome then cuts to ~280.
 *
 * Width cannot describe this screen, which is why this query does not use
 * it. What makes it different is a CAPABILITY and a SHAPE:
 *
 *   (hover: none) and (pointer: coarse)   a finger, not a mouse
 *   (max-height: 500px)                   and almost no vertical room
 *
 * Why each half is needed, measured against the devices this has to get
 * right:
 *
 *   iPhone 14 Pro landscape     844x390   matches — the owner's screen
 *   iPhone 16 Pro Max landscape 932x430   matches
 *   iPhone SE landscape         667x375   matches, and is BELOW md, so
 *                                         the width breakpoint alone would
 *                                         have given it the portrait
 *                                         single-screen layout stacked
 *                                         into 375px of height
 *   small Android landscape     740x360   matches
 *   foldable inner screen       884x1104  does NOT match (1104 > 500) —
 *                                         a tablet-shaped screen that
 *                                         happens to be touch-only
 *   iPad landscape             1024x768   does NOT match
 *   iPad Pro landscape         1180x820   does NOT match
 *   phone portrait              390x844   does NOT match; `useIsPhone`
 *                                         still owns that screen
 *   any desktop window, however short     does NOT match (hover: hover)
 *
 * 500px rather than a round 400 or 600: the tallest phone landscape in the
 * list is 430 and the shortest tablet landscape is 768, so the boundary
 * sits in a 338px gap with nothing in it. `pointer: coarse` on its own
 * would also catch a touch LAPTOP with a short window; a touch laptop has
 * a mouse too and reports `hover: hover`.
 */
export const COMPACT_LANDSCAPE =
  '(hover: none) and (pointer: coarse) and (max-height: 500px)'

/** Is this a short touch screen in landscape? (§228c item 6) */
export function useCompactLandscape(): boolean {
  return useMediaQuery(COMPACT_LANDSCAPE)
}

/**
 * Does this screen take its PHONE shape? (§228c item 6)
 *
 * The one question every compact control on this page actually asks: a
 * phone in portrait (`useIsPhone`) and a phone on its side (compact
 * landscape) both want the one-row top bar, the slim transport, the 36px
 * hit-area floor, the settings sheet instead of the LUT column, and
 * version/status/rating in the Fields tab rather than in the bar.
 *
 * §230 — and it is no longer only the viewer's question. Settings asks it
 * too: §229 built master–detail (the `/settings` list, then a full-width
 * section page) below `md`, and a phone on its side is the same phone, so
 * the `/settings` index redirect reads THIS hook rather than `MD_UP` on
 * its own. Deliberately the same call and not a second `isPhone ||
 * compactLandscape` beside it — two copies of "is this phone-shaped" is
 * how the viewer and Settings would start disagreeing about an iPhone SE
 * in landscape, where both halves are true at once.
 *
 * What they do NOT share is the LAYOUT — portrait stacks the panel under
 * the player, landscape puts it beside it — so the layout branch asks
 * `useCompactLandscape()` and `useIsPhone()` separately, and in that
 * order: at 667x375 BOTH are true, and the landscape answer is the one
 * that has to win.
 *
 * Starts `false`, like both hooks it reads, so the server and the first
 * client render still emit the desktop tree.
 */
export function usePhoneChrome(): boolean {
  const isPhone = useIsPhone()
  const compactLandscape = useCompactLandscape()
  return isPhone || compactLandscape
}
