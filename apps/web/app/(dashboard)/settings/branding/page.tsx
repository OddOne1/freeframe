import { redirect } from 'next/navigation'

/**
 * §229 — Branding is a tab of the Admin area now, not a section of its
 * own. The owner: "We could also bring Branding into here as well, that
 * way there is only one Admin setting to hide."
 *
 * The route stays, as a redirect, because the old one is in bookmarks and
 * in at least one person's muscle memory. Server-side, so there is no
 * flash of an empty page and no client bundle for a route that renders
 * nothing — and `redirect()` replaces rather than pushes, so Back out of
 * the Admin page leaves Settings instead of bouncing through here again.
 */
export default function BrandingRedirectPage() {
  redirect('/settings/admin?tab=branding')
}
