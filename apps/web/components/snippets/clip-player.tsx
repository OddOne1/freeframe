'use client'

/**
 * The playing and trimming pieces of a clip card:
 *
 *  - ClipMedia       the <video> and its HLS instance. The card mounts it only
 *                    once someone presses play, so a grid of cards does not
 *                    start a player each; useVideoPlayer does the HLS work.
 *  - InOutTimeline   the in/out range with two draggable handles.
 *  - EdgeEditor      one point as a numeric field with ±0.1 s / ±1 s nudges.
 *  - LiveTranscript  the transcript around the clip, the spoken word lit,
 *                    click a word to seek, the speaker named per segment.
 */
import * as React from 'react'
import { AlertCircle, AudioLines, Loader2, Minus, Play, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NO_PICTURE_ERROR, useVideoPlayer } from '@/hooks/use-video-player'
import { cn } from '@/lib/utils'
import { TRANSCRIPT_MAX_RANGE_MS, errorMessage } from '@/lib/snippet-api'
import {
  type InOut,
  formatClipTime,
  moveEdge,
  moveEdgeSnapped,
  parseClipTime,
  wordIndexAt,
} from '@/lib/snippet-timing'
import type { SnippetTranscript, SnippetTranscriptWord } from '@/types'

/** Transcript context fetched on each side of the clip. */
const TRANSCRIPT_CONTEXT_MS = 60_000

