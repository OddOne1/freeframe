import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import { ToastProvider } from "@/components/shared/toast";
import { ThemeInitializer } from "@/components/shared/theme-initializer";
import { FaviconInitializer } from "@/components/shared/favicon-initializer";
import { ThemeColorsInitializer } from "@/components/shared/theme-colors-initializer";
import { fetchSiteSettingsServer, toPublicMediaUrl } from "@/lib/site-settings-server";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  preload: true,
});

export async function generateMetadata(): Promise<Metadata> {
  const base: Metadata = {
    title: "FreeFrame",
    description: "Collaborative media review and approval platform",
  };

  // Fetched server-side so the favicon is already correct in the very
  // first HTML response -- no client-side swap, no flash of the default,
  // and every visitor (not just the browser tab that uploaded it) sees it
  // immediately. See favicon-initializer.tsx for the live-update companion
  // (keeps an already-open tab in sync right after a superadmin uploads a
  // new one, without needing a full reload).
  //
  // icons is now ALWAYS set explicitly (custom favicon_url when present,
  // otherwise the bundled default at /logo-icon.png) rather than only when
  // a custom one exists. Previously, when no custom favicon was set, this
  // fell through to Next's file-based app/favicon.ico convention icon --
  // but that file-convention icon ALWAYS renders its own
  // <link rel="icon" sizes="32x32"> regardless of what generateMetadata
  // sets, so it kept coexisting alongside the dynamic one even after a
  // custom favicon WAS uploaded. Safari picks the sizes="32x32" one over
  // the size-less dynamic one, so it kept showing the old default forever,
  // no matter what the SSR or client-side code did. app/favicon.ico has
  // been deleted from the repo for exactly this reason -- generateMetadata
  // is now the single source of truth for the tab icon, full stop.
  //
  // CORRECTION 2026-07-31: the favicon.ico deletion above was an incomplete
  // fix -- app/icon.png and app/apple-icon.png are the SAME Next.js
  // file-based icon convention (auto-generate their own <link rel="icon">/
  // <link rel="apple-touch-icon"> regardless of generateMetadata, exactly
  // like favicon.ico did) and were left in the repo the whole time,
  // shipped in the same original commit (94dfc47) as favicon.ico. This is
  // what was actually causing the old default logo to flash in on reload
  // and occasionally win outright -- not just a Safari cache quirk as
  // previously diagnosed (see the now-corrected freeframe-safari-favicon-
  // cache-false-alarm memory). Both files have been deleted for the same
  // reason favicon.ico was. If a favicon bug resurfaces again, check for
  // ANY file matching Next's icon/apple-icon/favicon convention re-added
  // under app/ before re-diagnosing as a browser cache issue.
  //
  // §178 — the fetch itself moved to lib/site-settings-server so the
  // sidebar could reuse it rather than grow a third copy. The env reasoning
  // that used to sit inline here (NEXT_PUBLIC_API_URL is build-time only,
  // and a Docker multi-stage build does not carry it into the runner stage,
  // so "/api" is hardcoded as the fallback) moved with it.
  // An unreachable backend at render time returns null from the helper
  // (it never throws), so this falls back to the bundled default icon
  // rather than failing the whole page render.
  const siteSettings = await fetchSiteSettingsServer();
  const iconHref = toPublicMediaUrl(siteSettings?.favicon_url) ?? "/logo-icon.png";
  base.icons = { icon: iconHref };

  return base;
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A0A0B",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script to apply theme BEFORE paint -- prevents flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: "(function(){try{var d=JSON.parse(localStorage.getItem('ff-theme')||'{}');var t=d.state&&d.state.theme||'dark';if(t==='system'){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','dark')}})()",
          }}
        />
      </head>
      <body className={dmSans.variable + " font-sans antialiased"}>
        <ThemeInitializer />
        <FaviconInitializer />
        <ThemeColorsInitializer />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
