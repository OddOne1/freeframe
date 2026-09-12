'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Download, Loader2, X } from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import { triggerBrowserDownload } from '@/lib/download'
import { DOWNLOAD_VARIANT_LABELS, type DownloadVariant } from '@/types'
import type { ZipScope } from '@/lib/bulk-download'
import type {
  ZipExportAssetOptions,
  ZipExportOptionsResponse,
  ZipExportStatusResponse,
} from '@/types'

/**
 * One server-built zip instead of N browser downloads (CLAUDE.md §143).
 *
 * The bug this replaces: both surfaces fired one iframe download per file,
 * staggered by a timer, with no way to stop. Each one re-triggered Chrome's
 * multi-download permission prompt, so dismissing it did not end the
 * loop — it just brought the prompt back for the next file. The fix is one
 * download, not a politer loop.
 *
 * Used by BOTH the share viewer and the authenticated app. They differ only
 * in which endpoints they call, which is what `api` is for; everything the
 * user sees and every decision about versions, variants and fallbacks lives
 * here once.
 */

/** The shape of this batch, which decides the download's FILENAME only
 *  (§175, widened §177). It comes from the call site rather than being
 *  inferred from the item count: a scope holding exactly one asset makes
 *  "all of it" and "the one I picked" identical numbers, and folder identity
 *  is already gone once a selection is flattened into asset ids.
 *
 *  Defined in lib/bulk-download alongside the classification rules and
 *  re-exported here, where every call site already imports from. */
export type { ZipScope } from '@/lib/bulk-download'

const POLL_INTERVAL_MS = 1000
/** A build of a large folder is genuinely slow; giving up early would tell
 *  someone their download failed while it is still working. */
const POLL_TIMEOUT_MS = 30 * 60 * 1000

export interface BatchDownloadApi {
  /** What this selection may be downloaded as, and which files offer a
   *  version choice. Server-computed — the browser would otherwise have to
   *  re-derive a permission rule and a what-is-stored rule. */
  fetchOptions(items: { asset_id: string }[]): Promise<ZipExportOptionsResponse>
  start(
    items: { asset_id: string; version_id?: string }[],
    variant: DownloadVariant,
    scope: ZipScope,
    folderName?: string,
  ): Promise<ZipExportStatusResponse>
  poll(exportId: string): Promise<ZipExportStatusResponse>
  /** One asset's own download URL, for the "individually" branch of the
   *  format prompt (§177). Required only when `askFormat` is set — a surface
   *  that never offers the choice never needs it. */
  fileUrl?(assetId: string): Promise<string | null>
}

type Phase = 'asking' | 'choosing' | 'building' | 'done' | 'error'

