'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, AudioLines, Loader2, Pause, Play, Repeat, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOptionalToast } from '@/components/shared/toast'
import { useVideoPlayer } from '@/hooks/use-video-player'
import { cn, resolveApiMediaUrl, resolveStreamUrl } from '@/lib/utils'
import {
  TRANSCRIPT_MAX_RANGE_MS,
  errorMessage,
  snippetApi,
  snippetFetcher,
  snippetKeys,
} from '@/lib/snippet-api'
import {
  type InOut,
  clampClip,
  formatClipTime,
  formatDuration,
  isValidClip,
  moveEdge,
  moveEdgeSnapped,
  parseClipTime,
  wordIndexAt,
} from '@/lib/snippet-timing'
import type { SnippetClip, SnippetTranscript, SnippetTranscriptWord } from '@/types'
import { ClipExports } from './clip-exports'
import { HintTooltip, LabelledSwitch, ScoreBadge, SourceBadge, StatusPill } from './snippet-ui'

/** Transcript context fetched on each side of the clip. */
const TRANSCRIPT_CONTEXT_MS = 60_000

function transcriptWindow(r: InOut): { from: number; to: number } {
  const from = Math.max(0, r.start_ms - TRANSCRIPT_CONTEXT_MS)
  const to = Math.min(from + TRANSCRIPT_MAX_RANGE_MS, r.end_ms + TRANSCRIPT_CONTEXT_MS)
  return { from, to }
}

/** The stretch of file the timeline shows: the clip plus some room either side. */
function timelineView(r: InOut, durationMs: number | null): { from: number; to: number } {
  const pad = Math.max(3000, Math.round((r.end_ms - r.start_ms) * 0.35))
  const from = Math.max(0, r.start_ms - pad)
  const to = durationMs ? Math.min(durationMs, r.end_ms + pad) : r.end_ms + pad
  return { from, to: Math.max(to, from + 1000) }
}

