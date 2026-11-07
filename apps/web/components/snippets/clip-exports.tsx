'use client'

import * as React from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { triggerBrowserDownload } from '@/lib/download'
import { resolveApiMediaUrl } from '@/lib/utils'
import { errorMessage, errorStatus, snippetApi } from '@/lib/snippet-api'
import type { SnippetAspect, SnippetExport } from '@/types'
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

type State =
  | { phase: 'idle' }
  | { phase: 'starting'; aspect: SnippetAspect }
  | { phase: 'running'; aspect: SnippetAspect; job: SnippetExport }
  | { phase: 'done'; aspect: SnippetAspect; url: string }
  | { phase: 'failed'; aspect: SnippetAspect; message: string }
  | { phase: 'unavailable' }

/** Progress may come as 0..1 or 0..100; null while the job has none. */
function fraction(p: number | null | undefined): number | null {
  if (p == null || Number.isNaN(p)) return null
  return Math.max(0, Math.min(1, p > 1 ? p / 100 : p))
}

function isDone(job: SnippetExport) {
  return job.status === 'done' || job.status === 'completed' || job.status === 'ready'
}
function isFailed(job: SnippetExport) {
  return job.status === 'failed' || job.status === 'error'
}


/**
 * Export buttons for a stored clip (prompt #8's endpoints).
 *
 * POST /snippets/{id}/exports, then GET /exports/{id} every 2 s until done,
 * then the browser downloads `download_url`. A 404 on the POST means #8 is not
 * deployed yet: that is shown as "Export not available yet", not as an error.
 * 9:16 and 16:9 are live; the other four shapes are visible but disabled.
 */
export function ClipExports({ snippetId, dirty }: { snippetId: string; dirty: boolean }) {
  const [state, setState] = React.useState<State>({ phase: 'idle' })
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = React.useRef(true)

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const poll = React.useCallback((aspect: SnippetAspect, id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const job = await snippetApi.getExport(id)
        if (!alive.current) return
        if (isDone(job) && job.download_url) {
          // The repo's one download path (lib/download.ts): a hidden iframe,
          // so a cross-origin URL downloads instead of navigating the app
          // away. It resolves the URL itself, so it gets the RAW value.
          setState({ phase: 'done', aspect, url: resolveApiMediaUrl(job.download_url) ?? job.download_url })
          triggerBrowserDownload(job.download_url)
        } else if (isFailed(job)) {
          setState({ phase: 'failed', aspect, message: job.error || 'The export failed.' })
        } else {
          setState({ phase: 'running', aspect, job })
          poll(aspect, id)
        }
      } catch (err) {
        if (alive.current) setState({ phase: 'failed', aspect, message: errorMessage(err, 'Lost track of the export.') })
      }
    }, EXPORT_POLL_MS)
  }, [])

  async function start(aspect: SnippetAspect) {
    if (timer.current) clearTimeout(timer.current)
    setState({ phase: 'starting', aspect })
    try {
      const job = await snippetApi.createExport(snippetId, aspect)
      if (!alive.current) return
      setState({ phase: 'running', aspect, job })
      poll(aspect, job.id)
    } catch (err) {
      if (!alive.current) return
      if (errorStatus(err) === 404) setState({ phase: 'unavailable' })
      else setState({ phase: 'failed', aspect, message: errorMessage(err, 'Could not start the export.') })
    }
  }

  const busy = state.phase === 'starting' || state.phase === 'running'
  const progress = state.phase === 'running' ? fraction(state.job.progress) : null

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
              disabled={busy || state.phase === 'unavailable'}
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

      <div aria-live="polite" className="min-h-[1.25rem] text-xs">
        {state.phase === 'unavailable' && <p className="text-text-tertiary">Export not available yet.</p>}
        {state.phase === 'starting' && <p className="text-text-tertiary">Starting {state.aspect} export…</p>}
        {state.phase === 'running' && (
          <div className="space-y-1">
            <p className="text-text-tertiary">
              Exporting {state.aspect}
              {progress != null ? ` · ${Math.round(progress * 100)}%` : ` · ${state.job.status}`}
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
          <p role="alert" className="text-status-error">
            {state.message}
          </p>
        )}
      </div>
    </section>
  )
}
