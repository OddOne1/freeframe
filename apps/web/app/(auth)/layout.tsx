import type { Metadata } from 'next'
import Image from 'next/image'

export const metadata: Metadata = {
  title: 'FreeFrame - Auth',
}

async function getLoginLogoUrl(): Promise<string | null> {
  // Same server-side-fetch pattern as generateMetadata in app/layout.tsx
  // (see the comment there for why NEXT_PUBLIC_API_URL is hardcoded as the
  // fallback rather than trusted blindly at runtime). This page is
  // pre-authentication, and GET /site-settings has no auth dependency
  // (apps/api/routers/site_settings.py), so it's safe to call directly
  // here without any token.
  try {
    const internalUrl = process.env.API_INTERNAL_URL || 'http://localhost:8000'
    const res = await fetch(internalUrl + '/site-settings', {
      next: { revalidate: 60 },
    })
    if (res.ok) {
      const data = await res.json()
      if (data.logo_login_url) {
        const publicPrefix = process.env.NEXT_PUBLIC_API_URL || '/api'
        return publicPrefix + data.logo_login_url
      }
    }
  } catch {
    // Backend unreachable at render time -- fall back to the default logo.
  }
  return null
}

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const loginLogoUrl = await getLoginLogoUrl()

  return (
    <div className="relative min-h-screen bg-bg-primary flex flex-col items-center justify-center px-4">
      {/* Subtle radial glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-accent/[0.04] blur-[120px]" />
      </div>

      {/* Logo -- falls back to the bundled default when no custom login logo
         is configured (see Branding settings > Login page logo). */}
      <div className="relative mb-10">
        {loginLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={loginLogoUrl} alt="FreeFrame" className="h-12 w-auto max-w-[220px] object-contain" />
        ) : (
          <Image
            src="/logo-full.png"
            alt="FreeFrame"
            width={180}
            height={48}
            priority
            className="h-12 w-auto"
          />
        )}
      </div>

      {/* Card */}
      <div className="relative w-full max-w-sm rounded-xl border border-border bg-bg-secondary/50 backdrop-blur-sm p-6 shadow-xl animate-fade-in">
        {children}
      </div>

      {/* Footer */}
      <p className="relative mt-8 text-2xs text-text-tertiary">
        Collaborative media review &amp; approval
      </p>
    </div>
  )
}