export function transcriptWindow(r: InOut): { from: number; to: number } {
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

// ─── The player ──────────────────────────────────────────────────────────────

export interface ClipMediaState {
  nowMs: number
  playing: boolean
  /** Null until the file's length is known. */
  durationMs: number | null
  loading: boolean
  /** A real playback error; "no picture" on an audio file is not one. */
  error: string | null
  /** The file played but never showed a picture: it is audio. */
  noPicture: boolean
}

export interface ClipMediaHandle {
  togglePlay: () => void
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  nowMs: () => number
}

/** How often the playhead is reported while playing (word highlight, time). */
const REPORT_EVERY_MS = 80

/**
 * Plays [in, out] of the clip's file. Playback starts at the in point (or at
 * `startAtMs`, a clicked word) and stops at the out point, or loops back to
 * the in point when `loopRef` is set; the out point is checked every frame.
 */
export const ClipMedia = React.forwardRef<
  ClipMediaHandle,
  {
    src: string
    poster: string | null
    /** The listing says audio (no thumbnail). */
    audioOnly: boolean
    rangeRef: React.MutableRefObject<InOut>
    loopRef: React.MutableRefObject<boolean>
    startAtMs: number | null
    autoPlay: boolean
    onState: (s: ClipMediaState) => void
    onPlaying: () => void
    label: string
    /** "cover" fills a portrait card frame (the 9:16 crop); "contain" shows
     *  the whole picture (an opened card). */
    fit?: 'cover' | 'contain'
    className?: string
  }
>(function ClipMedia(
  { src, poster, audioOnly, rangeRef, loopRef, startAtMs, autoPlay, onState, onPlaying, label, fit = 'contain', className },
  ref,
) {
  const player = useVideoPlayer(src, { detached: true })
  const video = player.videoRef
  const durationMs =
    player.duration > 0 && Number.isFinite(player.duration) ? Math.round(player.duration * 1000) : null
  const noPicture = player.error === NO_PICTURE_ERROR
  const showAudioTile = audioOnly || noPicture
  const error = noPicture ? null : player.error

  const [nowMs, setNowMs] = React.useState(startAtMs ?? rangeRef.current.start_ms)
  const nowRef = React.useRef(nowMs)
  const report = React.useCallback((ms: number) => {
    nowRef.current = ms
    setNowMs(ms)
  }, [])

  const seek = React.useCallback(
    (ms: number) => {
      const v = video.current
      const clamped = Math.max(0, durationMs != null ? Math.min(ms, durationMs) : ms)
      if (v) v.currentTime = clamped / 1000
      report(clamped)
    },
    [video, durationMs, report],
  )

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
  }, [video, rangeRef])

  React.useImperativeHandle(
    ref,
    () => ({
      togglePlay,
      play: () => {
        const v = video.current
        if (v && v.paused) togglePlay()
      },
      pause: () => video.current?.pause(),
      seek,
      // The element's own time, not the last report: reports come from
      // requestAnimationFrame, which a hidden tab does not run.
      nowMs: () => (video.current ? Math.round(video.current.currentTime * 1000) : nowRef.current),
    }),
    [togglePlay, seek, video],
  )

  // Once the length is known, park the playhead on the in point (or the
  // clicked word) and start if this card was opened by a play press.
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current || durationMs == null) return
    seeded.current = true
    const v = video.current
    if (!v) return
    const at = startAtMs ?? rangeRef.current.start_ms
    v.currentTime = Math.min(at, durationMs) / 1000
    report(Math.min(at, durationMs))
    if (autoPlay) v.play().catch(() => {})
  }, [durationMs, startAtMs, autoPlay, rangeRef, video, report])

  /** At or past the out point: stop there, or loop back to the in point.
   *  True when it acted. */
  const holdToRange = React.useCallback(
    (v: HTMLVideoElement): boolean => {
      const r = rangeRef.current
      if (v.currentTime * 1000 < r.end_ms) return false
      if (loopRef.current) v.currentTime = r.start_ms / 1000
      else {
        v.pause()
        v.currentTime = r.end_ms / 1000
      }
      report(loopRef.current ? r.start_ms : r.end_ms)
      return true
    },
    [rangeRef, loopRef, report],
  )

  // While playing, check every frame rather than on `timeupdate` (every
  // ~250 ms), so the out point is honoured to within a frame.
  React.useEffect(() => {
    if (!player.isPlaying) return
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      const v = video.current
      if (v && !holdToRange(v) && ts - last >= REPORT_EVERY_MS) {
        last = ts
        report(Math.round(v.currentTime * 1000))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [player.isPlaying, video, holdToRange, report])

  // `timeupdate`: the playhead while paused (seeks), and the out point in a
  // hidden tab, where requestAnimationFrame does not run but audio plays on.
  React.useEffect(() => {
    const v = video.current
    if (!v || !seeded.current) return
    if (player.isPlaying && holdToRange(v)) return
    report(Math.round(player.currentTime * 1000))
  }, [player.currentTime, player.isPlaying, video, holdToRange, report])

  React.useEffect(() => {
    if (player.isPlaying) onPlaying()
  }, [player.isPlaying, onPlaying])

  React.useEffect(() => {
    onState({ nowMs, playing: player.isPlaying, durationMs, loading: player.isLoading, error, noPicture })
  }, [nowMs, player.isPlaying, durationMs, player.isLoading, error, noPicture, onState])

  // Leaving: stop fetching. hls.js is destroyed by the hook; a direct file
  // (mp4, m4a, native HLS) would otherwise keep its connection open.
  React.useEffect(() => {
    const v = video.current
    return () => {
      if (!v) return
      v.pause()
      v.removeAttribute('src')
      try {
        v.load()
      } catch {
        // jsdom and some engines throw on load() without a source.
      }
    }
  }, [video])

  return (
    <div className={cn('relative h-full w-full bg-black', className)}>
      <video
        ref={player.videoRef}
        playsInline
        preload="auto"
        poster={poster ?? undefined}
        onClick={togglePlay}
        aria-label={label}
        className={cn(
          'h-full w-full cursor-pointer',
          fit === 'cover' ? 'object-cover' : 'object-contain',
          showAudioTile && 'opacity-0',
        )}
      />
      {!player.isPlaying && !player.isLoading && !error && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg">
            <Play className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden />
          </span>
        </span>
      )}
      {showAudioTile && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-bg-tertiary to-bg-hover text-text-tertiary">
          <AudioLines className={cn('h-10 w-10', player.isPlaying && 'animate-pulse text-accent')} aria-hidden />
          <span className="text-2xs uppercase tracking-wider">Audio only</span>
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-xs text-white/80">
          {error}
        </div>
      )}
      {player.isLoading && !error && (
        <Loader2 className="pointer-events-none absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/80" />
      )}
    </div>
  )
})

/** Shown in place of a player when the clip has no stream at all. */
export function NoMedia() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 text-center text-xs text-white/80">
      <AlertCircle className="h-5 w-5" aria-hidden />
      No playable media for this clip.
    </div>
  )
}

