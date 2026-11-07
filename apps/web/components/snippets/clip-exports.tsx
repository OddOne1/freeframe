'use client'

import * as React from 'react'
import { Download, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { triggerBrowserDownload } from '@/lib/download'
import { resolveApiMediaUrl } from '@/lib/utils'
import { errorMessage, errorStatus, snippetApi } from '@/lib/snippet-api'
import type { SnippetAspect, SnippetExportJob } from '@/types'
import { HintTooltip } from './snippet-ui'

const ASPECTS: { value: SnippetAspect; enabled: boolean }[] = [
  { value: '9:16', enabled: true },
  { value: '16:9', enabled: true },
  { value: '1:1', enabled: false },
  { value: '4:5', enabled: false },
  { value: '3:4', enabled: false },
  { value: '4:3', enabled: false },
]

export const EXPORT_POLL_MS = 2000
/** A backstop on top of the status rules: 15 minutes of polling, then stop. */
export const EXPORT_MAX_POLLS = 450

export const EXPORT_GONE_MESSAGE = 'Export no longer available, create it again'
export const EXPORT_MISSING_MESSAGE = 'Export not available yet'
export const EXPORT_DISABLED_MESSAGE = 'SocialSnippet is not enabled for this project'

type State =
  | { phase: 'idle' }
  | { phase: 'starting'; aspect: SnippetAspect }
  | { phase: 'running'; aspect: SnippetAspect; job: SnippetExportJob | null }
  | { phase: 'done'; aspect: SnippetAspect; url: string }
  /** The job failed, or the POST failed for a reason worth retrying. */
  | { phase: 'failed'; aspect: SnippetAspect; message: string }
  /** The server refused this request (422): its detail, as it is. */
  | { phase: 'refused'; aspect: SnippetAspect; message: string }
  /** An unknown status (e.g. "expired"): start a new export. */
  | { phase: 'gone'; aspect: SnippetAspect }
  /** 404 (endpoint not deployed) or 409 (feature off): nothing to retry. */
  | { phase: 'blocked'; message: string }

/** The contract's progress is 0..1; null while the job has none. */
function fraction(p: number | null): number | null {
  if (p == null || Number.isNaN(p)) return null
  return Math.max(0, Math.min(1, p))
}

/**
 * Export buttons for a stored clip (prompt #8's endpoints).
 *
 * POST /snippets/{id}/exports -> {export_id}, then GET /exports/{export_id}
 * every 2 s while the status is "queued" or "running". "done" downloads
 * `download_url`; "failed" shows `error` with a Retry that posts again; any
 * other status ends the poll as "no longer available". POST answers: 404 =
 * endpoint not there yet, 409 = feature off, 422 = the server's detail.
 *
 * Polling stops when this unmounts, which is when the player closes: every
 * loop carries a run number, and a closed player or a newer export makes the
 * old loop's number stale, so a reply that lands late schedules nothing.
 */
export function ClipExports({ snippetId, dirty }: { snippetId: string; dirty: boolean }) {
  const [state, setState] = React.useState<State>({ phase: 'idle' })
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const run = React.useRef(0)

  const stop = React.useCallback(() => {
    run.current += 1
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  React.useEffect(() => stop, [stop])

  const poll = React.useCallback((token: number, aspect: SnippetAspect, exportId: string, count: number) => {
    timer.current = setTimeout(async () => {
      if (token !== run.current) return
      let job: SnippetExportJob
      try {
        job = await snippetApi.getExport(exportId)
      } catch (err) {
        if (token !== run.current) return
        setState({ phase: 'failed', aspect, message: errorMessage(err, 'Lost track of the export.') })
        return
      }
      if (token !== run.current) return
      switch (job.status) {
        case 'done':
          if (job.download_url) {
            // The repo's one download path (lib/download.ts): a hidden
            // iframe, so a cross-origin URL downloads instead of navigating
            // the app away. It resolves the URL itself: pass the RAW value.
            setState({ phase: 'done', aspect, url: resolveApiMediaUrl(job.download_url) ?? job.download_url })
            triggerBrowserDownload(job.download_url)
          } else {
            setState({ phase: 'failed', aspect, message: 'The export finished without a download link.' })
          }
          return
        case 'failed':
          setState({ phase: 'failed', aspect, message: job.error || 'The export failed.' })
          return
        case 'queued':
        case 'running':
          if (count + 1 >= EXPORT_MAX_POLLS) {
            setState({ phase: 'gone', aspect })
            return
          }
          setState({ phase: 'running', aspect, job })
          poll(token, aspect, exportId, count + 1)
          return
        default:
          setState({ phase: 'gone', aspect })
      }
    }, EXPORT_POLL_MS)
  }, [])

  async function start(aspect: SnippetAspect) {
    stop()
    const token = run.current
    setState({ phase: 'starting', aspect })
    try {
      const created = await snippetApi.createExport(snippetId, aspect)
      if (token !== run.current) return
      setState({ phase: 'running', aspect, job: null })
      poll(token, aspect, created.export_id, 0)
    } catch (err) {
      if (token !== run.current) return
      const status = errorStatus(err)
      if (status === 404) setState({ phase: 'blocked', message: EXPORT_MISSING_MESSAGE })
      else if (status === 409) setState({ phase: 'blocked', message: EXPORT_DISABLED_MESSAGE })
      else if (status === 422) setState({ phase: 'refused', aspect, message: errorMessage(err, 'This export is not possible.') })
      else setState({ phase: 'failed', aspect, message: errorMessage(err, 'Could not start the export.') })
    }
  }

  const busy = state.phase === 'starting' || state.phase === 'running'
  const blocked = state.phase === 'blocked'
  const progress = state.phase === 'running' && state.job ? fraction(state.job.progress) : null

  return (
    <section aria-label="Export" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-text-tertiary">Export</h3>
        {dirty && <p className="text-2xs text-text-tertiary">Exports use the saved in/out.</p>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ASPECTS.map((a) =>
          a.enabled ? (
            <Button
              key={a.value}
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || blocked}
              onClick={() => start(a.value)}
              aria-label={`Export ${a.value}`}
            >
              {busy && 'aspect' in state && state.aspect === a.value ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {a.value}
            </Button>
          ) : (
            <HintTooltip key={a.value} hint={`${a.value}: coming soon`}>
              <Button type="button" size="sm" variant="secondary" disabled aria-label={`Export ${a.value}, coming soon`}>
                {a.value}
              </Button>
            </HintTooltip>
          ),
        )}
      </div>

      <div aria-live="polite" className="min-h-[1.25rem] text-xs" data-testid="export-status">
        {state.phase === 'blocked' && <p className="text-text-tertiary">{state.message}</p>}
        {state.phase === 'starting' && <p className="text-text-tertiary">Starting {state.aspect} export…</p>}
        {state.phase === 'running' && (
          <div className="space-y-1">
            <p className="text-text-tertiary">
              Exporting {state.aspect}
              {progress != null ? ` · ${Math.round(progress * 100)}%` : ` · ${state.job?.status ?? 'queued'}`}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
              role="progressbar"
              aria-label={`${state.aspect} export progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress != null ? Math.round(progress * 100) : undefined}
            >
              <div
                className={progress == null ? 'h-full w-1/3 animate-pulse bg-accent' : 'h-full bg-accent transition-[width] duration-500'}
                style={progress != null ? { width: `${progress * 100}%` } : undefined}
              />
            </div>
          </div>
        )}
        {state.phase === 'done' && (
          <p className="text-status-success">
            {state.aspect} export ready.{' '}
            <a href={state.url} download className="font-medium underline">
              Download again
            </a>
          </p>
        )}
        {state.phase === 'failed' && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-status-error">
              {state.message}
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={() => start(state.aspect)}>
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        {state.phase === 'refused' && (
          <p role="alert" className="text-status-error">
            {state.message}
          </p>
        )}
        {state.phase === 'gone' && <p className="text-text-secondary">{EXPORT_GONE_MESSAGE}</p>}
      </div>
    </section>
  )
}
