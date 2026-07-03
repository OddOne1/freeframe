'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Palette, Upload, X, Check, RotateCcw, Moon, Sun, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { useThemeStore } from '@/stores/theme-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function LogoUploadSlot({
  label,
  description,
  logoUrl,
  uploading,
  onUpload,
  onRemove,
  previewBg,
}: {
  label: string
  description: string
  logoUrl: string | null
  uploading: boolean
  onUpload: (file: File) => void
  onRemove: () => void
  previewBg: string
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    onUpload(file)
    e.target.value = ''
  }

  return (
    <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-bg-secondary">
      {/* Preview */}
      <div
        className={`h-16 w-16 rounded-xl border border-border flex items-center justify-center overflow-hidden shrink-0 ${previewBg}`}
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        ) : logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={label} className="h-full w-full object-contain p-1" />
        ) : (
          <span className="text-xs text-text-tertiary text-center leading-tight px-1">No logo</span>
        )}
      </div>

      {/* Info + actions */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-tertiary mt-0.5 mb-3">{description}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={handleFile}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="h-3.5 w-3.5" />
            {logoUrl ? 'Replace' : 'Upload'}
          </Button>
          {logoUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={uploading}
              className="text-status-error hover:text-status-error hover:bg-status-error/10"
            >
              <X className="h-3.5 w-3.5" />
              Remove
            </Button>
          )}
        </div>
        <p className="text-2xs text-text-tertiary mt-2">PNG, JPG, SVG or WebP · Max 2 MB</p>
      </div>
    </div>
  )
}

export default function BrandingPage() {
  const { user, isSuperAdmin } = useAuthStore()
  const router = useRouter()
  const {
    orgName,
    logoDarkUrl,
    logoLightUrl,
    updateOrgName,
    uploadLogo,
    removeLogo,
    resetAll,
  } = useSiteSettings()
  const { theme } = useThemeStore()

  const [nameValue, setNameValue] = React.useState(orgName)
  const [nameSaved, setNameSaved] = React.useState(false)
  const [savingName, setSavingName] = React.useState(false)
  const [uploadingSide, setUploadingSide] = React.useState<'dark' | 'light' | null>(null)
  const [resetting, setResetting] = React.useState(false)

  React.useEffect(() => { setNameValue(orgName) }, [orgName])

  // This page is admin-only. The settings nav already hides the link for
  // everyone else, but that doesn't stop direct navigation — redirect away
  // the same way /settings/admin does, rather than rendering a read-only
  // view that leaks the workspace's branding config to any logged-in user.
  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace('/')
    }
  }, [user, isSuperAdmin, router])

  async function handleSaveName() {
    const trimmed = nameValue.trim()
    if (!trimmed) return
    setSavingName(true)
    try {
      await updateOrgName(trimmed)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch {
      // no-op — leave the input as-is so the user can retry
    } finally {
      setSavingName(false)
    }
  }

  async function handleUpload(side: 'dark' | 'light', file: File) {
    setUploadingSide(side)
    try {
      await uploadLogo(side, file)
    } catch {
      // no-op — upload failed, slot just stays as it was
    } finally {
      setUploadingSide(null)
    }
  }

  async function handleRemove(side: 'dark' | 'light') {
    try {
      await removeLogo(side)
    } catch {
      // no-op
    }
  }

  async function handleReset() {
    setResetting(true)
    try {
      await resetAll()
      setNameValue('FreeFrame')
    } catch {
      // no-op
    } finally {
      setResetting(false)
    }
  }

  if (!isSuperAdmin) {
    return null
  }

  const hasCustomBranding = orgName !== 'FreeFrame' || logoDarkUrl !== null || logoLightUrl !== null

  // Which logo is active right now
  const activeLogo = theme === 'light' ? (logoLightUrl ?? logoDarkUrl) : (logoDarkUrl ?? logoLightUrl)

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Palette className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Branding</h1>
          <p className="text-sm text-text-secondary">Customize your workspace name and logo</p>
        </div>
      </div>

      {/* Workspace name */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Workspace name</h2>
        <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="e.g. Acme Studio"
              onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              className="max-w-xs"
              disabled={savingName}
            />
            <Button
              size="sm"
              onClick={handleSaveName}
              disabled={!nameValue.trim() || nameValue.trim() === orgName || savingName}
            >
              {savingName ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : nameSaved ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                'Save'
              )}
            </Button>
          </div>
          <p className="text-xs text-text-tertiary">
            Shown in the sidebar for everyone in this workspace. Defaults to &ldquo;FreeFrame&rdquo;.
          </p>
        </div>
      </section>

      {/* Logo — per theme */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Logo</h2>
        <p className="text-xs text-text-tertiary -mt-1">
          Upload separate logos for dark and light themes. If only one is set, it will be used for both.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Moon className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Dark theme</span>
          </div>
          <LogoUploadSlot
            label="Dark theme logo"
            description="Shown when the app is in dark mode. Use a light-colored logo."
            logoUrl={logoDarkUrl}
            uploading={uploadingSide === 'dark'}
            onUpload={(file) => handleUpload('dark', file)}
            onRemove={() => handleRemove('dark')}
            previewBg="bg-zinc-900"
          />

          <div className="flex items-center gap-2 mt-4 mb-1">
            <Sun className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Light theme</span>
          </div>
          <LogoUploadSlot
            label="Light theme logo"
            description="Shown when the app is in light mode. Use a dark-colored logo."
            logoUrl={logoLightUrl}
            uploading={uploadingSide === 'light'}
            onUpload={(file) => handleUpload('light', file)}
            onRemove={() => handleRemove('light')}
            previewBg="bg-white"
          />
        </div>
      </section>

      {/* Live preview */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Preview</h2>
        <p className="text-xs text-text-tertiary -mt-1">
          Currently showing the <strong>{theme === 'light' ? 'light' : 'dark'}</strong> theme logo.
        </p>
        <div className="rounded-lg border border-border bg-bg-secondary p-4 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md overflow-hidden flex items-center justify-center bg-bg-tertiary shrink-0">
            {activeLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={activeLogo} alt={orgName} className="h-full w-full object-contain" />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-dark" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon-dark.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-light" />
              </>
            )}
          </div>
          <span className="text-sm font-semibold text-text-primary tracking-tight">{orgName}</span>
        </div>
      </section>

      {/* Reset */}
      {hasCustomBranding && (
        <section className="pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error hover:bg-status-error/10 gap-1.5"
            onClick={handleReset}
            disabled={resetting}
          >
            {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Reset to defaults
          </Button>
        </section>
      )}
    </div>
  )
}
