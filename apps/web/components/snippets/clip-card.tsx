'use client'

import * as React from 'react'
import { AudioLines, Check, Play, X } from 'lucide-react'
import { cn, resolveApiMediaUrl } from '@/lib/utils'
import { formatDuration } from '@/lib/snippet-timing'
import type { SnippetClip, SnippetStatus } from '@/types'
import { ScoreBadge, SourceBadge, StatusPill } from './snippet-ui'

/**
 * One search result. A "snippet" is a stored clip with a title, source,
 * scores and a review status; a "moment" is a transcript hit no clip covers,
 * so it shows only the matching quote (its title, source, generator and
 * status are null by contract).
 */
export function ClipCard({
  clip,
  canEdit,
  activeTopics,
  onPlay,
  onTopic,
  onStatus,
  busy,
}: {
  clip: SnippetClip
  canEdit: boolean
  activeTopics: string[]
  onPlay: () => void
  onTopic: (topic: string) => void
  onStatus: (status: SnippetStatus) => void
  busy?: boolean
}) {
  const [expanded, setExpanded] = React.useState(false)
  const [clamped, setClamped] = React.useState(false)
  const quoteRef = React.useRef<HTMLParagraphElement>(null)
  const thumb = resolveApiMediaUrl(clip.thumbnail_url)
  const isMoment = clip.kind === 'moment'
  const heading = clip.title ?? (isMoment ? null : 'Untitled clip')

  // Only offer "More" when the quote is actually cut off.
  React.useLayoutEffect(() => {
    const el = quoteRef.current
    if (!el || expanded) return
    setClamped(el.scrollHeight > el.clientHeight + 1)
  }, [clip.quote, expanded])

  const playLabel = `Play ${heading ?? 'transcript moment'} from ${clip.asset_name}`

  return (
    <article
      className={cn(
        'group flex flex-col overflow-hidden rounded-lg border border-border bg-bg-secondary transition-colors hover:border-border-focus/60',
        clip.status === 'rejected' && 'opacity-70',
      )}
      aria-label={heading ?? 'Transcript moment'}
    >
      <button
        type="button"
        onClick={onPlay}
        aria-label={playLabel}
        className="relative aspect-video w-full overflow-hidden bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- media-proxy URLs, as AssetCard does
          <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          // Neutral audio tile: the play button stays centred like on video
          // cards, and the "audio" marker sits in the free bottom-left corner.
          <div className="h-full w-full bg-gradient-to-br from-bg-tertiary to-bg-hover">
            <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-2xs font-medium text-white">
              <AudioLines className="h-3 w-3" aria-hidden />
              Audio
            </span>
          </div>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/25">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg opacity-90 transition-transform group-hover:scale-105">
            <Play className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden />
          </span>
        </span>
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-white">
          {formatDuration(clip.duration_ms)}
        </span>
        {isMoment && (
          <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-2xs font-medium text-white">
            Transcript moment
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {heading && <h3 className="text-sm font-medium leading-snug text-text-primary line-clamp-2">{heading}</h3>}
        <p className="text-xs text-text-tertiary truncate">
          {clip.speaker?.name ?? 'Unknown speaker'}
          <span aria-hidden> · </span>
          <span title={clip.asset_name}>{clip.asset_name}</span>
        </p>

        {clip.quote && (
          <div>
            <p
              ref={quoteRef}
              className={cn('text-xs leading-relaxed text-text-secondary', !expanded && 'line-clamp-2')}
            >
              &ldquo;{clip.quote}&rdquo;
            </p>
            {(clamped || expanded) && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-0.5 text-2xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded"
              >
                {expanded ? 'Less' : 'More'}
              </button>
            )}
          </div>
        )}

        {clip.topics.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Topics">
            {clip.topics.map((t) => {
              const on = activeTopics.some((a) => a.toLowerCase() === t.toLowerCase())
              return (
                <li key={t}>
                  <button
                    type="button"
                    onClick={() => onTopic(t)}
                    aria-pressed={on}
                    title={on ? `Filtering by ${t}` : `Filter by ${t}`}
                    className={cn(
                      'rounded-full px-2 py-0.5 hover-none:py-1.5 text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                      on ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    #{t}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {clip.source && <SourceBadge source={clip.source} generator={clip.generator} />}
          <ScoreBadge label="Q" title="Quality" score={clip.quality_score} />
          <ScoreBadge label="V" title="Viral" score={clip.viral_score} />
          {clip.status && <StatusPill status={clip.status} />}
          {canEdit && clip.kind === 'snippet' && clip.status && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => onStatus(clip.status === 'approved' ? 'suggested' : 'approved')}
                disabled={busy}
                aria-pressed={clip.status === 'approved'}
                aria-label={clip.status === 'approved' ? 'Undo approve' : 'Approve'}
                title={clip.status === 'approved' ? 'Undo approve' : 'Approve'}
                className={cn(
                  'flex h-7 w-7 hover-none:h-10 hover-none:w-10 items-center justify-center rounded-md border transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  clip.status === 'approved'
                    ? 'border-status-success/40 bg-status-success/15 text-status-success'
                    : 'border-border text-text-tertiary hover:text-status-success hover:border-status-success/40',
                )}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onStatus(clip.status === 'rejected' ? 'suggested' : 'rejected')}
                disabled={busy}
                aria-pressed={clip.status === 'rejected'}
                aria-label={clip.status === 'rejected' ? 'Undo reject' : 'Reject'}
                title={clip.status === 'rejected' ? 'Undo reject' : 'Reject'}
                className={cn(
                  'flex h-7 w-7 hover-none:h-10 hover-none:w-10 items-center justify-center rounded-md border transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  clip.status === 'rejected'
                    ? 'border-status-error/40 bg-status-error/15 text-status-error'
                    : 'border-border text-text-tertiary hover:text-status-error hover:border-status-error/40',
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
