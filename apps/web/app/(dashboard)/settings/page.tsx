'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { MD_UP } from '@/hooks/use-media-query'
import { useVisibleSettingsNav } from '@/lib/settings-nav'
import { SettingsSectionList } from '@/components/settings/settings-section-list'

/**
 * `/settings` — the section list on a phone, a redirect on a desktop (§229).
 *
 * This used to be a server component whose whole body was
 * `redirect('/settings/admin')`. Two things were wrong with that and one
 * is new:
 *
 *  - NEW: on a phone `/settings` has to BE something — the list of
 *    sections — so the redirect cannot happen on the server, which does
 *    not know the viewport.
 *  - OLD, and a real bug: it sent everybody to the Admin page, which is
 *    superadmin-only. A plain member landed on a page that immediately
 *    bounced them to `/`, so "Settings" in the command palette was a
 *    link to the dashboard for most of the people in the workspace. It
 *    now goes to the first section the user may actually see, which is
 *    Profile for everyone (it is ungated and first in the list), and is
 *    read from the same gate the nav uses rather than hardcoded.
 *
 * `replace`, not `push`: this route is a signpost, and a Back out of
 * Profile should leave Settings rather than bounce through the signpost
 * again. The phone path pushes nothing at all — the list is the page.
 *
 * The JS here is a media-query read, not a render branch: the list is
 * `md:hidden` in CSS, so a desktop never paints it whatever the hook
 * says, and the redirect runs in a layout effect, before paint. The
 * listener stays attached because a window dragged wider while sitting on
 * the list should land on a section rather than on a blank column.
 */
export default function SettingsIndexPage() {
  const router = useRouter()
  const visibleGroups = useVisibleSettingsNav()

  // Always the first section this user may see. Read through a ref so the
  // effect below is not re-subscribed every time SWR revalidates the
  // project list that `useVisibleSettingsNav` consults.
  const firstHref = visibleGroups[0]?.[0]?.href ?? '/settings/profile'
  const firstHrefRef = React.useRef(firstHref)
  firstHrefRef.current = firstHref

  // `useLayoutEffect` on the client so the redirect is issued before the
  // browser paints an empty content column; `useEffect` on the server,
  // where React warns about the layout variant and neither runs anyway.
  const useIsomorphicLayoutEffect =
    typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia(MD_UP)
    const apply = () => {
      if (mq.matches) router.replace(firstHrefRef.current)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [router])

  return (
    <div className="md:hidden">
      <SettingsSectionList />
    </div>
  )
}