// ─── Timeline with two handles ────────────────────────────────────────────────

export function InOutTimeline({
  range,
  durationMs,
  nowMs,
  words,
  editable,
  onChange,
  onSeek,
  compact,
}: {
  range: InOut
  durationMs: number | null
  /** Null when this card has no player: no playhead line. */
  nowMs: number | null
  /** Word boundaries the handles snap to (hold Alt to place freely). */
  words: SnippetTranscriptWord[]
  editable: boolean
  onChange: (r: InOut, edge: 'in' | 'out') => void
  onSeek: (ms: number) => void
  compact?: boolean
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
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      setDrag(edge)
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return
    onChange(moveEdgeSnapped(range, drag, msAt(e.clientX), durationMs, words, !e.altKey), drag)
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
          'absolute top-0 bottom-0 z-10 flex w-6 hover-none:w-9 -translate-x-1/2 touch-none items-center justify-center focus-visible:outline-none group/handle',
          editable ? 'cursor-ew-resize' : 'pointer-events-none',
        )}
      >
        <span
          className={cn(
            'h-full rounded-[3px] shadow transition-transform group-focus-visible/handle:ring-2 group-focus-visible/handle:ring-accent/60 group-focus-visible/handle:ring-offset-1 group-focus-visible/handle:ring-offset-bg-secondary',
            editable ? 'w-2.5 bg-accent' : 'w-1 bg-accent/60',
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
        className={cn('relative select-none rounded-md bg-bg-tertiary', compact ? 'h-8 hover-none:h-10' : 'h-10')}
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
              className="absolute top-2.5 bottom-2.5 w-px bg-text-tertiary/40"
              style={{ left: pct(w.start_ms) }}
              aria-hidden
            />
          ))}
        <div
          data-track="1"
          className="absolute top-0 bottom-0 rounded-sm border-y border-accent/50 bg-accent/15"
          style={{ left: pct(range.start_ms), width: `calc(${pct(range.end_ms)} - ${pct(range.start_ms)})` }}
        />
        {nowMs != null && nowMs >= view.from && nowMs <= view.to && (
          <span className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-text-primary" style={{ left: pct(nowMs) }} aria-hidden />
        )}
        {handle('in')}
        {handle('out')}
      </div>
      {!compact && (
        <div className="flex justify-between text-2xs tabular-nums text-text-tertiary">
          <span>{formatClipTime(view.from)}</span>
          <span>{formatClipTime(view.to)}</span>
        </div>
      )}
    </div>
  )
}

// ─── Numeric in/out field with nudges ─────────────────────────────────────────

/**
 * "full": a field and four nudges (−1 s, −0.1, +0.1, +1 s).
 * "inline": the card's row, `In − 1:11.1 +`: the time reads as text and is a
 * field on click; − and + move 0.1 s, 1 s with Shift held.
 */
