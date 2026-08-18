'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Download, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DOWNLOAD_VARIANT_LABELS, type DownloadVariant } from '@/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/**
 * The download control for a share-link viewer (CLAUDE.md §30/§30b).
 *
 * `raw` is served straight from storage. Every other variant is a render
 * that has to be produced first, so it goes POST export -> poll -> download.
 * Polling rather than SSE is deliberate: a share viewer is unauthenticated
 * and cannot subscribe to the project's event channel, and a second event
 * system for one button is not worth it.
 *
 * `variants` comes from the SERVER, already intersected with what this
 * asset can produce — the browser never re-derives which options are
 * allowed.
 */

/** How long to wait for a render before giving up. Encoding a long clip is
 *  genuinely slow, so this is generous; the alternative is telling someone
 *  their download failed while it is still working. */
const POLL_TIMEOUT_MS = 15 * 60 * 1000
const POLL_INTERVAL_MS = 3000

function trigger(url: string) {
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = url
  document.body.appendChild(iframe)
  setTimeout(() => iframe.remove(), 30000)
}

async function downloadRaw(token: string, assetId: string, shareSession?: string | null) {
  const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  const res = await fetch(
    `${API_URL}/share/${token}/stream/${assetId}?download=true&variant=raw${sp}`,
  )
  if (!res.ok) throw new Error('Download not allowed')
  const data = await res.json()
  if (data?.url) trigger(data.url)
}

async function downloadRendered(
  token: string,
  assetId: string,
  variant: DownloadVariant,
  shareSession?: string | null,
) {
  const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  const start = await fetch(
    `${API_URL}/share/${token}/export/${assetId}?variant=${variant}${sp}`,
    { method: 'POST' },
  )
  if (!start.ok) throw new Error('Could not start the export')
  const { export_id, version_id } = await start.json()

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const res = await fetch(
      `${API_URL}/share/${token}/export/${assetId}/${export_id}` +
        `?version_id=${version_id}&variant=${variant}${sp}`,
    )
    if (!res.ok) throw new Error('Export failed')
    const data = await res.json()
    if (data?.ready && data.url) {
      trigger(data.url)
      return
    }
  }
  throw new Error('The export is taking longer than expected — try again')
}

export function DownloadMenu({
  token,
  assetId,
  variants,
  shareSession,
  className,
  iconOnly = true,
  label = 'Download',
}: {
  token: string
  assetId: string
  variants: DownloadVariant[]
  shareSession?: string | null
  className?: string
  iconOnly?: boolean
  label?: string
}) {
  const [busy, setBusy] = React.useState<DownloadVariant | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = React.useCallback(
    async (variant: DownloadVariant) => {
      setBusy(variant)
      setError(null)
      try {
        if (variant === 'raw') await downloadRaw(token, assetId, shareSession)
        else await downloadRendered(token, assetId, variant, shareSession)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Download failed')
      } finally {
        setBusy(null)
      }
    },
    [token, assetId, shareSession],
  )

  if (variants.length === 0) return null

  const icon = busy ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : (
    <Download className="h-4 w-4" />
  )

  // One option needs no menu — clicking through a single-item dropdown is
  // pure friction, and this is the common case for a plain download link.
  if (variants.length === 1) {
    return (
      <button
        type="button"
        title={error ?? DOWNLOAD_VARIANT_LABELS[variants[0]]}
        disabled={busy !== null}
        onClick={() => run(variants[0])}
        className={cn('flex items-center gap-2 disabled:opacity-60', className)}
      >
        {icon}
        {!iconOnly && <span>{label}</span>}
      </button>
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          title={error ?? label}
          disabled={busy !== null}
          className={cn('flex items-center gap-2 disabled:opacity-60', className)}
        >
          {icon}
          {!iconOnly && <span>{label}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[13rem] rounded-lg border border-border bg-bg-secondary p-1 shadow-xl"
        >
          {variants.map((v) => (
            <DropdownMenu.Item
              key={v}
              onSelect={() => run(v)}
              className="flex cursor-pointer items-center justify-between gap-3 rounded px-2.5 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
            >
              <span>{DOWNLOAD_VARIANT_LABELS[v]}</span>
              {busy === v && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </DropdownMenu.Item>
          ))}
          {error && (
            <div className="px-2.5 py-1.5 text-xs text-status-error">{error}</div>
          )}
          {busy && busy !== 'raw' && (
            <div className="px-2.5 py-1.5 text-[11px] text-text-tertiary">
              Rendering — this can take a few minutes.
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
