'use client'

import * as React from 'react'
import { ArrowUpDown, SlidersHorizontal } from 'lucide-react'
import { AppearanceControls } from './appearance-popover'
import { SortOptions } from './sort-popover'

/**
 * The phone Settings tab (§224).
 *
 * Everything that lives in the toolbar's two popovers on a desktop, as a
 * full-screen pane — because on a 390px screen the toolbar has no room for
 * "Appearance" and "Sorted by Date" beside Share, New Folder and Upload.
 *
 * It renders `AppearanceControls` and `SortOptions`, the same components
 * the popovers render, bound to the same `useViewStore`. There is no
 * second copy of any setting and no second store: changing the card size
 * here is the same write the desktop popover makes, so the two agree by
 * construction rather than by being kept in step.
 *
 * `sizeFirst` puts Card Size and Thumbnail Scale at the top, which is the
 * owner's stated first control: on a phone it decides how many clips fit on
 * screen, which matters more here than anywhere else.
 */
export function MobileViewSettings() {
  return (
    <div className="flex-1 overflow-y-auto">
      <section className="px-4 py-4 space-y-4">
        <h2 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Asset size &amp; appearance
        </h2>
        <AppearanceControls sizeFirst />
      </section>

      <section className="border-t border-border px-4 py-4 space-y-2">
        <h2 className="flex items-center gap-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          <ArrowUpDown className="h-3.5 w-3.5" />
          Sort by
        </h2>
        <SortOptions />
      </section>
    </div>
  )
}
