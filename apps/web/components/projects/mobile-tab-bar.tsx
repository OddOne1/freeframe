'use client'

import * as React from 'react'
import { LayoutGrid, MessageSquare, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Which of the three phone panes is on screen (§224; §228 revives it). */
export type PhoneTab = 'assets' | 'panel' | 'settings'

const TABS: { value: PhoneTab; label: string; icon: React.ElementType }[] = [
  { value: 'assets', label: 'Assets', icon: LayoutGrid },
  { value: 'panel', label: 'Comments', icon: MessageSquare },
  { value: 'settings', label: 'Settings', icon: SlidersHorizontal },
]

/**
 * The phone bottom tab bar (§224).
 *
 * NOT MOUNTED ANYWHERE as of §227. The project (Assets/Folders) view was
 * its only caller, and the owner's decision there is that Assets /
 * Comments / Settings only make sense INSIDE an asset: on the project view
 * there are no comments to read and the view settings are now a cogwheel
 * in the header, so a three-tab bar was switching between one real pane
 * and two that did not belong. The grid got its height back instead.
 *
 * Kept, deliberately and by instruction, because §228 builds the asset
 * viewer on a phone and these three tabs are exactly that screen's panes.
 * The §224b z-index relationship — the nav drawer and its scrim must paint
 * ABOVE this bar, or the drawer's foot is hidden behind it — is still
 * asserted against this file by
 * components/layout/__tests__/sidebar-user-block.test.tsx, so the fix
 * cannot be lost while the bar is out of the tree.
 *
 * Phones only (`md:hidden`): at `md`+ the right panel is a drawer opened by
 * the toolbar's existing toggle and the view settings are back in the
 * toolbar popovers, so there are no panes to switch between.
 *
 * `env(safe-area-inset-bottom)` padding, because `viewport-fit=cover` in
 * the root layout lets the page paint under the iPhone home indicator —
 * without it the labels sit beneath it and the bottom few pixels of each
 * tab are not tappable.
 */
export function MobileTabBar({
  value,
  onChange,
  commentBadge,
}: {
  value: PhoneTab
  onChange: (tab: PhoneTab) => void
  /** Shown on the Comments tab when an asset is selected, so it is obvious
   *  the tab now has something in it. */
  commentBadge?: boolean
}) {
  return (
    <nav
      data-testid="mobile-tab-bar"
      aria-label="Project views"
      // The safe-area padding is a class rather than an inline style so it
      // is visible to anything reading the markup, and so it goes through
      // the same build as every other utility here.
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-bg-secondary pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon
        const active = value === tab.value
        return (
          <button
            key={tab.value}
            onClick={() => onChange(tab.value)}
            aria-current={active ? 'page' : undefined}
            // h-14 (56px) — comfortably past the 44px minimum, and the
            // whole third of the width is the hit area.
            className={cn(
              'relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 transition-colors',
              active ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary',
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
            <span className={cn('text-[10px]', active && 'font-medium')}>{tab.label}</span>
            {tab.value === 'panel' && commentBadge && (
              <span className="absolute right-[calc(50%-18px)] top-2 h-1.5 w-1.5 rounded-full bg-accent" />
            )}
          </button>
        )
      })}
    </nav>
  )
}
