'use client'

import * as React from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { useRouter, useSearchParams } from 'next/navigation'
import { Shield } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { RequireTwoFactorSection } from '@/components/settings/require-two-factor-section'
import { BrandingSection } from '@/components/settings/branding-section'
import { UsersTab } from '@/components/settings/admin/users-tab'
import { PlatformTab } from '@/components/settings/admin/platform-tab'
import { EmailTab } from '@/components/settings/admin/email-tab'
import { AdminTabStrip } from '@/components/settings/admin/admin-tab-strip'
import {
  ADMIN_TABS,
  resolveAdminTab,
  type AdminTabValue,
} from '@/components/settings/admin/admin-tabs'

/**
 * Settings → Admin: one area, five tabs (§229).
 *
 * The owner: "the whole System settings need a visual overhaul to make
 * things visually more clear what belongs together. For example in the
 * Admin tab we could create sub tabs that can be switched up top for user
 * settings, platform settings, email settings etc. We could also bring
 * Branding into here as well, that way there is only one Admin setting to
 * hide."
 *
 * What this page was: one 1624-line scroll holding the single-superadmin
 * banner, platform storage, the timezone, the 2FA switch, the whole SMTP
 * form and then the user tables — in that order, with nothing to say that
 * the first five had anything to do with each other or not. Branding was
 * a separate nav entry beside it.
 *
 * What it is now: the same sections, unchanged, behind five tabs — Users,
 * Platform, Security, Email, Branding. Not one control was redesigned and
 * not one changed what it does; they were grouped, given a header each,
 * and moved into files that can be mounted on their own.
 *
 * ── The tab lives in the URL ──────────────────────────────────────────
 *
 * `?tab=users|platform|security|email|branding`, so a tab can be linked,
 * bookmarked and reloaded; `/settings/branding` redirects to
 * `?tab=branding`, which is what keeps the old bookmark working.
 *
 * `router.replace`, not `push`: a tab is a view of one page, and five
 * pushes is five Back presses to leave a page the user visited once.
 * Back from here goes wherever they came from.
 *
 * An unknown `?tab=` resolves to Users rather than rendering an empty
 * page — see `resolveAdminTab`, which the tests drive directly.
 *
 * ── One tab, one tab's data ───────────────────────────────────────────
 *
 * Radix only renders the ACTIVE `Tabs.Content`, so each tab's hooks only
 * run while it is open:
 *
 *   Users     `/admin/users`     fetched on Users only — it was fetched
 *                                on every visit to Admin before, whatever
 *                                the admin came for, and it is the
 *                                heaviest payload here (every account on
 *                                the instance, with its projects).
 *   Email     `/email-settings`  fetched on Email only. Superadmin-only,
 *                                and it carries SMTP credentials.
 *   Platform  `/site-settings`   no request: the dashboard shell already
 *   Security  `/site-settings`   has this in SWR's cache, seeded on the
 *   Branding  `/site-settings`   server for the sidebar logo (§178). It
 *                                is one shared document rather than three
 *                                fetches, and splitting it per tab would
 *                                mean three endpoints where there is one.
 *
 * So the honest answer to "each tab loads only its own data" is: yes for
 * the two that have data of their own, and the other three share a
 * document that is already loaded before this page mounts.
 *
 * ── Suspense ──────────────────────────────────────────────────────────
 *
 * `useSearchParams()` opts a client component out of static rendering
 * unless it is under a Suspense boundary, and this route is prerendered.
 * The boundary is here rather than around the whole tree so the gate and
 * the header are not inside it.
 */
export default function AdminPage() {
  return (
    <React.Suspense fallback={null}>
      <AdminArea />
    </React.Suspense>
  )
}

function AdminArea() {
  const { user, isSuperAdmin } = useAuthStore()
  const router = useRouter()
  const searchParams = useSearchParams()

  const tab = resolveAdminTab(searchParams.get('tab'))
  const active = ADMIN_TABS.find((t) => t.value === tab)!

  // Unchanged from before the split: the nav hides Admin for everyone
  // else, which does not stop a direct URL. Every tab is behind this one
  // gate — there is no per-tab permission and no tab a non-superadmin can
  // reach by guessing a query string.
  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace('/')
    }
  }, [user, isSuperAdmin, router])

  const handleTabChange = React.useCallback(
    (next: string) => {
      const value = resolveAdminTab(next)
      router.replace(`/settings/admin?tab=${value}`, { scroll: false })
    },
    [router],
  )

  if (!isSuperAdmin) {
    return null
  }

  return (
    <div className="p-6 space-y-6">
      {/* The area header. Below it, the strip; below that, the header for
          whichever tab is open — so there is always exactly one line
          saying what you are looking at.

          `max-md:hidden`: on a phone the layout's own "‹ Settings | Admin"
          bar is directly above this and already names the area, and three
          stacked headings is ~110px of a 844px screen spent saying
          "Admin" twice before the first control. */}
      <div className="flex items-center gap-3 max-md:hidden">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Shield className="h-5 w-5 text-accent" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text-primary">Admin</h1>
          <p className="text-sm text-text-secondary">
            Everything that applies to this whole instance.
          </p>
        </div>
      </div>

      <Tabs.Root
        value={tab}
        onValueChange={handleTabChange}
        // Keyboard arrows move between tabs and activate as they go
        // (Radix's default); each activation is a `replace`, so walking
        // the strip with the arrow keys leaves no history behind it.
        activationMode="automatic"
      >
        <AdminTabStrip value={tab} onValueChange={handleTabChange} />

        <div className="pt-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-text-primary">
              {active.title}
            </h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              {active.description}
            </p>
          </div>

          <Tabs.Content value="users" tabIndex={-1}>
            <UsersTab />
          </Tabs.Content>
          <Tabs.Content value="platform" tabIndex={-1} className="space-y-4">
            <PlatformTab />
          </Tabs.Content>
          <Tabs.Content value="security" tabIndex={-1} className="space-y-4">
            <RequireTwoFactorSection />
          </Tabs.Content>
          <Tabs.Content value="email" tabIndex={-1}>
            <EmailTab />
          </Tabs.Content>
          <Tabs.Content value="branding" tabIndex={-1}>
            <BrandingSection />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  )
}
