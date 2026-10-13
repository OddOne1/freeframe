/**
 * The five tabs of the Admin area, in order (§229).
 *
 * A plain module with no React in it, so the tab strip, the page and the
 * tests all read the SAME list — including `DEFAULT_ADMIN_TAB` and the
 * fallback rule. A second copy of "which values are legal" is how a deep
 * link to `?tab=branding` ends up working in one place and silently
 * falling back to Users in another.
 *
 * `title` and `description` are the per-tab page header: one definition,
 * so the five tabs cannot disagree about what a tab header looks like.
 * Branding's pair is the one its own page used to carry.
 */
export interface AdminTabDef {
  value: AdminTabValue
  /** The strip. Short, because five of these share a 390px screen. */
  label: string
  /** The header above the tab's content. */
  title: string
  description: string
}

export type AdminTabValue =
  | 'users'
  | 'platform'
  | 'security'
  | 'email'
  | 'branding'

export const ADMIN_TABS: AdminTabDef[] = [
  {
    value: 'users',
    label: 'Users',
    title: 'Platform Users',
    description: 'Invite people, set roles and storage, deactivate accounts.',
  },
  {
    value: 'platform',
    label: 'Platform',
    title: 'Platform',
    description: 'Storage for the whole instance, and the timezone its overnight jobs run in.',
  },
  {
    value: 'security',
    label: 'Security',
    title: 'Security',
    description: 'Rules that apply to every account on this instance.',
  },
  {
    value: 'email',
    label: 'Email',
    // "Email" rather than "Email & SMTP": the section card below it is
    // headed "Email & SMTP" already, and a tab header that repeats the
    // card's own title word for word is how a section that became a tab
    // ends up saying everything twice.
    title: 'Email',
    description: 'How this instance sends mail, and a way to test that it can.',
  },
  {
    value: 'branding',
    label: 'Branding',
    title: 'Branding',
    description: 'Customize your workspace name, logo, and colors.',
  },
]

export const DEFAULT_ADMIN_TAB: AdminTabValue = 'users'

/**
 * The tab a `?tab=` value selects. Anything unrecognised — a typo, an old
 * link, a value from a future version — falls back to Users rather than
 * rendering nothing.
 */
export function resolveAdminTab(raw: string | null | undefined): AdminTabValue {
  const hit = ADMIN_TABS.find((t) => t.value === raw)
  return hit ? hit.value : DEFAULT_ADMIN_TAB
}
