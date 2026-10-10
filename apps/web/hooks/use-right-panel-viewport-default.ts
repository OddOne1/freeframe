'use client'

import * as React from 'react'
import { useViewStore } from '@/stores/view-store'
import { viewportIsXlUp } from '@/hooks/use-media-query'

/**
 * Below `xl`, the right panel starts CLOSED — whatever the persisted value
 * says (§224).
 *
 * `rightPanelOpen` is persisted to localStorage and defaults to `true`, for
 * a good reason: on a desktop the panel is a column beside the content and
 * someone who had it open wants it open again. Below `xl` the same flag now
 * opens an overlay drawer, and on a phone a full-screen pane — so carrying
 * a desktop session's `true` onto a phone means arriving at a project and
 * finding the content covered by a panel nobody asked for.
 *
 * It closes rather than clearing the flag, so the preference survives for
 * the next desktop visit: it is per-load presentation, not a reset.
 *
 * ONCE per page load, not per render and not on resize. Dragging a desktop
 * window narrow should not slam the panel shut mid-use, and rotating a
 * tablet should not either — the rule is about what you arrive to. Mounted
 * in DashboardShell, which is the one component that mounts exactly once
 * per load and survives every client-side route change inside the app.
 */
export function useRightPanelViewportDefault(): void {
  React.useEffect(() => {
    if (viewportIsXlUp()) return
    // Read through getState rather than subscribing: this must not re-run
    // when the user then opens the panel themselves.
    useViewStore.getState().setRightPanelOpen(false)
  }, [])
}
