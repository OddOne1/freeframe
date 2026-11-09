'use client'

import * as React from 'react'
import useSWR from 'swr'
import { AudioLines, Check, Loader2, Pause, Pencil, Play, Plus, Repeat, RotateCcw, X } from 'lucide-react'
import { cn, resolveApiMediaUrl, resolveStreamUrl } from '@/lib/utils'
import { errorMessage, snippetApi, snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import { type InOut, formatClipTime, formatDuration, isValidClip, moveEdge } from '@/lib/snippet-timing'
import {
  type AutosaveStatus,
  type Autosaver,
  type PlayerGroup,
  type ShortcutAction,
  addTopic,
  createAutosaver,
  dominantTrack,
  inversePatch,
  isEmptyPatch,
  removeTopic,
} from '@/lib/snippet-card'
import { Button } from '@/components/ui/button'
import { useOptionalToast } from '@/components/shared/toast'
import type {
  SnippetClip,
  SnippetPatch,
  SnippetSpeaker,
  SnippetStatus,
  SnippetTrackSpeakerResponse,
  SnippetTranscript,
  SnippetTranscriptWord,
} from '@/types'
import { ClipExports } from './clip-exports'
import {
  ClipMedia,
  type ClipMediaHandle,
  type ClipMediaState,
  EdgeEditor,
  InOutTimeline,
  LiveTranscript,
  NoMedia,
  transcriptWindow,
} from './clip-player'
import { ClipMenu } from './clip-menu'
import { EditedPill, HintTooltip, ScoreBadge, SourceBadge, StatusPill } from './snippet-ui'
import { ClipTracksControl, SpeakerSelect, useTrackSpeakerAssign } from './speaker-assign'

/** What a card edits. Saved with PATCH /snippets/{id}. */
type Draft = {
  title: string | null
  topics: string[]
  status: SnippetStatus | null
  start_ms: number
  end_ms: number
}

const draftOf = (c: SnippetClip): Draft => ({
  title: c.title,
  topics: c.topics,
  status: c.status,
  start_ms: c.start_ms,
  end_ms: c.end_ms,
})

/** What the page drives a card with: the keyboard shortcuts and Undo. */
export interface ClipCardController {
  clipId: string
  /** True when the card did something with the shortcut. */
  run: (action: ShortcutAction) => boolean
  /** Put back what a save changed (the Undo toast). */
  undo: (inverse: SnippetPatch) => void
  /** Something is waiting to be saved or being saved. */
  busy: () => boolean
}

export interface ClipCardProps {
  /** Unique per card: the same clip can appear under several topics. */
  cardKey: string
  clip: SnippetClip
  projectId: string
  canEdit: boolean
  speakers: SnippetSpeaker[]
  activeTopics: string[]
  /** This card has the player (only one card does). */
  active: boolean
  /** This card is open with its transcript (only one is). */
  expanded: boolean
  group: PlayerGroup
  onTopic: (topic: string) => void
  onToggleExpand: (cardKey: string) => void
  onSaved: (clip: SnippetClip, sent: SnippetPatch, inverse: SnippetPatch, cardKey: string) => void
  onTracksChanged: (res: SnippetTrackSpeakerResponse) => void
  /** The owner's "Hide source file" (asks first); left out for everyone else. */
  onHideSource?: (clip: SnippetClip) => void
  register: (cardKey: string, controller: ClipCardController) => () => void
}

/**
 * One search result, played and edited where it is.
 *
 * A "snippet" is a stored clip with a title, source, scores and a review
 * status; a "moment" is a transcript hit no clip covers (its title, source,
 * generator and status are null by contract): it plays and can be exported,
 * but nothing on it is editable.
 *
 * The <video> and its HLS instance exist only while the card is the active
 * one (see createPlayerGroup). Edits go into a local draft at once and are
 * saved 600 ms after the last change, merged into one PATCH.
 *
 * Clicking the title (only the title) opens the card across the row with the
 * transcript beside the player; clicking it again, or Close, closes it.
 */
export const ClipCard = React.memo(function ClipCard(props: ClipCardProps) {
  const { cardKey, clip, projectId, canEdit, speakers, activeTopics, active, expanded, group, onTopic, onToggleExpand } =
    props
  const latest = React.useRef(props)
  latest.current = props
  const toast = useOptionalToast()

  const isMoment = clip.kind === 'moment'
  const editable = canEdit && !isMoment
  // Resolved exactly once, here: useVideoPlayer does not resolve. See lib/utils.ts.
  const src = clip.stream_url ? resolveStreamUrl(clip.stream_url) : null
  const poster = resolveApiMediaUrl(clip.thumbnail_url)

  // ── Draft and autosave ───────────────────────────────────────────────────
  const [draft, setDraftState] = React.useState<Draft>(() => draftOf(clip))
  const draftRef = React.useRef(draft)
  const setDraft = React.useCallback((d: Draft) => {
    draftRef.current = d
    setDraftState(d)
  }, [])
  const [saveStatus, setSaveStatus] = React.useState<AutosaveStatus>({ state: 'idle' })
  const saverRef = React.useRef<Autosaver<SnippetPatch, SnippetClip> | null>(null)
  if (!saverRef.current) {
    saverRef.current = createAutosaver<SnippetPatch, SnippetClip>({
      save: (patch) => snippetApi.patchSnippet(clip.id, patch),
      onStatus: setSaveStatus,
      onSaved: (updated, sent, inverse) => latest.current.onSaved(updated, sent, inverse, latest.current.cardKey),
    })
  }
  const saver = saverRef.current
  // Leaving the page (filters, tab, a refetch that drops the card): what is
  // still waiting is sent rather than lost.
  React.useEffect(() => () => void saver.flush(), [saver])
  // The server's copy wins whenever nothing of ours is in the air.
  React.useEffect(() => {
    if (!saver.busy()) setDraft(draftOf(clip))
  }, [clip, saver, setDraft])

  const change = React.useCallback(
    (patch: Partial<Draft>) => {
      const d = draftRef.current
      const inverse = inversePatch<Draft>(d, patch)
      if (isEmptyPatch(inverse)) return
      setDraft({ ...d, ...patch })
      saver.queue(patch as SnippetPatch, inverse as SnippetPatch)
    },
    [saver, setDraft],
  )

  const range: InOut = React.useMemo(
    () => ({ start_ms: draft.start_ms, end_ms: draft.end_ms }),
    [draft.start_ms, draft.end_ms],
  )
  const rangeRef = React.useRef(range)
  rangeRef.current = range
  const [original] = React.useState<InOut>(() => ({ start_ms: clip.start_ms, end_ms: clip.end_ms }))

  // ── Player (mounted only while active) ───────────────────────────────────
  const mediaRef = React.useRef<ClipMediaHandle>(null)
  const [media, setMedia] = React.useState<ClipMediaState | null>(null)
  const [launch, setLaunch] = React.useState<{ autoPlay: boolean; at: number | null }>({ autoPlay: true, at: null })
  const [loop, setLoop] = React.useState(false)
  const loopRef = React.useRef(loop)
  loopRef.current = loop
  React.useEffect(() => {
    if (!active) setMedia(null)
  }, [active])
  React.useEffect(() => {
    if (!active) return
    return group.register(cardKey, { pause: () => mediaRef.current?.pause() })
  }, [active, group, cardKey])
  const onPlaying = React.useCallback(() => group.playing(cardKey), [group, cardKey])

  const durationMs = media?.durationMs ?? null
  const nowMs = active ? (media?.nowMs ?? null) : null
  const playing = active && !!media?.playing
  const audioOnly = !clip.thumbnail_url || !!media?.noPicture

  const activate = React.useCallback(
    (opts: { autoPlay: boolean; at?: number | null }) => {
      if (!src) return
      setLaunch({ autoPlay: opts.autoPlay, at: opts.at ?? null })
      group.activate(cardKey)
    },
    [src, group, cardKey],
  )
  const togglePlay = React.useCallback(() => {
    if (active && mediaRef.current) mediaRef.current.togglePlay()
    else activate({ autoPlay: true })
  }, [active, activate])
  const seekTo = React.useCallback(
    (ms: number) => {
      if (active && mediaRef.current) mediaRef.current.seek(ms)
      else activate({ autoPlay: false, at: ms })
    },
    [active, activate],
  )

  /** A new range, previewed: moving the in point jumps there, moving the out
   *  point plays into it from two seconds before. */
  const applyRange = React.useCallback(
    (next: InOut, edge: 'in' | 'out' | 'both') => {
      change(next)
      if (!active || !mediaRef.current) return
      if (edge === 'out') mediaRef.current.seek(Math.max(next.start_ms, next.end_ms - 2000))
      else mediaRef.current.seek(next.start_ms)
    },
    [change, active],
  )
  const nudge = (edge: 'in' | 'out', deltaMs: number) => {
    const r = rangeRef.current
    applyRange(moveEdge(r, edge, (edge === 'in' ? r.start_ms : r.end_ms) + deltaMs, durationMs), edge)
  }

  // ── Keyboard and Undo, driven by the page ────────────────────────────────
  const runRef = React.useRef<(a: ShortcutAction) => boolean>(() => false)
  runRef.current = (a) => {
    const m = active ? mediaRef.current : null
    switch (a.type) {
      case 'toggle-play':
        if (!src) return false
        togglePlay()
        return true
      case 'toggle-expand':
        onToggleExpand(cardKey)
        return true
      case 'seek':
        if (!m) return false
        m.seek(m.nowMs() + a.deltaMs)
        return true
      case 'set-in':
      case 'set-out':
        if (!m || !editable) return false
        change(moveEdge(rangeRef.current, a.type === 'set-in' ? 'in' : 'out', m.nowMs(), durationMs))
        return true
    }
  }
  React.useEffect(
    () =>
      latest.current.register(cardKey, {
        clipId: clip.id,
        run: (a) => runRef.current(a),
        undo: (inverse) => {
          setDraft({ ...draftRef.current, ...(inverse as Partial<Draft>) })
          saver.queue(inverse, {})
          void saver.flush()
        },
        busy: () => saver.busy(),
      }),
    [cardKey, clip.id, saver, setDraft],
  )

  // ── Speakers ─────────────────────────────────────────────────────────────
  const onTracksChanged = React.useCallback(
    (res: SnippetTrackSpeakerResponse) => latest.current.onTracksChanged(res),
    [],
  )
  const assignApi = useTrackSpeakerAssign({
    projectId,
    mediaFileId: clip.media_file_id,
    fileName: clip.asset_name,
    onChanged: onTracksChanged,
  })
  const [findingTrack, setFindingTrack] = React.useState(false)
  /** A clip does not name its track: the track that speaks most of it is it. */
  async function clipTrack(): Promise<number | null> {
    setFindingTrack(true)
    try {
      const r = rangeRef.current
      const t = await snippetApi.transcript(clip.media_file_id, r.start_ms, r.end_ms)
      const track = dominantTrack(t.segments, r)
      if (track == null) toast('Could not tell which track this clip is on. Open the clip and use Tracks.', 'error')
      return track
    } catch (err) {
      toast(errorMessage(err, 'Could not read the clip’s track.'), 'error')
      return null
    } finally {
      setFindingTrack(false)
    }
  }
  const [tracksOpen, setTracksOpen] = React.useState(false)
  const [focusTrack, setFocusTrack] = React.useState<number | null>(null)

  // ── Transcript (opened cards only) ───────────────────────────────────────
  const [win, setWin] = React.useState(() => transcriptWindow(range))
  React.useEffect(() => {
    if (range.start_ms < win.from || range.end_ms > win.to) setWin(transcriptWindow(range))
  }, [range, win])
  const transcriptSWR = useSWR<SnippetTranscript>(
    expanded ? snippetKeys.transcript(clip.media_file_id, win.from, win.to) : null,
    snippetFetcher,
    { keepPreviousData: true, shouldRetryOnError: false },
  )
  const words: SnippetTranscriptWord[] = React.useMemo(
    () =>
      (transcriptSWR.data?.segments ?? []).flatMap((s) => s.words).sort((a, b) => a.start_ms - b.start_ms),
    [transcriptSWR.data],
  )

  // ── Title ────────────────────────────────────────────────────────────────
  const [editingTitle, setEditingTitle] = React.useState(false)
  const titleBtnRef = React.useRef<HTMLButtonElement>(null)
  const wasEditing = React.useRef(false)
  React.useEffect(() => {
    if (wasEditing.current && !editingTitle) titleBtnRef.current?.focus()
    wasEditing.current = editingTitle
  }, [editingTitle])

  const heading = isMoment ? 'Transcript moment' : draft.title || 'Untitled clip'
  const lengthMs = range.end_ms - range.start_ms
  const atOriginal = range.start_ms === original.start_ms && range.end_ms === original.end_ms
  const elapsedMs = nowMs != null ? Math.max(0, Math.min(lengthMs, nowMs - range.start_ms)) : null

  const iconBtn =
    'flex h-7 w-7 hover-none:h-10 hover-none:w-10 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

  /** `iconOnly`: the phone layout's copy in the action row, where the in/out
   *  row has no room left for it. */
  const resetButton = (className?: string, iconOnly?: boolean) => (
    <button
      type="button"
      onClick={() => applyRange(original, 'both')}
      disabled={atOriginal}
      aria-label={iconOnly ? 'Reset in and out' : undefined}
      title="Back to the in/out this clip had when the page loaded"
      className={cn(
        'h-7 hover-none:h-9 items-center gap-1 rounded px-1.5 text-xs text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        className ?? 'inline-flex',
      )}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      {!iconOnly && 'Reset'}
    </button>
  )

  // One tree for both states, only the classes change: opening a card keeps
  // its player playing and an export in progress polling.
  return (
    <article
      data-clip-key={cardKey}
      tabIndex={-1}
      aria-label={heading}
      className={cn(
        'group/card relative min-w-0 rounded-xl border bg-bg-secondary transition-[border-color,opacity,box-shadow] focus:outline-none',
        active ? 'border-accent/50' : 'border-border hover:border-border-focus/60 focus-within:border-border-focus/60',
        draft.status === 'rejected' && !expanded && 'opacity-70',
        expanded && 'col-span-full shadow-lg',
      )}
    >
      <div
        className={cn(
          'grid min-w-0 gap-3 p-3 sm:p-4',
          expanded
            ? 'grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-x-5'
            : 'grid-cols-[6.5rem_minmax(0,1fr)] sm:grid-cols-[clamp(8.5rem,28%,14.5rem)_minmax(0,1fr)] sm:gap-x-4',
        )}
      >
        {/* Media: a portrait frame on the card (the 9:16 crop), the whole
            picture once opened. A poster until play is pressed. */}
        <div
          className={cn(
            'relative w-full self-start overflow-hidden rounded-lg bg-bg-tertiary',
            expanded ? 'aspect-video lg:col-start-1' : 'aspect-[9/16] sm:row-span-2',
          )}
        >
          {active && src ? (
            <ClipMedia
              ref={mediaRef}
              src={src}
              poster={poster}
              audioOnly={!clip.thumbnail_url}
              rangeRef={rangeRef}
              loopRef={loopRef}
              startAtMs={launch.at}
              autoPlay={launch.autoPlay}
              onState={setMedia}
              onPlaying={onPlaying}
              label={`${heading}, ${clip.asset_name}`}
              fit={expanded ? 'contain' : 'cover'}
            />
          ) : (
            <button
              type="button"
              onClick={() => activate({ autoPlay: true })}
              disabled={!src}
              aria-label={`Play ${heading} from ${clip.asset_name}`}
              className="group/play absolute inset-0 h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-default"
            >
              {poster ? (
                // eslint-disable-next-line @next/next/no-img-element -- media-proxy URLs, as AssetCard does
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  className={cn('h-full w-full', expanded ? 'object-contain' : 'object-cover')}
                />
              ) : (
                // Neutral audio tile: the play button stays centred like on video
                // cards, and the "audio" marker sits in the free top-left corner.
                <span className="block h-full w-full bg-gradient-to-br from-bg-tertiary to-bg-hover">
                  <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-2xs font-medium text-white">
                    <AudioLines className="h-3 w-3" aria-hidden />
                    Audio
                  </span>
                </span>
              )}
              {src && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover/play:bg-black/20">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white opacity-90 shadow-lg transition-transform group-hover/play:scale-105">
                    <Play className="h-4 w-4 translate-x-[1px]" fill="currentColor" aria-hidden />
                  </span>
                </span>
              )}
            </button>
          )}
          {!src && <NoMedia />}
          {active && src && !expanded && (
            <button
              type="button"
              onClick={() => setLoop((v) => !v)}
              aria-pressed={loop}
              aria-label="Loop between in and out"
              title="Loop between in and out"
              className={cn(
                'absolute bottom-1.5 left-1.5 z-10 flex h-7 w-7 hover-none:h-9 hover-none:w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                loop ? 'bg-accent text-white' : 'bg-black/60 text-white/80 hover:text-white',
              )}
            >
              <Repeat className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 rounded bg-black/65 px-1.5 py-0.5 font-mono text-2xs tabular-nums text-white">
            {elapsedMs != null ? `${formatDuration(elapsedMs)} / ${formatDuration(lengthMs)}` : formatDuration(lengthMs)}
          </span>
        </div>

        {/* Title, who and where, the quote, topics */}
        <div className={cn('min-w-0 space-y-2', expanded && 'lg:col-start-1')}>
          <div className="flex items-start gap-1">
            {editingTitle ? (
              <TitleInput
                initial={draft.title ?? ''}
                onCancel={() => setEditingTitle(false)}
                onSave={(t) => {
                  setEditingTitle(false)
                  if (t && t !== draft.title) {
                    change({ title: t })
                    void saver.flush()
                  }
                }}
              />
            ) : (
              <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug sm:text-base">
                <button
                  ref={titleBtnRef}
                  type="button"
                  onClick={() => onToggleExpand(cardKey)}
                  aria-expanded={expanded}
                  title={expanded ? 'Close the transcript' : 'Open with the transcript'}
                  className={cn(
                    'rounded text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    isMoment ? 'text-text-secondary' : 'text-text-primary',
                    !expanded && 'line-clamp-2',
                  )}
                >
                  {heading}
                </button>
              </h3>
            )}
            {editable && !editingTitle && (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                aria-label="Rename clip"
                title="Rename"
                className="flex h-6 w-6 hover-none:h-9 hover-none:w-9 shrink-0 items-center justify-center rounded text-text-tertiary opacity-60 transition-opacity hover:bg-bg-hover hover:text-text-primary hover:opacity-100 group-hover/card:opacity-100 hover-none:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {props.onHideSource && !editingTitle && (
              <ClipMenu
                assetName={clip.asset_name}
                onHideSource={() => latest.current.onHideSource?.(clip)}
                className="h-6 w-6 hover-none:h-9 hover-none:w-9 shrink-0 border-transparent"
              />
            )}
            {expanded && (
              <button
                type="button"
                onClick={() => onToggleExpand(cardKey)}
                aria-label="Close clip"
                title="Close"
                className="flex h-6 w-6 hover-none:h-9 hover-none:w-9 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Speaker · file · where the clip starts */}
          <div className="-mt-1.5 flex min-w-0 items-center gap-1 text-xs text-text-tertiary">
            {editable ? (
              <SpeakerSelect
                value={clip.speaker?.id ?? null}
                fallbackName={clip.speaker?.name ?? null}
                speakers={speakers}
                disabled={false}
                busy={assignApi.busyTrack != null || findingTrack}
                label={`Speaker of ${heading}: names the speaker of its track`}
                placeholder="Unknown speaker"
                onChange={async (id) => {
                  const track = await clipTrack()
                  if (track != null) await assignApi.assign(track, id)
                }}
                onAdd={async () => {
                  const track = await clipTrack()
                  if (track != null) assignApi.startAdd(track, `Track ${track + 1}`)
                }}
                className="-ml-1.5 h-6 hover-none:h-9 max-w-[55%] flex-none gap-1 border-transparent bg-transparent px-1.5 text-text-secondary hover:border-border lg:max-w-[55%]"
              />
            ) : (
              <span className="max-w-[55%] truncate text-text-secondary">{clip.speaker?.name ?? 'Unknown speaker'}</span>
            )}
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate" title={clip.asset_name}>
              {clip.asset_name}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0 font-mono tabular-nums">{formatClipTime(range.start_ms)}</span>
          </div>
          {assignApi.note && (
            <p className="-mt-1 text-2xs text-text-tertiary" role="status">
              {assignApi.note}
            </p>
          )}

          {clip.quote && !expanded && (
            <blockquote
              title={clip.quote}
              className="line-clamp-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-text-secondary sm:line-clamp-4 sm:text-sm"
            >
              &ldquo;{clip.quote}&rdquo;
            </blockquote>
          )}

          {(draft.topics.length > 0 || editable) && (
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Topics">
              {draft.topics.map((t) => {
                const on = activeTopics.some((a) => a.toLowerCase() === t.toLowerCase())
                return (
                  <li
                    key={t}
                    className={cn(
                      'group/chip inline-flex items-center rounded-full text-xs transition-colors',
                      on ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onTopic(t)}
                      aria-pressed={on}
                      title={on ? `Filtering by ${t}` : `Filter by ${t}`}
                      className="rounded-full px-2.5 py-1 hover-none:py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      {t}
                    </button>
                    {editable && (
                      <button
                        type="button"
                        onClick={() => change({ topics: removeTopic(draftRef.current.topics, t) })}
                        aria-label={`Remove topic ${t}`}
                        className="-ml-1.5 mr-1 rounded-full p-0.5 hover-none:p-1.5 opacity-0 transition-opacity hover:bg-bg-hover group-hover/chip:opacity-100 hover-none:opacity-70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                )
              })}
              {editable && (
                <li>
                  <TopicAdder
                    subtle={draft.topics.length > 0}
                    onAdd={(raw) => change({ topics: addTopic(draftRef.current.topics, raw) })}
                  />
                </li>
              )}
            </ul>
          )}

          {(clip.source || clip.quality_score != null || clip.viral_score != null || clip.user_edited || expanded) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {expanded && draft.status && <StatusPill status={draft.status} />}
              {clip.source && <SourceBadge source={clip.source} generator={clip.generator} />}
              <ScoreBadge label="Q" title="Quality" score={clip.quality_score} />
              <ScoreBadge label="V" title="Viral" score={clip.viral_score} />
              {clip.user_edited && <EditedPill />}
            </div>
          )}
        </div>

        {/* In/out, export, review */}
        <div
          className={cn(
            'min-w-0 space-y-2',
            expanded ? 'lg:col-start-1' : 'col-span-2 sm:col-span-1 sm:col-start-2 sm:self-end',
          )}
        >
          {expanded && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={togglePlay}
                disabled={!src}
                aria-label={playing ? 'Pause' : 'Play clip'}
                className={cn(iconBtn, 'border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary')}
              >
                {active && media?.loading && !playing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : playing ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setLoop((v) => !v)}
                aria-pressed={loop}
                aria-label="Loop between in and out"
                title="Loop between in and out"
                className={cn(
                  iconBtn,
                  loop ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-tertiary hover:text-text-primary',
                )}
              >
                <Repeat className="h-3.5 w-3.5" />
              </button>
              <span className="ml-1 min-w-0 truncate font-mono text-2xs tabular-nums text-text-secondary">
                {nowMs != null && <>{formatClipTime(nowMs)} · </>}
                {formatDuration(lengthMs)}
              </span>
              {editable && <span className="ml-auto">{resetButton()}</span>}
            </div>
          )}
          <InOutTimeline
            compact={!expanded}
            range={range}
            durationMs={durationMs}
            nowMs={nowMs}
            words={words}
            editable={editable}
            onChange={applyRange}
            onSeek={seekTo}
          />
          {editable ? (
            expanded ? (
              <div className="grid gap-1.5 xl:grid-cols-2">
                <EdgeEditor
                  label="In"
                  valueMs={range.start_ms}
                  onCommit={(ms) => applyRange(moveEdge(rangeRef.current, 'in', ms, durationMs), 'in')}
                  onNudge={(d) => nudge('in', d)}
                />
                <EdgeEditor
                  label="Out"
                  valueMs={range.end_ms}
                  onCommit={(ms) => applyRange(moveEdge(rangeRef.current, 'out', ms, durationMs), 'out')}
                  onNudge={(d) => nudge('out', d)}
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <EdgeEditor
                  variant="inline"
                  label="In"
                  valueMs={range.start_ms}
                  onCommit={(ms) => applyRange(moveEdge(rangeRef.current, 'in', ms, durationMs), 'in')}
                  onNudge={(d) => nudge('in', d)}
                />
                <EdgeEditor
                  variant="inline"
                  label="Out"
                  valueMs={range.end_ms}
                  onCommit={(ms) => applyRange(moveEdge(rangeRef.current, 'out', ms, durationMs), 'out')}
                  onNudge={(d) => nudge('out', d)}
                />
                {resetButton('hidden sm:inline-flex')}
              </div>
            )
          ) : (
            <p className="font-mono text-xs tabular-nums text-text-tertiary">
              In {formatClipTime(range.start_ms)} · Out {formatClipTime(range.end_ms)}
            </p>
          )}

          {isMoment && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-2xs text-text-tertiary">
                A transcript moment, not a saved clip. Save it as a clip to edit it.
              </p>
              <HintTooltip hint="Create clip: coming soon">
                <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled>
                  Create clip
                </Button>
              </HintTooltip>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {canEdit &&
              // Exports create files on the server, so they are an editor's
              // action; the server checks too. They render the in/out on the
              // card now (saved or not), and a moment exports its own range
              // under its "moment:..." id.
              (audioOnly ? (
                // The server answers an audio-only export with 422; saying
                // so here beats offering buttons that can only fail.
                <section aria-label="Export" className="flex items-center">
                  <p className="text-xs text-text-tertiary" data-testid="export-audio-note">
                    Export needs a video file.
                  </p>
                </section>
              ) : (
                <div className={cn('min-w-0', expanded && 'w-full')}>
                  <ClipExports
                    compact={!expanded}
                    snippetId={clip.id}
                    range={range}
                    valid={isValidClip(range, durationMs)}
                  />
                </div>
              ))}
            {editable && (
              <div className="ml-auto flex items-center gap-1.5">
                <SaveIndicator status={saveStatus} onRetry={() => void saver.flush()} />
                {!expanded && resetButton('inline-flex sm:hidden', true)}
                {draft.status && (
                  <>
                    <button
                      type="button"
                      onClick={() => change({ status: draft.status === 'approved' ? 'suggested' : 'approved' })}
                      aria-pressed={draft.status === 'approved'}
                      aria-label={draft.status === 'approved' ? 'Undo approve' : 'Approve'}
                      title={draft.status === 'approved' ? 'Undo approve' : 'Approve'}
                      className={cn(
                        iconBtn,
                        draft.status === 'approved'
                          ? 'border-status-success/40 bg-status-success/15 text-status-success'
                          : 'border-border text-text-tertiary hover:border-status-success/40 hover:text-status-success',
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => change({ status: draft.status === 'rejected' ? 'suggested' : 'rejected' })}
                      aria-pressed={draft.status === 'rejected'}
                      aria-label={draft.status === 'rejected' ? 'Undo reject' : 'Reject'}
                      title={draft.status === 'rejected' ? 'Undo reject' : 'Reject'}
                      className={cn(
                        iconBtn,
                        draft.status === 'rejected'
                          ? 'border-status-error/40 bg-status-error/15 text-status-error'
                          : 'border-border text-text-tertiary hover:border-status-error/40 hover:text-status-error',
                      )}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {expanded && (
          <aside
            aria-label="Transcript"
            className="flex min-h-0 flex-col rounded-lg border border-border bg-bg-primary/40 lg:relative lg:col-start-2 lg:row-span-3 lg:row-start-1"
          >
            <div className="flex max-h-[55vh] min-h-[220px] flex-col lg:absolute lg:inset-0 lg:max-h-none">
              <div className="flex items-center gap-2 px-3 pb-2 pt-3">
                <h4 className="text-2xs font-semibold uppercase tracking-wider text-text-tertiary">Transcript</h4>
                {canEdit && (
                  <div className="ml-auto">
                    <ClipTracksControl
                      mediaFileId={clip.media_file_id}
                      fileName={clip.asset_name}
                      speakers={speakers}
                      assignApi={assignApi}
                      open={tracksOpen}
                      onOpenChange={(o) => {
                        setTracksOpen(o)
                        if (!o) setFocusTrack(null)
                      }}
                      focusTrack={focusTrack}
                    />
                  </div>
                )}
              </div>
              <LiveTranscript
                transcript={transcriptSWR.data}
                loading={transcriptSWR.isLoading}
                error={transcriptSWR.error}
                onRetry={() => void transcriptSWR.mutate()}
                nowMs={nowMs}
                range={range}
                onSeek={seekTo}
                onSpeaker={
                  canEdit
                    ? (track) => {
                        setFocusTrack(track)
                        setTracksOpen(true)
                      }
                    : undefined
                }
              />
            </div>
          </aside>
        )}
      </div>
      {assignApi.dialog}
    </article>
  )
})

// ─── Small pieces ─────────────────────────────────────────────────────────────

/** Enter saves, Escape cancels, leaving the field saves. */
function TitleInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(initial)
  const done = React.useRef(false)
  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onSave(value.trim())
    else onCancel()
  }
  return (
    <input
      autoFocus
      value={value}
      maxLength={255}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      aria-label="Clip title"
      className="h-7 hover-none:h-10 min-w-0 flex-1 rounded-md border border-border-focus bg-bg-primary px-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-border-focus"
    />
  )
}

/** "+ Topic": Enter adds and stays open for the next one, Escape closes.
 *  `subtle`: shown only while the card is hovered or has focus (always on
 *  touch screens), so a card with topics reads like a plain chip row. */
function TopicAdder({ onAdd, subtle }: { onAdd: (raw: string) => void; subtle?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState('')
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-1 hover-none:py-2 text-xs text-text-tertiary transition-opacity hover:border-border-focus hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          subtle && 'opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 hover-none:opacity-100',
        )}
      >
        <Plus className="h-3 w-3" aria-hidden />
        Topic
      </button>
    )
  }
  return (
    <input
      autoFocus
      value={value}
      maxLength={64}
      placeholder="topic"
      aria-label="New topic"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim()) onAdd(value)
        setValue('')
        setOpen(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (value.trim()) {
            onAdd(value)
            setValue('')
          } else setOpen(false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setValue('')
          setOpen(false)
        }
      }}
      className="h-6 hover-none:h-9 w-24 rounded-full border border-border-focus bg-bg-primary px-2 text-2xs text-text-primary focus:outline-none"
    />
  )
}

/** "Saving…", then "Saved" for a moment; a failed save says so and offers Retry. */
function SaveIndicator({ status, onRetry }: { status: AutosaveStatus; onRetry: () => void }) {
  const [showSaved, setShowSaved] = React.useState(false)
  React.useEffect(() => {
    if (status.state !== 'saved') {
      setShowSaved(false)
      return
    }
    setShowSaved(true)
    const t = setTimeout(() => setShowSaved(false), 2500)
    return () => clearTimeout(t)
  }, [status])

  if (status.state === 'pending' || status.state === 'saving') {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-2xs text-text-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Saving…
      </span>
    )
  }
  if (status.state === 'error') {
    return (
      <span role="alert" className="inline-flex flex-wrap items-center gap-1 text-2xs text-status-error">
        Not saved: {errorMessage(status.error, 'the server refused the change.')}
        <button
          type="button"
          onClick={onRetry}
          className="rounded font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Retry
        </button>
      </span>
    )
  }
  if (showSaved) {
    return (
      <span role="status" className="inline-flex items-center gap-1 text-2xs text-text-tertiary">
        <Check className="h-3 w-3" aria-hidden />
        Saved
      </span>
    )
  }
  return null
}
