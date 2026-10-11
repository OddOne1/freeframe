import { create } from 'zustand'

/**
 * Whether the phone's view-settings pane is on screen (§227).
 *
 * §224 opened that pane from a bottom tab bar on the project view. The
 * owner's decision in §227: the three tabs (Assets / Comments / Settings)
 * only make sense INSIDE an asset, so the bar is gone from the project
 * view and the pane is opened by a cogwheel in the global header instead.
 *
 * Which is why this is a store and not `useState` in the project page: the
 * button is in `components/layout/header.tsx`, mounted by the dashboard
 * layout, and the pane is in `projects/[id]/page.tsx`. Neither is an
 * ancestor of the other, and threading a callback from the layout through
 * every page to reach one of them would make every other page carry a prop
 * about a pane it does not have.
 *
 * Deliberately NOT persisted, unlike `view-store`: which settings you
 * prefer is a preference, having the pane open is not. A persisted `true`
 * would mean arriving at a project with the grid covered.
 */
interface MobileViewSettingsStore {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useMobileViewSettingsStore = create<MobileViewSettingsStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))

/**
 * Does the page at this pathname have view settings to show?
 *
 * The project view and a folder inside it — `/projects/{id}`, with the
 * folder in a query parameter, so one pathname covers both. NOT the
 * projects list (nothing to size), not the asset viewer (§228 owns that
 * screen and its own tab bar), not `/projects/{id}/collections`.
 *
 * Exported so the Header and its test ask the same question, rather than
 * the test re-deriving a regex that could drift from this one.
 */
export function pathHasMobileViewSettings(pathname: string): boolean {
  return /^\/projects\/[^/]+$/.test(pathname)
}