export function ClipPlayerDialog({
  clip,
  onOpenChange,
  canEdit,
  onSaved,
}: {
  clip: SnippetClip | null
  onOpenChange: (open: boolean) => void
  canEdit: boolean
  onSaved: (clip: SnippetClip) => void
}) {
  return (
    <Dialog.Root open={clip !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg-secondary md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(88vh,820px)] md:w-[min(96vw,1180px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          {clip && <ClipPlayer key={clip.id} clip={clip} canEdit={canEdit} onSaved={onSaved} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ClipPlayer({
  clip,
  canEdit,
  onSaved,
}: {
  clip: SnippetClip
  canEdit: boolean
  onSaved: (clip: SnippetClip) => void
}) {
  const toast = useOptionalToast()
  const isMoment = clip.kind === 'moment'
  const editable = canEdit && !isMoment
  // Resolved exactly once, here: useVideoPlayer does not resolve (VideoPlayer
  // does, and this component does not use VideoPlayer). See lib/utils.ts.
  const src = clip.stream_url ? resolveStreamUrl(clip.stream_url) : null
  const poster = resolveApiMediaUrl(clip.thumbnail_url)
  const player = useVideoPlayer(src, { detached: true })
  const durationMs = player.duration > 0 && Number.isFinite(player.duration) ? Math.round(player.duration * 1000) : null

  const [saved, setSaved] = React.useState<InOut>({ start_ms: clip.start_ms, end_ms: clip.end_ms })
  const [range, setRange] = React.useState<InOut>(saved)
  const [loop, setLoop] = React.useState(false)
  const [snap, setSnap] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const rangeRef = React.useRef(range)
  rangeRef.current = range
  const loopRef = React.useRef(loop)
  loopRef.current = loop
  const dirty = range.start_ms !== saved.start_ms || range.end_ms !== saved.end_ms

  // ── Transcript (words for captions and snapping) ──────────────────────────
  const [win, setWin] = React.useState(() => transcriptWindow(range))
  React.useEffect(() => {
    if (range.start_ms < win.from || range.end_ms > win.to) setWin(transcriptWindow(range))
  }, [range, win])
  const transcriptSWR = useSWR<SnippetTranscript>(
    snippetKeys.transcript(clip.media_file_id, win.from, win.to),
    snippetFetcher,
    { keepPreviousData: true, shouldRetryOnError: false },
  )
  const words: SnippetTranscriptWord[] = React.useMemo(
    () =>
      (transcriptSWR.data?.segments ?? [])
        .flatMap((s) => s.words)
        .sort((a, b) => a.start_ms - b.start_ms),
    [transcriptSWR.data],
  )

  // ── Playback held to [in, out] ────────────────────────────────────────────
  const video = player.videoRef
  const seekMs = React.useCallback(
    (ms: number) => {
      const v = video.current
      if (!v) return
      v.currentTime = ms / 1000
    },
    [video],
  )

  // Once the length is known: clamp a stored clip that overruns it, and park
  // the playhead on the in point.
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current || durationMs == null) return
    seeded.current = true
    const fixed = clampClip(rangeRef.current, durationMs)
    if (fixed.start_ms !== rangeRef.current.start_ms || fixed.end_ms !== rangeRef.current.end_ms) setRange(fixed)
    seekMs(fixed.start_ms)
  }, [durationMs, seekMs])

  // While playing, check every frame rather than on `timeupdate` (every
  // ~250 ms), so the out point is honoured to within a frame.
  React.useEffect(() => {
    if (!player.isPlaying) return
    let raf = 0
    const tick = () => {
      const v = video.current
      if (v) {
        const t = v.currentTime * 1000
        const r = rangeRef.current
        if (t >= r.end_ms) {
          if (loopRef.current) v.currentTime = r.start_ms / 1000
          else {
            v.pause()
            v.currentTime = r.end_ms / 1000
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [player.isPlaying, video])

  const togglePlay = React.useCallback(() => {
    const v = video.current
    if (!v) return
    if (!v.paused) {
      v.pause()
      return
    }
    const t = v.currentTime * 1000
    const r = rangeRef.current
    if (t < r.start_ms - 50 || t >= r.end_ms - 50) v.currentTime = r.start_ms / 1000
    v.play().catch(() => {})
  }, [video])

  /** Apply a new range and preview it: moving the in point jumps there,
   *  moving the out point plays into it from two seconds before. */
  const applyRange = React.useCallback(
    (next: InOut, edge: 'in' | 'out' | 'both') => {
      setRange(next)
      setSaveError(null)
      if (edge === 'in' || edge === 'both') seekMs(next.start_ms)
      else seekMs(Math.max(next.start_ms, next.end_ms - 2000))
    },
    [seekMs],
  )

  const nudge = (edge: 'in' | 'out', deltaMs: number) => {
    const r = rangeRef.current
    applyRange(moveEdge(r, edge, (edge === 'in' ? r.start_ms : r.end_ms) + deltaMs, durationMs), edge)
  }

  async function save() {
    if (!editable) return
    const r = clampClip(range, durationMs)
    if (!isValidClip(r, durationMs)) {
      setSaveError('A clip must be at least 1 second long and inside the file.')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await snippetApi.patchSnippet(clip.id, { start_ms: r.start_ms, end_ms: r.end_ms })
      setSaved({ start_ms: updated.start_ms, end_ms: updated.end_ms })
      setRange({ start_ms: updated.start_ms, end_ms: updated.end_ms })
      onSaved(updated)
      toast('In/out saved', 'success')
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not save the in/out points.'))
    } finally {
      setSaving(false)
    }
  }

  // Space / k toggles playback, unless a control has focus.
  function onKeyDown(e: React.KeyboardEvent) {
    const el = e.target as HTMLElement
    if (el.closest('input, textarea, button, [role="slider"], [role="switch"], a')) return
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault()
      togglePlay()
    }
  }

  const nowMs = Math.round(player.currentTime * 1000)
  const heading = clip.title ?? 'Transcript moment'

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <Dialog.Title className="truncate text-sm font-semibold text-text-primary">{heading}</Dialog.Title>
          <p className="mt-0.5 truncate text-xs text-text-tertiary">
            {clip.speaker?.name ?? 'Unknown speaker'} · {clip.asset_name}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {clip.source && <SourceBadge source={clip.source} generator={clip.generator} />}
            <ScoreBadge label="Q" title="Quality" score={clip.quality_score} />
            <ScoreBadge label="V" title="Viral" score={clip.viral_score} />
            {clip.status && <StatusPill status={clip.status} />}
          </div>
        </div>
        <Dialog.Close
          aria-label="Close player"
          className="rounded p-1 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <X className="h-5 w-5" />
        </Dialog.Close>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* Player + in/out editing */}
        <div className="flex flex-col gap-4 p-4 lg:min-h-0 lg:flex-[3] lg:overflow-y-auto">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
            <video
              ref={player.videoRef}
              playsInline
              preload="metadata"
              poster={poster ?? undefined}
              onClick={togglePlay}
              className={cn('h-full w-full object-contain', !poster && !clip.thumbnail_url && 'opacity-0')}
            />
            {!clip.thumbnail_url && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
                <AudioLines className="h-12 w-12" aria-hidden />
                <span className="text-xs uppercase tracking-wider">Audio only</span>
              </div>
            )}
            {!src && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 text-center text-sm text-white/80">
                <AlertCircle className="h-6 w-6" aria-hidden />
                No playable media for this clip.
              </div>
            )}
            {src && player.error && (
              <div role="alert" className="absolute inset-0 flex items-center justify-center bg-black/80 p-6 text-center text-sm text-white/80">
                {player.error}
              </div>
            )}
            {src && player.isLoading && !player.error && (
              <Loader2 className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />
            )}
          </div>

          {/* Transport */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={togglePlay}
              disabled={!src}
              aria-label={player.isPlaying ? 'Pause' : 'Play clip'}
            >
              {player.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {player.isPlaying ? 'Pause' : 'Play'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={loop ? 'primary' : 'secondary'}
              aria-pressed={loop}
              onClick={() => setLoop((v) => !v)}
              title="Loop between in and out"
            >
              <Repeat className="h-4 w-4" />
              Loop
            </Button>
            <span className="ml-auto text-xs tabular-nums text-text-secondary" aria-live="off">
              {formatClipTime(nowMs)} · clip {formatDuration(range.end_ms - range.start_ms)}
            </span>
          </div>

          <InOutTimeline
            range={range}
            durationMs={durationMs}
            nowMs={nowMs}
            words={words}
            snap={snap}
            editable={editable}
            onChange={applyRange}
            onSeek={seekMs}
          />

          {editable ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <EdgeEditor label="In" valueMs={range.start_ms} onCommit={(ms) => applyRange(moveEdge(range, 'in', ms, durationMs), 'in')} onNudge={(d) => nudge('in', d)} />
                <EdgeEditor label="Out" valueMs={range.end_ms} onCommit={(ms) => applyRange(moveEdge(range, 'out', ms, durationMs), 'out')} onNudge={(d) => nudge('out', d)} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-[200px] flex-1">
                  <LabelledSwitch label="Snap to words" description="Dragged handles land on word boundaries." checked={snap} onCheckedChange={setSnap} />
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => applyRange(saved, 'both')} disabled={!dirty}>
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </Button>
                <Button type="button" size="sm" onClick={save} loading={saving} disabled={!dirty}>
                  Save in/out
                </Button>
              </div>
              {saveError && (
                <p role="alert" className="text-sm text-status-error">
                  {saveError}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary">
              {formatClipTime(range.start_ms)} – {formatClipTime(range.end_ms)}
            </p>
          )}

          {isMoment && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <p className="flex-1 text-xs text-text-tertiary">
                This is a transcript moment, not a saved clip. Save it as a clip to edit its in/out.
              </p>
              <HintTooltip hint="Create clip: coming soon">
                <Button type="button" size="sm" variant="secondary" disabled>
                  Create clip
                </Button>
              </HintTooltip>
            </div>
          )}
          {canEdit && (
            // Exports create files on the server, so they are an editor's
            // action like the rest of this panel; the server checks too.
            // They render the in/out on screen now, saved or not, and a
            // moment exports its own range under its "moment:..." id.
            <div className="border-t border-border pt-3">
              <ClipExports
                snippetId={clip.id}
                range={range}
                valid={isValidClip(range, durationMs)}
              />
            </div>
          )}
        </div>

        {/* Live transcript */}
        <div className="flex min-h-[240px] flex-col border-t border-border lg:min-h-0 lg:flex-[2] lg:border-l lg:border-t-0">
          <h3 className="px-4 pb-2 pt-3 text-2xs font-semibold uppercase tracking-wider text-text-tertiary">Transcript</h3>
          <LiveTranscript
            transcript={transcriptSWR.data}
            loading={transcriptSWR.isLoading}
            error={transcriptSWR.error}
            onRetry={() => transcriptSWR.mutate()}
            nowMs={nowMs}
            range={range}
            onSeek={seekMs}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Timeline with two handles ────────────────────────────────────────────────

function InOutTimeline({
  range,
  durationMs,
  nowMs,
  words,
  snap,
  editable,
  onChange,
  onSeek,
}: {
  range: InOut
  durationMs: number | null
  nowMs: number
  words: SnippetTranscriptWord[]
  snap: boolean
  editable: boolean
  onChange: (r: InOut, edge: 'in' | 'out') => void
  onSeek: (ms: number) => void
}) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const [drag, setDrag] = React.useState<'in' | 'out' | null>(null)
  // Frozen while dragging, so the scale does not move under the pointer.
  const [view, setView] = React.useState(() => timelineView(range, durationMs))
  React.useEffect(() => {
    if (!drag) setView(timelineView(range, durationMs))
  }, [range, durationMs, drag])

  const span = view.to - view.from
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - view.from) / span) * 100))}%`
  const msAt = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return view.from + ((clientX - rect.left) / rect.width) * span
  }

  function onPointerDown(edge: 'in' | 'out') {
    return (e: React.PointerEvent) => {
      if (!editable) return
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      setDrag(edge)
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return
    onChange(moveEdgeSnapped(range, drag, msAt(e.clientX), durationMs, words, snap), drag)
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!drag) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    setDrag(null)
  }

  function onHandleKey(edge: 'in' | 'out') {
    return (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 1000 : 100
      const cur = edge === 'in' ? range.start_ms : range.end_ms
      let next: number | null = null
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step
      if (e.key === 'PageDown') next = cur - 5000
      if (e.key === 'PageUp') next = cur + 5000
      if (next == null) return
      e.preventDefault()
      onChange(moveEdge(range, edge, next, durationMs), edge)
    }
  }

  const handle = (edge: 'in' | 'out') => {
    const ms = edge === 'in' ? range.start_ms : range.end_ms
    return (
      <div
        role="slider"
        tabIndex={editable ? 0 : -1}
        aria-label={edge === 'in' ? 'In point' : 'Out point'}
        aria-valuemin={0}
        aria-valuemax={durationMs ?? undefined}
        aria-valuenow={ms}
        aria-valuetext={formatClipTime(ms)}
        aria-disabled={!editable}
        onPointerDown={onPointerDown(edge)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={editable ? onHandleKey(edge) : undefined}
        style={{ left: pct(ms) }}
        className={cn(
          'absolute top-0 bottom-0 z-10 flex w-6 -translate-x-1/2 touch-none items-center justify-center focus-visible:outline-none group/handle',
          editable ? 'cursor-ew-resize' : 'pointer-events-none',
        )}
      >
        <span
          className={cn(
            'h-full w-2 rounded-sm bg-accent shadow transition-transform group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-accent/60 group-focus-visible/handle:ring-offset-1 group-focus-visible/handle:ring-offset-bg-secondary',
            drag === edge && 'scale-x-125',
          )}
        />
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div
        ref={trackRef}
        className="relative h-10 select-none rounded-md bg-bg-tertiary"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.track === '1') onSeek(msAt(e.clientX))
        }}
      >
        {/* word ticks */}
        {words
          .filter((w) => w.start_ms >= view.from && w.start_ms <= view.to)
          .map((w) => (
            <span
              key={`${w.start_ms}-${w.end_ms}`}
              data-track="1"
              className="absolute top-3 bottom-3 w-px bg-text-tertiary/40"
              style={{ left: pct(w.start_ms) }}
              aria-hidden
            />
          ))}
        <div
          data-track="1"
          className="absolute top-0 bottom-0 rounded-sm bg-accent/20"
          style={{ left: pct(range.start_ms), width: `calc(${pct(range.end_ms)} - ${pct(range.start_ms)})` }}
        />
        {nowMs >= view.from && nowMs <= view.to && (
          <span className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-text-primary" style={{ left: pct(nowMs) }} aria-hidden />
        )}
        {handle('in')}
        {handle('out')}
      </div>
      <div className="flex justify-between text-2xs tabular-nums text-text-tertiary">
        <span>{formatClipTime(view.from)}</span>
        <span>{formatClipTime(view.to)}</span>
      </div>
    </div>
  )
}

// ─── Numeric in/out field with nudges ─────────────────────────────────────────

function EdgeEditor({
  label,
  valueMs,
  onCommit,
  onNudge,
}: {
  label: 'In' | 'Out'
  valueMs: number
  onCommit: (ms: number) => void
  onNudge: (deltaMs: number) => void
}) {
  const [text, setText] = React.useState(formatClipTime(valueMs))
  const [editing, setEditing] = React.useState(false)
  const [invalid, setInvalid] = React.useState(false)
  React.useEffect(() => {
    if (!editing) setText(formatClipTime(valueMs))
  }, [valueMs, editing])

  function commit() {
    setEditing(false)
    const ms = parseClipTime(text)
    if (ms == null) {
      setInvalid(true)
      setText(formatClipTime(valueMs))
      return
    }
    setInvalid(false)
    onCommit(ms)
  }

  const nudgeBtn = (d: number, l: string) => (
    <button
      type="button"
      onClick={() => onNudge(d)}
      aria-label={`${label} ${d > 0 ? 'plus' : 'minus'} ${Math.abs(d) / 1000} seconds`}
      className="h-8 hover-none:h-10 min-w-[2.5rem] rounded-md border border-border bg-bg-secondary px-1.5 text-xs tabular-nums text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {l}
    </button>
  )

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
        <span className="w-7">{label}</span>
        <input
          value={text}
          inputMode="decimal"
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(formatClipTime(valueMs))
              setEditing(false)
            }
          }}
          aria-label={`${label} point (m:ss.t or seconds)`}
          aria-invalid={invalid || undefined}
          className={cn(
            'h-8 hover-none:h-10 w-24 rounded-md border bg-bg-secondary px-2 text-sm tabular-nums text-text-primary focus:outline-none focus:ring-1 focus:ring-border-focus',
            invalid ? 'border-status-error' : 'border-border focus:border-border-focus',
          )}
        />
      </label>
      <div className="flex gap-1 pl-9">
        {nudgeBtn(-1000, '−1s')}
        {nudgeBtn(-100, '−0.1')}
        {nudgeBtn(100, '+0.1')}
        {nudgeBtn(1000, '+1s')}
      </div>
    </div>
  )
}

// ─── Live transcript ──────────────────────────────────────────────────────────

function LiveTranscript({
  transcript,
  loading,
  error,
  onRetry,
  nowMs,
  range,
  onSeek,
}: {
  transcript: SnippetTranscript | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  nowMs: number
  range: InOut
  onSeek: (ms: number) => void
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const segments = React.useMemo(() => transcript?.segments ?? [], [transcript])
  const allWords = React.useMemo(() => segments.flatMap((s) => s.words), [segments])
  const activeIdx = wordIndexAt(allWords, nowMs)
  const active = activeIdx >= 0 ? allWords[activeIdx] : null

  // Keep the spoken word in view, scrolling the panel only (never the page).
  React.useEffect(() => {
    const box = boxRef.current
    if (!box || !active) return
    const el = box.querySelector<HTMLElement>('[data-active="1"]')
    if (!el) return
    const top = el.offsetTop - box.offsetTop
    if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 48) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: 'smooth' })
    }
  }, [active])

  if (loading && !transcript) {
    return (
      <div className="space-y-2 px-4 pb-4" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-bg-tertiary" />
        ))}
      </div>
    )
  }
  if (error && !transcript) {
    return (
      <div className="px-4 pb-4 text-sm text-text-secondary">
        <p role="alert">Could not load the transcript. {errorMessage(error)}</p>
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  if (segments.length === 0) {
    return <p className="px-4 pb-4 text-sm text-text-tertiary">No transcript around this clip.</p>
  }

  return (
    <div ref={boxRef} className="relative min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
      {segments.map((seg) => (
        <div key={seg.id}>
          <p className="mb-0.5 text-2xs font-semibold text-text-tertiary">
            {seg.speaker_name ?? `Track ${seg.track_index + 1}`}
            <span className="ml-1.5 font-normal tabular-nums">{formatClipTime(seg.start_ms)}</span>
          </p>
          <p className="text-sm leading-relaxed">
            {seg.words.length === 0 ? (
              <span className="text-text-secondary">{seg.text}</span>
            ) : (
              seg.words.map((w, i) => {
                const isActive = active === w
                const inside = w.end_ms > range.start_ms && w.start_ms < range.end_ms
                return (
                  <React.Fragment key={`${w.start_ms}-${i}`}>
                    <span
                      data-active={isActive ? '1' : undefined}
                      onClick={() => onSeek(w.start_ms)}
                      className={cn(
                        'cursor-pointer rounded px-0.5 transition-colors',
                        isActive
                          ? 'bg-accent/25 text-text-primary'
                          : inside
                            ? 'text-text-primary hover:bg-bg-hover'
                            : 'text-text-tertiary hover:bg-bg-hover',
                      )}
                    >
                      {w.word}
                    </span>{' '}
                  </React.Fragment>
                )
              })
            )}
          </p>
        </div>
      ))}
    </div>
  )
}
