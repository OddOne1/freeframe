'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Palette, Upload, X, Check, RotateCcw, Moon, Sun, LogIn, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { useThemeStore } from '@/stores/theme-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DEFAULT_LIGHT_TOKENS,
  DEFAULT_DARK_TOKENS,
  type ThemeColorTokens,
} from '@/lib/color-utils'

/**
 * One image slot: a preview, an upload button, and — only while a picked
 * file is staged — an Undo.
 *
 * §178: there is deliberately no Remove. A brand image that has been set is
 * never cleared back to the FreeFrame default (the backend ignores a null
 * for those columns), so a Remove button here would be a control that
 * visibly did nothing — the worst of the options, and the one this section
 * used to ship. The honest treatment is not to offer it, and to say why in
 * the copy rather than leave its absence to be discovered.
 *
 * `pending` is the staged-file case. Undoing that is a real, meaningful
 * action — it goes back to the committed image, not to empty — so it is the
 * one that stays.
 */
function LogoUploadSlot({
  label,
  description,
  logoUrl,
  pending,
  uploading,
  onUpload,
  onUndo,
  previewBg,
  accept = 'image/png,image/jpeg,image/svg+xml,image/webp',
  hint = 'PNG, JPG, SVG or WebP · Max 2 MB',
}: {
  label: string
  description: string
  logoUrl: string | null
  /** A file is picked but unsaved. */
  pending: boolean
  uploading: boolean
  onUpload: (file: File) => void
  onUndo: () => void
  previewBg: string
  accept?: string
  hint?: string
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
            accept={accept}
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
          {pending && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onUndo}
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
              Undo
            </Button>
          )}
        </div>
        <p className="text-2xs text-text-tertiary mt-2">{hint}</p>
      </div>
    </div>
  )
}