export function EdgeEditor({
  label,
  valueMs,
  onCommit,
  onNudge,
  variant = 'full',
}: {
  label: 'In' | 'Out'
  valueMs: number
  onCommit: (ms: number) => void
  onNudge: (deltaMs: number) => void
  variant?: 'full' | 'inline'
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
    if (ms !== valueMs) onCommit(ms)
  }

  const nudgeBtn = (d: number, l: string) => (
    <button
      type="button"
      onClick={() => onNudge(d)}
      aria-label={`${label} ${d > 0 ? 'plus' : 'minus'} ${Math.abs(d) / 1000} seconds`}
      className="h-7 hover-none:h-10 min-w-[2rem] rounded-md border border-border bg-bg-secondary px-1 text-2xs tabular-nums text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {l}
    </button>
  )

  const field = (className: string) => (
    <input
      value={text}
      inputMode="decimal"
      onFocus={(e) => {
        setEditing(true)
        e.currentTarget.select()
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(formatClipTime(valueMs))
          setEditing(false)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      aria-label={`${label} point (m:ss.t or seconds)`}
      aria-invalid={invalid || undefined}
      className={cn(className, invalid && 'ring-1 ring-status-error')}
    />
  )

  if (variant === 'inline') {
    const step = (sign: 1 | -1) => (
      <button
        type="button"
        onClick={(e) => onNudge(sign * (e.shiftKey ? 1000 : 100))}
        aria-label={`${label} ${sign > 0 ? 'plus' : 'minus'} 0.1 seconds`}
        title={`${sign > 0 ? '+' : '−'}0.1 s (Shift: 1 s)`}
        className="flex h-7 w-6 hover-none:h-9 hover-none:w-7 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        {sign > 0 ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
      </button>
    )
    return (
      <div className="flex items-center">
        <span className="mr-1 text-xs text-text-tertiary">{label}</span>
        {step(-1)}
        {field(
          'h-7 hover-none:h-9 w-[4.75rem] rounded bg-transparent px-1 text-center font-mono text-[13px] tabular-nums text-text-primary hover:bg-bg-hover focus:bg-bg-primary focus:outline-none focus:ring-1 focus:ring-border-focus',
        )}
        {step(1)}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <span className="w-6">{label}</span>
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
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          aria-label={`${label} point (m:ss.t or seconds)`}
          aria-invalid={invalid || undefined}
          className={cn(
            'h-7 hover-none:h-10 w-[4.25rem] rounded-md border bg-bg-primary px-1.5 text-xs tabular-nums text-text-primary focus:outline-none focus:ring-1 focus:ring-border-focus',
            invalid ? 'border-status-error' : 'border-border focus:border-border-focus',
          )}
        />
      </label>
      <span className="flex gap-1">
        {nudgeBtn(-1000, '−1s')}
        {nudgeBtn(-100, '−.1')}
        {nudgeBtn(100, '+.1')}
        {nudgeBtn(1000, '+1s')}
      </span>
    </div>
  )
}

// ─── Live transcript ──────────────────────────────────────────────────────────

export function LiveTranscript({
  transcript,
  loading,
  error,
  onRetry,
  nowMs,
  range,
  onSeek,
  onSpeaker,
  className,
}: {
  transcript: SnippetTranscript | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  /** Null when this card has no player: nothing is lit. */
  nowMs: number | null
  range: InOut
  onSeek: (ms: number) => void
  /** Editors: the speaker label opens the track's speaker assignment. */
  onSpeaker?: (trackIndex: number) => void
  className?: string
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const segments = React.useMemo(() => transcript?.segments ?? [], [transcript])
  const allWords = React.useMemo(() => segments.flatMap((s) => s.words), [segments])
  const activeIdx = nowMs == null ? -1 : wordIndexAt(allWords, nowMs)
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

  // On open, start at the clip rather than at the context before it.
  const scrolledToClip = React.useRef(false)
  React.useEffect(() => {
    const box = boxRef.current
    if (!box || scrolledToClip.current || segments.length === 0) return
    const el = box.querySelector<HTMLElement>('[data-inside="1"]')
    if (!el) return
    scrolledToClip.current = true
    box.scrollTop = Math.max(0, el.offsetTop - box.offsetTop - 12)
  }, [segments])

  if (loading && !transcript) {
    return (
      <div className={cn('space-y-2 px-3 pb-3', className)} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-bg-tertiary" />
        ))}
      </div>
    )
  }
  if (error && !transcript) {
    return (
      <div className={cn('px-3 pb-3 text-sm text-text-secondary', className)}>
        <p role="alert">Could not load the transcript. {errorMessage(error)}</p>
        <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  if (segments.length === 0) {
    return <p className={cn('px-3 pb-3 text-sm text-text-tertiary', className)}>No transcript around this clip.</p>
  }

  return (
    <div ref={boxRef} className={cn('relative min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3', className)}>
      {segments.map((seg) => {
        const speaker = seg.speaker_name ?? `Track ${seg.track_index + 1}`
        const segInside = seg.end_ms > range.start_ms && seg.start_ms < range.end_ms
        return (
          <div key={seg.id} data-inside={segInside ? '1' : undefined}>
            <p className="mb-0.5 text-2xs font-semibold text-text-tertiary">
              {onSpeaker ? (
                <button
                  type="button"
                  onClick={() => onSpeaker(seg.track_index)}
                  title={`Change the speaker of track ${seg.track_index + 1}`}
                  className="rounded hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  {speaker}
                </button>
              ) : (
                speaker
              )}
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
        )
      })}
    </div>
  )
}
