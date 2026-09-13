import { DashboardShell } from "@/components/layout/dashboard-shell";
import { SiteSettingsProvider } from "@/components/layout/site-settings-provider";
import { fetchSiteSettingsServer } from "@/lib/site-settings-server";

/**
 * §178 — branding is fetched HERE, on the server, before anything renders.
 *
 * The sidebar reads its logo through `useSiteSettings()`, a plain
 * `useSWR('/site-settings')`. With nothing seeded, the first client render
 * has no data and paints the bundled FreeFrame icon, which then swaps to
 * the real logo once the fetch resolves — a visible flash of someone else's
 * brand on every single page load.
 *
 * Seeding SWR's cache from a server fetch is the same fix the favicon
 * (app/layout.tsx's generateMetadata) and the login page
 * (app/(auth)/layout.tsx) already had; the sidebar was simply never given
 * it. All three now share `fetchSiteSettingsServer`.
 *
 * The client hook is unchanged and still owns live updates — a logo
 * uploaded in Branding settings still appears without a reload. This only
 * decides what the FIRST paint shows.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const siteSettings = await fetchSiteSettingsServer();

  return (
    <SiteSettingsProvider value={siteSettings}>
      <DashboardShell>{children}</DashboardShell>
    </SiteSettingsProvider>
  );
}
