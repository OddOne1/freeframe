import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import { ToastProvider } from "@/components/shared/toast";
import { ThemeInitializer } from "@/components/shared/theme-initializer";
import { FaviconInitializer } from "@/components/shared/favicon-initializer";
import { ThemeColorsInitializer } from "@/components/shared/theme-colors-initializer";
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
  try {
    const internalUrl = process.env.API_INTERNAL_URL || "http://localhost:8000";
    const res = await fetch(internalUrl + "/site-settings", {
      next: { revalidate: 60 },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.favicon_url) {
        // NEXT_PUBLIC_API_URL is only guaranteed to exist at *build* time
        // (it gets inlined into the client bundle). Docker multi-stage
        // builds do not carry ENV values into the runner stage, so relying
        // on process.env here at request time used to silently fall back
        // to "http://localhost:8000" -- pointing every visitor's browser at
        // their own machine instead of the real API, which meant the
        // favicon link in the SSR'd HTML was never actually reachable. The
        // runner stage in Dockerfile.prod now redeclares
        // NEXT_PUBLIC_API_URL=/api explicitly so this resolves correctly,
        // but "/api" is hardcoded as the fallback too since that relative
        // path (routed by Traefik to the api container) is the only value
        // this has ever been set to in this deployment.
        const publicPrefix = process.env.NEXT_PUBLIC_API_URL || "/api";
        base.icons = { icon: publicPrefix + data.favicon_url };
      }
    }
  } catch {
    // Backend unreachable at render time -- fall back to no custom favicon
    // rather than failing the whole page render.
  }

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
