import * as React from 'react'
import type { SharePermission, FieldsVisibility } from '@/types'

/**
 * Which sidebar panels a share link shows (CLAUDE.md §33).
 *
 * Written once and used by BOTH share viewers — `app/share/[token]/page.tsx`
 * (single-asset shares) and `components/share/folder-share-viewer.tsx`
 * (folder shares). They previously each carried their own version of this
 * decision and each got it wrong differently: page.tsx kept a Comments tab
 * that only said "comments are disabled", the folder viewer showed a Fields
 * tab that rendered nothing at all.
 *
 * Two copies of one rule drifting is a recurring failure in this codebase
 * (§30's `_require_download_variant`, §32's `resolveStreamUrl`), so this is
 * a hook rather than a pattern to reproduce.
 *
 * The rules, decided 2026-08-18:
 *  - neither panel enabled -> no sidebar, and no toggle button either;
 *    there is nothing to open.
 *  - exactly one enabled -> that panel, with NO tab switcher. A switcher
 *    with one live tab and one dead one is worse than no switcher.
 *  - both enabled -> today's switcher.
 *
 * Fields is independent of the comments permission, not a fallback for it.
 *
 * §188 — and so is READING comments, now. `permission` used to decide both
 * whether a viewer could post a comment and whether the panel existed at
 * all, so a view-only link hid the team's existing discussion outright.
 * Those were never one decision on the server: GET /share/{token}/comments
 * has no permission gate and never had one; only POST does. `showComments`
 * below reads its own persisted flag, and the posting gates (`canComment`,
 * and the `approve` checks) are deliberately left alone.
 */

export type { FieldsVisibility }
export type ShareSidebarTab = 'comments' | 'fields'

export interface ShareSidebar {
  /** Render the sidebar at all — and its open/close toggle. */
  showSidebar: boolean
  /** Render the Comments/Fields switcher. False when only one panel exists. */
  showTabSwitcher: boolean
  showComments: boolean
  showFields: boolean
  /** `full` unlocks technical metadata + sidecar data. */
  fieldsLevel: FieldsVisibility
  /** The tab to render now. Always a visible one. */
  activeTab: ShareSidebarTab
  setActiveTab: (tab: ShareSidebarTab) => void
}

export function useShareSidebar({
  permission,
  fieldsVisibility,
  showComments: showCommentsSetting,
}: {
  /** Kept in the signature though the sidebar no longer branches on it:
   *  every caller already holds it, and dropping it would make the next
   *  visibility rule that DOES need it a signature change. */
  permission?: SharePermission | string | undefined
  fieldsVisibility: FieldsVisibility | undefined
  /** `show_comments` off the link. Undefined — an older cached response,
   *  or the field renamed on one side only — falls back to SHOWING them:
   *  that is the column default, and the safer failure for a panel a
   *  reader expects. A missing panel looks like a broken app. */
  showComments?: boolean | undefined
}): ShareSidebar {
  const showComments = showCommentsSetting ?? true
  const level: FieldsVisibility = fieldsVisibility ?? 'disabled'
  const showFields = level !== 'disabled'

  const [requestedTab, setRequestedTab] = React.useState<ShareSidebarTab>('comments')

  // Derived, never stored: a stored active tab can point at a panel that has
  // since been switched off, which is how a "dead tab" appears in the first
  // place. With one panel enabled there is only one answer regardless of
  // what was last clicked.
  let activeTab: ShareSidebarTab = requestedTab
  if (!showComments && showFields) activeTab = 'fields'
  else if (showComments && !showFields) activeTab = 'comments'

  return {
    showSidebar: showComments || showFields,
    showTabSwitcher: showComments && showFields,
    showComments,
    showFields,
    fieldsLevel: level,
    activeTab,
    setActiveTab: setRequestedTab,
  }
}
