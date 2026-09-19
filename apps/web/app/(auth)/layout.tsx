import type { Metadata } from 'next'
import Image from 'next/image'
import { SiteSettingsProvider } from '@/components/layout/site-settings-provider'
import { fetchSiteSettingsServer, toPublicMediaUrl } from '@/lib/site-settings-server'

export const metadata: Metadata = {
  title: 'FreeFrame - Auth',
}

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // One fetch, two consumers. The logo was always read here; §196 added the
  // second reason: the login form has to know `require_2fa` BEFORE its first
  // paint, because that setting decides whether the default screen is
  // email+password or the magic-code step — and magic-code sign-in 403s on
  // an instance that requires 2FA (§195). Seeding SWR from the value this
  // layout already awaited is the §178 pattern the dashboard layout uses,
  // and costs no extra request; without it the form would paint the wrong
  // screen and swap it out once a client fetch resolved.
  //
  // `null` when the backend was unreachable at render time: the provider
  // then seeds nothing, the client fetch behaves exactly as it would have,
  // and the form holds its first paint until the answer arrives rather than
  // guessing.
  const siteSettings = await fetchSiteSettingsServer()
  const loginLogoUrl = toPublicMediaUrl(siteSettings?.logo_login_url)

  return (
    <SiteSettingsProvider value={siteSettings}>
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
    </SiteSettingsProvider>
  )
}