export function BatchDownloadDialog({
  open,
  onOpenChange,
  assetIds,
  api,
  scope,
  folderName,
  askFormat = false,
  title = 'Download',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  assetIds: string[]
  api: BatchDownloadApi
  /** Required, not defaulted: the surface mounting this dialog is the only
   *  thing that knows whether the user asked for everything or picked items,
   *  and a silent default would mislabel one of them. */
  scope: ZipScope
  /** The folder's name, for `scope="single_folder"` only (§177). */
  folderName?: string
  /** Ask "zip or one file at a time?" before anything else (§177).
   *
   *  Off by default, because the surfaces that force a zip are the ones that
   *  cannot survive the alternative — past ~50 files, "individually" means
   *  that many browser downloads. Where the choice IS offered, it is an
   *  explicit one: the per-file popups it can lead to are then something the
   *  user asked for rather than something the app did silently, which is the
   *  distinction §143 was originally filed over. */
  askFormat?: boolean
  title?: string
}) {
  const [options, setOptions] = React.useState<ZipExportOptionsResponse | null>(null)
  const [loadingOptions, setLoadingOptions] = React.useState(false)
  const [variant, setVariant] = React.useState<DownloadVariant>('raw')
  /** assetId -> chosen version. Absent means "latest", which is the default
   *  and what the server does with no version_id (§143.1). */
  const [versionByAsset, setVersionByAsset] = React.useState<Record<string, string>>({})
  const [phase, setPhase] = React.useState<Phase>('choosing')
  const [status, setStatus] = React.useState<ZipExportStatusResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // Set when the viewer cancels, and on unmount. The poll loop checks it
  // rather than being torn down, so an in-flight request cannot resurrect
  // the dialog.
  const cancelled = React.useRef(false)

  // §146 — stop polling when this component goes away by ANY route.
  // `cancel()` covers the X button and the overlay, but a route change or a
  // parent clearing its state unmounts the dialog without either firing, and
  // the while-loop below would then keep hitting the API for up to its full
  // 30-minute deadline with nothing on screen to show for it.
  React.useEffect(() => {
    return () => {
      cancelled.current = true
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    cancelled.current = false
    setPhase(askFormat ? 'asking' : 'choosing')
    setStatus(null)
    setError(null)
    setVersionByAsset({})
    setLoadingOptions(true)
    api
      .fetchOptions(assetIds.map((id) => ({ asset_id: id })))
      .then((o) => {
        setOptions(o)
        // Default to the first offered variant rather than assuming `raw`
        // is allowed — a link may permit only a proxy.
        if (o.variants.length > 0 && !o.variants.includes(variant)) setVariant(o.variants[0])
      })
      .catch(() => setError('Could not load download options'))
      .finally(() => setLoadingOptions(false))
    // assetIds is a new array identity every render; key on its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assetIds.join(','), api])

  const withVersions = (options?.assets ?? []).filter((a) => a.versions.length > 1)

  function resetToLatest() {
    setVersionByAsset({})
  }

  async function startDownload() {
    setError(null)
    cancelled.current = false
    const items = assetIds.map((id) => ({
      asset_id: id,
      ...(versionByAsset[id] ? { version_id: versionByAsset[id] } : {}),
    }))
    let first: ZipExportStatusResponse
    try {
      first = await api.start(items, variant, scope, folderName)
    } catch (e) {
      if (cancelled.current) return
      setPhase('error')
      setError(e instanceof Error ? e.message : 'Could not start the download')
      return
    }
    if (cancelled.current) return
    setStatus(first)

    // ── Cache hit: the archive already exists, so there is nothing to
    // watch. Going through the progress state for a sub-second response
    // would flash "Compacting…" and read as a glitch rather than as the
    // fast path it is (§143). Straight to the download.
    if (first.ready && first.url) {
      triggerBrowserDownload(first.url)
      setPhase('done')
      onOpenChange(false)
      return
    }

    setPhase('building')
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (cancelled.current) return
      let next: ZipExportStatusResponse
      try {
        next = await api.poll(first.export_id)
      } catch {
        continue // a blip mid-build is not a failure; the deadline governs
      }
      if (cancelled.current) return
      if (cancelled.current) return
      setStatus(next)
      if (next.status === 'failed') {
        setPhase('error')
        setError(next.error || 'The download could not be prepared')
        return
      }
      if (next.ready && next.url) {
        triggerBrowserDownload(next.url)
        setPhase('done')
        onOpenChange(false)
        return
      }
    }
    if (cancelled.current) return
    setPhase('error')
    setError('This is taking longer than expected — try again')
  }

  async function downloadIndividually() {
    setError(null)
    if (!api.fileUrl) {
      // A surface that offers the choice without supplying the fetcher is a
      // wiring mistake, and silently zipping instead would hide it.
      setPhase('error')
      setError('Individual downloads are not available here')
      return
    }
    setPhase('building')
    for (const id of assetIds) {
      if (cancelled.current) return
      try {
        triggerBrowserDownload(await api.fileUrl(id))
      } catch {
        // One file that cannot be resolved does not stop the rest — the
        // user asked for N downloads, not for an all-or-nothing batch.
      }
    }
    setPhase('done')
    onOpenChange(false)
  }

  function cancel() {
    // Client-side only, deliberately. The worker keeps building and the
    // finished archive is cached, so pressing Cancel and asking again is
    // FASTER than the first attempt rather than starting over. Killing a
    // part-built archive mid-stream would leave nothing to show for the
    // work and no cache entry. Documented in the commit message.
    cancelled.current = true
    setPhase('choosing')
    onOpenChange(false)
  }

  const total = status?.file_count ?? assetIds.length
  const done = status?.files_done ?? 0
  // §147 — a large build spends most of its time AFTER the last file is
  // added, uploading the archive. Reporting only the file count left that
  // half looking frozen at "103 of 103" for minutes.
  const uploading = status?.phase === 'uploading'
  const sent = status?.bytes_done ?? 0
  const archiveBytes = status?.total_bytes ?? 0

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(v) : cancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-xl flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-medium text-text-primary">{title}</Dialog.Title>
            <Dialog.Close className="text-text-tertiary hover:text-text-primary" aria-label="Close">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {phase === 'asking' ? (
            /* §177 — the choice itself, before any options are loaded.
               Individual downloads reintroduce one browser popup per file,
               which is exactly what §143 removed; the difference is that it
               is now something the user picked, and the surfaces where it
               would be unbearable (past ~50 files) never render this. */
            <div className="px-4 py-5 space-y-4">
              <p className="text-sm text-text-secondary">
                {assetIds.length} file{assetIds.length === 1 ? '' : 's'} selected. How would
                you like them?
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setPhase('choosing')}
                  className="w-full flex items-start gap-3 rounded-md border border-border bg-bg-tertiary p-3 text-left hover:border-border-focus hover:bg-bg-hover"
                >
                  <Download className="h-4 w-4 mt-0.5 shrink-0 text-text-tertiary" />
                  <span className="min-w-0">
                    <span className="block text-sm text-text-primary">Download as a zip</span>
                    <span className="block text-xs text-text-tertiary">
                      One file, folders preserved.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={downloadIndividually}
                  className="w-full flex items-start gap-3 rounded-md border border-border bg-bg-tertiary p-3 text-left hover:border-border-focus hover:bg-bg-hover"
                >
                  <Download className="h-4 w-4 mt-0.5 shrink-0 text-text-tertiary" />
                  <span className="min-w-0">
                    <span className="block text-sm text-text-primary">
                      Download files individually
                    </span>
                    <span className="block text-xs text-text-tertiary">
                      Your browser may ask permission to download multiple files.
                    </span>
                  </span>
                </button>
              </div>
              {error && <p className="text-sm text-status-error">{error}</p>}
            </div>
          ) : phase === 'building' ? (
            <div className="px-4 py-8 flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
              {/* ONE message covering gathering and zipping. There is no
                  render phase: a batch only offers variants that already
                  exist as stored files (§143 scope). */}
              <p className="text-sm text-text-primary" data-testid="zip-progress">
                {uploading
                  ? 'Finishing the zip…'
                  : `Compacting ${total} file${total === 1 ? '' : 's'} into a zip…`}
              </p>
              <p className="text-xs text-text-tertiary tabular-nums">
                {uploading
                  ? `${formatBytes(sent)} of ${formatBytes(archiveBytes)} transferred`
                  : `${done} of ${total} added`}
              </p>
              <button
                type="button"
                onClick={cancel}
                className="mt-2 h-8 px-3 rounded-md border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {loadingOptions ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-text-tertiary">
                    <Loader2 className="h-4 w-4 animate-spin" /> Checking what can be downloaded…
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-text-secondary">
                      {assetIds.length} file{assetIds.length === 1 ? '' : 's'} will be downloaded as
                      a single zip, with folders preserved.
                    </p>

                    {/* Variant picker — only when there is a choice, mirroring
                        DownloadMenu's single-vs-dropdown pattern. */}
                    {(options?.variants.length ?? 0) > 1 && (
                      <div className="space-y-1">
                        <label htmlFor="zip-variant" className="text-xs font-medium text-text-secondary">
                          Quality
                        </label>
                        <select
                          id="zip-variant"
                          aria-label="Quality"
                          value={variant}
                          onChange={(e) => setVariant(e.target.value as DownloadVariant)}
                          className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                        >
                          {options!.variants.map((v) => (
                            <option key={v} value={v}>{DOWNLOAD_VARIANT_LABELS[v] ?? v}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Version selectors, only for assets that have a choice. */}
                    {withVersions.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-text-secondary">Versions</span>
                          <button
                            type="button"
                            onClick={resetToLatest}
                            className="text-xs text-accent hover:underline"
                          >
                            Download latest versions on all
                          </button>
                        </div>
                        {withVersions.map((a) => (
                          <VersionRow
                            key={a.asset_id}
                            asset={a}
                            value={versionByAsset[a.asset_id]}
                            onChange={(vid) =>
                              setVersionByAsset((prev) =>
                                vid ? { ...prev, [a.asset_id]: vid } : omit(prev, a.asset_id),
                              )
                            }
                          />
                        ))}
                      </div>
                    )}

                    {error && <p className="text-sm text-status-error">{error}</p>}
                  </>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 shrink-0">
                <button
                  type="button"
                  onClick={cancel}
                  className="h-8 px-3 rounded-md text-xs text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={startDownload}
                  disabled={loadingOptions || (options?.variants.length ?? 0) === 0}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download zip
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function omit(obj: Record<string, string>, key: string) {
  const next = { ...obj }
  delete next[key]
  return next
}

function VersionRow({
  asset,
  value,
  onChange,
}: {
  asset: ZipExportAssetOptions
  value?: string
  onChange: (versionId: string | undefined) => void
}) {
  const latest = asset.versions.find((v) => v.is_latest) ?? asset.versions[0]
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 min-w-0 truncate text-sm text-text-primary">{asset.asset_name}</span>
      <select
        aria-label={`Version for ${asset.asset_name}`}
        value={value ?? latest.version_id}
        onChange={(e) =>
          // Selecting the latest clears the override rather than pinning it:
          // "no choice made" is the state the server treats as "latest", and
          // keeping them distinct means the cache key does not change just
          // because someone re-picked the default.
          onChange(e.target.value === latest.version_id ? undefined : e.target.value)
        }
        className="h-7 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary"
      >
        {asset.versions.map((v) => (
          <option key={v.version_id} value={v.version_id}>
            v{v.version_number}{v.is_latest ? ' (latest)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