const COLOR_TOKEN_FIELDS: { key: keyof ThemeColorTokens; label: string }[] = [
  { key: 'bgPrimary', label: 'Background' },
  { key: 'bgSecondary', label: 'Background (secondary)' },
  { key: 'textPrimary', label: 'Text' },
  { key: 'textSecondary', label: 'Text (secondary)' },
  { key: 'borderPrimary', label: 'Border' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentForeground', label: 'Text on accent' },
  { key: 'navBg', label: 'Nav background' },
  { key: 'navText', label: 'Nav text' },
]

function ThemeColorEditor({
  label,
  icon: Icon,
  defaults,
  overrides,
  onChange,
  onReset,
}: {
  label: string
  icon: React.ElementType
  defaults: ThemeColorTokens
  overrides: Partial<ThemeColorTokens> | null
  onChange: (key: keyof ThemeColorTokens, value: string) => void
  onReset: () => void
}) {
  const isCustom = overrides !== null && Object.keys(overrides).length > 0
  const values: ThemeColorTokens = { ...defaults, ...overrides }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-text-tertiary" />
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">{label}</span>
        </div>
        {isCustom && (
          <button
            onClick={onReset}
            className="text-2xs text-text-tertiary hover:text-status-error transition-colors"
          >
            Reset
          </button>
        )}
      </div>
      <div className="space-y-2">
        {COLOR_TOKEN_FIELDS.map(({ key, label: fieldLabel }) => (
          <div key={key} className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">{fieldLabel}</span>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={values[key]}
                onChange={(e) => onChange(key, e.target.value)}
                className="h-6 w-6 rounded border border-border cursor-pointer bg-transparent p-0"
              />
              <span className="text-2xs font-mono text-text-tertiary w-14">{values[key]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


type UploadSlot = 'dark' | 'light' | 'login'

/**
 * §106 — one image slot's staged state.
 *
 * `keep` is not the same as "no file": it means "whatever is committed
 * stays", which is what makes Discard a pure local operation and lets Save
 * send nothing for a slot nobody touched.
 *
 * §178 removed the third state, `removed`. A brand image that has been set
 * is never cleared back to the bundled FreeFrame default — the backend
 * ignores a null for those columns — so a draft state meaning "clear this"
 * described an outcome that could not happen. The two states left are the
 * two real ones: keep what is there, or replace it with a new file. What
 * used to be the Remove button is now an Undo that exists only while an
 * unsaved file is staged, and takes the slot back to `keep`.
 */
type SlotDraft =
  | { kind: 'keep' }
  | { kind: 'file'; file: File; url: string }

const KEEP: SlotDraft = { kind: 'keep' }

type DraftColors = { light: Partial<ThemeColorTokens> | null; dark: Partial<ThemeColorTokens> | null }

/** Committed theme colors, flattened to the shape the draft holds.
 *
 * `theme_colors` is typed `Record<string, unknown>` on the wire (the
 * backend stores free-form JSON), and this page has always read it as
 * per-theme token maps. The cast is where that assumption is stated once,
 * rather than at each of the five places that need it. */
function seedColors(themeColors: Record<string, unknown> | null): DraftColors {
  const at = (k: string) => (themeColors?.[k] as Partial<ThemeColorTokens> | undefined) ?? null
  return { light: at('light'), dark: at('dark') }
}

/** Stable, comparable form — so an SWR revalidation that returns identical
 *  data does not count as an external change and blow away an edit in
 *  progress. Object identity would; the values are what matter. */
function colorsKey(c: DraftColors): string {
  const norm = (t: Partial<ThemeColorTokens> | null) =>
    t && Object.keys(t).length > 0
      ? Object.keys(t).sort().map((k) => `${k}:${(t as Record<string, string>)[k]}`).join(',')
      : ''
  return `${norm(c.light)}|${norm(c.dark)}`
}

export default function BrandingPage() {
  const { user, isSuperAdmin } = useAuthStore()
  const router = useRouter()
  const {
    orgName,
    logoDarkUrl,
    logoLightUrl,
    logoLoginUrl,
    faviconUrl,
    themeColors,
    updateOrgName,
    uploadLogo,
    uploadFavicon,
    updateThemeColors,
    resetThemeColors,
    resetAll,
  } = useSiteSettings()
  const { resolvedTheme } = useThemeStore()

  const committedLogos: Record<UploadSlot, string | null> = React.useMemo(
    () => ({ dark: logoDarkUrl, light: logoLightUrl, login: logoLoginUrl }),
    [logoDarkUrl, logoLightUrl, logoLoginUrl],
  )

  // ── Draft state (§106) ────────────────────────────────────────────────
  //
  // Every control on this page used to call straight through to the hook,
  // which PATCHes immediately. SiteSettings is instance-wide, so picking
  // through colour swatches applied each one live, for every signed-in
  // user, while the admin was still deciding. Nothing below touches the
  // network until Save.
  const [draftName, setDraftName] = React.useState(orgName)
  const [draftLogos, setDraftLogos] = React.useState<Record<UploadSlot, SlotDraft>>({
    dark: KEEP, light: KEEP, login: KEEP,
  })
  const [draftFavicon, setDraftFavicon] = React.useState<SlotDraft>(KEEP)
  const [draftColors, setDraftColors] = React.useState<DraftColors>(() => seedColors(themeColors))

  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [uploadingSide, setUploadingSide] = React.useState<UploadSlot | 'favicon' | null>(null)

  // Blob URLs are not garbage-collected — an unrevoked one pins its File
  // for the life of the document. Tracked in a ref so they can be revoked
  // deterministically on replace, discard and unmount rather than hoped
  // about.
  const objectUrls = React.useRef(new Set<string>())
  const trackUrl = React.useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    objectUrls.current.add(url)
    return url
  }, [])
  const revoke = React.useCallback((slot: SlotDraft) => {
    if (slot.kind === 'file') {
      URL.revokeObjectURL(slot.url)
      objectUrls.current.delete(slot.url)
    }
  }, [])
  React.useEffect(() => {
    const urls = objectUrls.current
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear() }
  }, [])

  const resetDraft = React.useCallback(
    (name: string, colors: DraftColors) => {
      setDraftLogos((prev) => { Object.values(prev).forEach(revoke); return { dark: KEEP, light: KEEP, login: KEEP } })
      setDraftFavicon((prev) => { revoke(prev); return KEEP })
      setDraftName(name)
      setDraftColors(colors)
      setSaveError(null)
    },
    [revoke],
  )

  // Re-seed when the COMMITTED values genuinely change — after a save here,
  // or an edit from elsewhere. Keyed on the values rather than on object
  // identity, so SWR revalidating to the same data does not discard an edit
  // in progress.
  const committedKey = `${orgName}|${logoDarkUrl}|${logoLightUrl}|${logoLoginUrl}|${faviconUrl}|${colorsKey(seedColors(themeColors))}`
  const savingRef = React.useRef(false)
  const lastSeeded = React.useRef(committedKey)
  React.useEffect(() => {
    // Save issues several PATCHes in sequence and each one mutates the
    // cache. Without this the draft would be re-seeded halfway through its
    // own save, and the changes not yet sent would be dropped.
    if (savingRef.current) return
    if (lastSeeded.current === committedKey) return
    lastSeeded.current = committedKey
    resetDraft(orgName, seedColors(themeColors))
  }, [committedKey, orgName, themeColors, resetDraft])

  // This page is admin-only. The settings nav already hides the link for
  // everyone else, but that doesn't stop direct navigation — redirect away
  // the same way /settings/admin does, rather than rendering a read-only
  // view that leaks the workspace's branding config to any logged-in user.
  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace('/')
    }
  }, [user, isSuperAdmin, router])

  // ── What the page SHOWS: draft first, committed underneath ────────────
  function effectiveLogo(side: UploadSlot): string | null {
    const d = draftLogos[side]
    if (d.kind === 'file') return d.url
    return committedLogos[side]
  }
  const effectiveFavicon = draftFavicon.kind === 'file' ? draftFavicon.url : faviconUrl

  function pickLogo(side: UploadSlot, file: File) {
    setDraftLogos((prev) => { revoke(prev[side]); return { ...prev, [side]: { kind: 'file', file, url: trackUrl(file) } } })
  }
  /** Back out of an unsaved pick — NOT a clear (§178). The slot returns to
   *  whatever is committed, which for a configured org is its real logo. */
  function undoLogo(side: UploadSlot) {
    setDraftLogos((prev) => { revoke(prev[side]); return { ...prev, [side]: KEEP } })
  }
  function pickFavicon(file: File) {
    setDraftFavicon((prev) => { revoke(prev); return { kind: 'file', file, url: trackUrl(file) } })
  }
  function undoFavicon() {
    setDraftFavicon((prev) => { revoke(prev); return KEEP })
  }

  function changeColor(theme: 'light' | 'dark', key: keyof ThemeColorTokens, value: string) {
    setDraftColors((prev) => ({ ...prev, [theme]: { ...(prev[theme] ?? {}), [key]: value } }))
  }
  function resetThemeDraft(theme: 'light' | 'dark') {
    setDraftColors((prev) => ({ ...prev, [theme]: null }))
  }

  /** Stage "back to defaults" rather than doing it. §106: a reset should be
   *  as reversible as any other edit until Save.
   *
   *  §178 — this no longer touches the logos or favicon. It never could
   *  have cleared a configured one (the backend ignores that), and staging
   *  a change that Save cannot make is how a button ends up appearing to do
   *  something it does not. Any staged, unsaved image pick is dropped,
   *  which IS reversible and is what "back to defaults" means here. */
  function stageResetAll() {
    setDraftLogos((prev) => { Object.values(prev).forEach(revoke); return { dark: KEEP, light: KEEP, login: KEEP } })
    setDraftFavicon((prev) => { revoke(prev); return KEEP })
    setDraftName('FreeFrame')
    setDraftColors({ light: null, dark: null })
    setSaveError(null)
  }

  // ── What actually differs ─────────────────────────────────────────────
  const nameChanged = draftName.trim() !== '' && draftName.trim() !== orgName
  const changedLogoSides = (['dark', 'light', 'login'] as UploadSlot[]).filter(
    (s) => draftLogos[s].kind === 'file',
  )
  const faviconChanged = draftFavicon.kind === 'file'
  const committedColors = seedColors(themeColors)
  const changedThemes = (['light', 'dark'] as const).filter(
    (t) => colorsKey({ ...committedColors, [t]: draftColors[t] }) !== colorsKey(committedColors),
  )
  const isDirty =
    nameChanged || changedLogoSides.length > 0 || faviconChanged || changedThemes.length > 0

  // "Back to defaults" collapses to the one endpoint that says exactly
  // that, instead of separate PATCHes that happen to add up to it. Derived
  // rather than a flag set by the Reset button: a flag goes stale the
  // moment the user edits something afterwards.
  //
  // §178 — the logo/favicon conditions are gone from this test along with
  // the reset itself. They can no longer be part of what a reset means, and
  // leaving them in would have made this permanently false for any org with
  // a logo, quietly retiring the single-call path.
  const stagedAsFullReset =
    isDirty &&
    draftName.trim() === 'FreeFrame' &&
    changedLogoSides.length === 0 &&
    !faviconChanged &&
    draftColors.light === null &&
    draftColors.dark === null

  async function handleSave() {
    if (!isDirty || saving) return
    setSaving(true)
    savingRef.current = true
    setSaveError(null)
    try {
      if (stagedAsFullReset) {
        await resetAll()
      } else {
        for (const side of changedLogoSides) {
          const d = draftLogos[side]
          setUploadingSide(side)
          // Only reachable as 'file' — changedLogoSides filters on exactly
          // that — but narrowed rather than asserted, so this stays correct
          // if a third slot state is ever reintroduced.
          if (d.kind === 'file') await uploadLogo(side, d.file)
        }
        if (faviconChanged && draftFavicon.kind === 'file') {
          setUploadingSide('favicon')
          await uploadFavicon(draftFavicon.file)
        }
        setUploadingSide(null)
        if (nameChanged) await updateOrgName(draftName.trim())
        for (const theme of changedThemes) {
          const tokens = draftColors[theme]
          if (tokens && Object.keys(tokens).length > 0) await updateThemeColors(theme, tokens)
          else await resetThemeColors(theme)
        }
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      // Re-seeded from whatever the server actually returned, not from the
      // draft: if the backend normalised anything, the form should show
      // what was really stored.
      savingRef.current = false
      lastSeeded.current = ''
      // ...and actually re-run that effect. Clearing the two refs above
      // cannot: a ref mutation triggers no render, and the effect's only
      // other trigger — `committedKey` changing — already fired while
      // `savingRef` was still true, so it returned early and never came
      // back. The staged picks therefore survived their own save: the slot
      // kept showing its blob URL and the "Unsaved changes" bar stayed up
      // after a successful save. This state update is what re-runs it.
      // Found by §178's test; the staleness predates it.
      setDraftLogos((prev) => { Object.values(prev).forEach(revoke); return { dark: KEEP, light: KEEP, login: KEEP } })
      setDraftFavicon((prev) => { revoke(prev); return KEEP })
    } catch (err) {
      savingRef.current = false
      setSaveError(err instanceof Error ? err.message : 'Could not save those changes.')
    } finally {
      setUploadingSide(null)
      setSaving(false)
    }
  }

  function handleDiscard() {
    resetDraft(orgName, seedColors(themeColors))
  }

  if (!isSuperAdmin) {
    return null
  }

  // Gates the reset button, so it now asks what that button can actually
  // reset (§178): a custom name or palette. A logo is deliberately not part
  // of this — an org whose ONLY customisation is a logo has nothing to
  // reset, and offering the button there promised something it could not
  // deliver.
  const hasResettableBranding =
    draftName.trim() !== 'FreeFrame' ||
    draftColors.light !== null ||
    draftColors.dark !== null

  // Which logo is active right now — from the DRAFT, so the preview shows
  // what is staged rather than mirroring what was already saved.
  const activeLogo =
    resolvedTheme === 'light'
      ? (effectiveLogo('light') ?? effectiveLogo('dark'))
      : (effectiveLogo('dark') ?? effectiveLogo('light'))
  const previewName = draftName.trim() || 'FreeFrame'

  return (
    <div className="p-6 max-w-2xl space-y-8 pb-24">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Palette className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Branding</h1>
          <p className="text-sm text-text-secondary">Customize your workspace name, logo, and colors</p>
        </div>
      </div>

      {/* Workspace name */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Workspace name</h2>
        <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="e.g. Acme Studio"
            className="max-w-xs"
            disabled={saving}
          />
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
        {/* §178 — stated, not left to be discovered by a Remove button that
            silently did nothing. */}
        <p className="text-xs text-text-tertiary -mt-1">
          Once a logo is set it can be replaced, but not removed — uploading a new file is the only
          way to change what everyone sees.
        </p>

        <div className="space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Moon className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Dark theme</span>
          </div>
          <LogoUploadSlot
            label="Dark theme logo"
            description="Shown when the app is in dark mode. Use a light-colored logo."
            logoUrl={effectiveLogo('dark')}
            pending={draftLogos.dark.kind === 'file'}
            uploading={uploadingSide === 'dark'}
            onUpload={(file) => pickLogo('dark', file)}
            onUndo={() => undoLogo('dark')}
            previewBg="bg-zinc-900"
          />

          <div className="flex items-center gap-2 mt-4 mb-1">
            <Sun className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Light theme</span>
          </div>
          <LogoUploadSlot
            label="Light theme logo"
            description="Shown when the app is in light mode. Use a dark-colored logo."
            logoUrl={effectiveLogo('light')}
            pending={draftLogos.light.kind === 'file'}
            uploading={uploadingSide === 'light'}
            onUpload={(file) => pickLogo('light', file)}
            onUndo={() => undoLogo('light')}
            previewBg="bg-white"
          />
        </div>
      </section>

      {/* Login page logo */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <LogIn className="h-3.5 w-3.5 text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">Login page logo</h2>
        </div>
        <p className="text-xs text-text-tertiary -mt-1">
          Shown above the sign-in form, before anyone is logged in. Falls back to the default FreeFrame logo
          until one is set.
        </p>
        <LogoUploadSlot
          label="Login page logo"
          description="Shown on the sign-in and password-setup screens."
          logoUrl={effectiveLogo('login')}
          pending={draftLogos.login.kind === 'file'}
          uploading={uploadingSide === 'login'}
          onUpload={(file) => pickLogo('login', file)}
          onUndo={() => undoLogo('login')}
          previewBg="bg-zinc-900"
        />
      </section>

      {/* Favicon */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Favicon</h2>
        <p className="text-xs text-text-tertiary -mt-1">
          Shown in the browser tab. Use a square image — it&apos;s scaled down automatically. Like the
          logo, it can be replaced but not removed.
        </p>
        <LogoUploadSlot
          label="Favicon"
          description="Shown in the browser tab for everyone in this workspace."
          logoUrl={effectiveFavicon}
          pending={draftFavicon.kind === 'file'}
          uploading={uploadingSide === 'favicon'}
          onUpload={pickFavicon}
          onUndo={undoFavicon}
          previewBg="bg-bg-tertiary"
          accept="image/png"
          hint="PNG only · Max 2 MB"
        />
      </section>

      {/* Theme colors — light + dark side by side on desktop, stacked on mobile */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Theme colors</h2>
        <p className="text-xs text-text-tertiary -mt-1">
          Customize the background, text, accent, and nav colors for each theme independently. A theme with no
          custom colors keeps FreeFrame&apos;s original palette.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ThemeColorEditor
            label="Light theme"
            icon={Sun}
            defaults={DEFAULT_LIGHT_TOKENS}
            overrides={draftColors.light}
            onChange={(key, value) => changeColor('light', key, value)}
            onReset={() => resetThemeDraft('light')}
          />
          <ThemeColorEditor
            label="Dark theme"
            icon={Moon}
            defaults={DEFAULT_DARK_TOKENS}
            overrides={draftColors.dark}
            onChange={(key, value) => changeColor('dark', key, value)}
            onReset={() => resetThemeDraft('dark')}
          />
        </div>
      </section>

      {/* Live preview — of the DRAFT */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Preview</h2>
        <p className="text-xs text-text-tertiary -mt-1">
          Currently showing the <strong>{resolvedTheme === 'light' ? 'light' : 'dark'}</strong> theme logo.
          {isDirty && <span className="text-status-warning"> Includes unsaved changes.</span>}
        </p>
        <div className="rounded-lg border border-border bg-bg-secondary p-4 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md overflow-hidden flex items-center justify-center bg-bg-tertiary shrink-0">
            {activeLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={activeLogo} alt={previewName} className="h-full w-full object-contain" />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-dark" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon-dark.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-light" />
              </>
            )}
          </div>
          <span className="text-sm font-semibold text-text-primary tracking-tight">{previewName}</span>
        </div>
      </section>

      {/* Reset — stages, like everything else here */}
      {hasResettableBranding && (
        <section className="pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error hover:bg-status-error/10 gap-1.5"
            onClick={stageResetAll}
            disabled={saving}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset name and colors
          </Button>
          <p className="text-2xs text-text-tertiary mt-1.5">
            Staged like any other change — nothing is reset until you save. Logos and the favicon are
            not affected; they can only be replaced.
          </p>
        </section>
      )}

      {/* Save / Discard. Nothing above this has touched the server. */}
      {isDirty && (
        <div className="sticky bottom-0 -mx-6 px-6 py-3 border-t border-border bg-bg-primary/95 backdrop-blur flex items-center gap-2">
          <span className="text-xs text-text-secondary flex-1">
            {saveError ? <span className="text-status-error">{saveError}</span> : 'Unsaved changes'}
          </span>
          <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save changes'}
          </Button>
        </div>
      )}
      {saved && !isDirty && (
        <p className="text-xs text-status-success flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" /> Branding saved.
        </p>
      )}
    </div>
  )
}
