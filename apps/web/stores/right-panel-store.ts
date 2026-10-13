import { create } from 'zustand'

/**
 * Is there a right-hand panel on this screen at all? (§232 item 2)
 *
 * The header's panel toggle used to be rendered on every path except
 * `/projects` and to assume a panel was there to toggle. §232 removes the
 * project/folder view's panel — and with it the only panel most of those
 * paths ever had — so the toggle has to know. `pathname !== '/projects'`
 * cannot answer it: the one panel left (a share link's Settings and
 * Activity) lives at the SAME pathname as the project/folder view, chosen
 * by state rather than by URL.
 *
 * So the page that has a panel says so, and the header renders the toggle
 * only then. A dead toggle is what §224 was reported for; a toggle that
 * cannot be dead is the fix.
 *
 * This also removes a pre-existing dead toggle that was never reported:
 * /assets, /notifications, every /settings page and
 * /projects/{id}/collections all rendered the button, and none of them has
 * ever had a panel — nothing but the project page reads `rightPanelOpen`.
 *
 * A store, like `mobile-view-settings-store`, because the two components
 * involved are siblings under the dashboard layout: the button is in
 * `components/layout/header.tsx` and the panel is in
 * `projects/[id]/page.tsx`.
 *
 * Deliberately NOT persisted: "there is a panel on the screen in front of
 * me" is a fact about this render, not a preference. `rightPanelOpen` in
 * `view-store` is the preference and is still persisted, unchanged.
 */
interface RightPanelStore {
  /** Set by the page that renders a panel, for as long as it renders one. */
  available: boolean
  setAvailable: (available: boolean) => void
}

export const useRightPanelStore = create<RightPanelStore>((set) => ({
  available: false,
  setAvailable: (available) => set({ available }),
}))
