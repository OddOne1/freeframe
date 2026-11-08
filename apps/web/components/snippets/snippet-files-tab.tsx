'use client'

/**
 * SocialSnippet's Files tab: which of the project's files it knows about, how
 * far each one is, which speaker is on which track, and starting processing.
 *
 * Shown to editors and up (GET /snippet/files is editor-only). Naming a
 * speaker is an editor's; processing (Process selected, Reprocess, Retry) is
 * the owner's, as POST /snippet/process is. The UI hides what the server would
 * refuse; the server still decides.
 *
 * One tree for every width: below `lg` each file is a card, from `lg` up the
 * same elements line up as a table under a header row.
 *
 * While any listed file is queued or running the list is re-read every 5 s
 * (POLL_INTERVAL_MS), and polling stops by itself once none is.
 */
import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import { AlertTriangle, Check, ChevronDown, FileX2, Film, Music, Plus, RotateCcw, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { errorMessage, snippetApi, snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import {
  MAX_PROCESS_BATCH,
  POLL_INTERVAL_MS,
  SERVER_CPU_SPEED_FACTOR,
  anyActive,
  canSelect,
  detectSummaryText,
  estimateProcessing,
  formatEstimate,
  formatLength,
  RETRY_FORCES,
  statusLabel,
  tracksToTranscribe,
  type StatusTone,
} from '@/lib/snippet-files'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/skeleton'
import { useOptionalToast } from '@/components/shared/toast'
import type { SnippetFile, SnippetFilesResponse, SnippetProcessResponse, SnippetSpeaker } from '@/types'

const PAGE_SIZE = 50

/** The table's columns from `lg` up; the header row and every row share it. */
const COLUMNS =
  'lg:grid lg:grid-cols-[1.75rem_minmax(0,2fr)_minmax(0,1fr)_8.5rem_4.5rem_3.5rem_minmax(0,2.4fr)_6.5rem] lg:items-center lg:gap-3'

const TONE: Record<StatusTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  info: 'bg-status-info/10 text-status-info',
  success: 'bg-status-success/10 text-status-success',
  warning: 'bg-status-warning/10 text-status-warning',
  error: 'bg-status-error/10 text-status-error',
}
const DOT: Record<StatusTone, string> = {
  neutral: 'bg-text-tertiary',
  info: 'bg-status-info',
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
}

/** What the confirm dialog is about to do. */
type Pending =
  | { kind: 'batch'; files: SnippetFile[] }
  | { kind: 'reprocess'; file: SnippetFile }
  | { kind: 'retry'; file: SnippetFile }

export function SnippetFilesTab({
  projectId,
  canManage,
}: {
  projectId: string
  /** Owner or superadmin: may process. Editors see and name speakers only. */
  canManage: boolean
}) {
  const toast = useOptionalToast()
  const [text, setText] = React.useState('')
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(1)
  React.useEffect(() => {
    const t = setTimeout(() => {
      setQ(text.trim())
      setPage(1)
    }, 400)
    return () => clearTimeout(t)
  }, [text])

  const list = useSWR<SnippetFilesResponse>(
    snippetKeys.files(projectId, { q, page, page_size: PAGE_SIZE }),
    snippetFetcher,
    {
      keepPreviousData: true,
      shouldRetryOnError: false,
      refreshInterval: (latest) => (anyActive(latest?.items) ? POLL_INTERVAL_MS : 0),
    },
  )
  const { data: speakers, mutate: mutateSpeakers } = useSWR<SnippetSpeaker[]>(
    snippetKeys.speakers(projectId),
    snippetFetcher,
  )

  const items = React.useMemo(() => list.data?.items ?? [], [list.data])
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const polling = anyActive(items)

  // ── Selection (ids, so it survives the 5 s refresh) ──────────────────────
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const selectable = items.filter(canSelect)
  // Drop ids that stopped being selectable (started running, gone from the page).
  React.useEffect(() => {
    setSelected((cur) => {
      const ok = new Set(items.filter(canSelect).map((f) => f.asset_id))
      const next = new Set(Array.from(cur).filter((id) => ok.has(id)))
      return next.size === cur.size ? cur : next
    })
  }, [items])
  const full = selected.size >= MAX_PROCESS_BATCH
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_PROCESS_BATCH) next.add(id)
      return next
    })
  const allOnPage = selectable.length > 0 && selectable.every((f) => selected.has(f.asset_id))
  const toggleAll = () =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (allOnPage) {
        for (const f of selectable) next.delete(f.asset_id)
        return next
      }
      for (const f of selectable) {
        if (next.size >= MAX_PROCESS_BATCH) break
        next.add(f.asset_id)
      }
      return next
    })

  // ── Processing ───────────────────────────────────────────────────────────
  const [pending, setPending] = React.useState<Pending | null>(null)
  // The dialog's words stay put while it animates closed.
  const lastPending = React.useRef<Pending | null>(null)
  if (pending) lastPending.current = pending

  function report(res: SnippetProcessResponse, names: Record<string, string>) {
    const skipped = res.results.filter((r) => !r.queued)
    if (res.queued > 0) {
      toast(`${res.queued} ${res.queued === 1 ? 'file' : 'files'} queued.`, 'success')
    }
    if (skipped.length > 0) {
      const first = skipped[0]
      const more = skipped.length > 1 ? ` (and ${skipped.length - 1} more)` : ''
      toast(
        `Not queued: ${names[first.asset_id] ?? 'a file'}: ${first.reason}${more}.`,
        res.queued ? 'info' : 'error',
      )
    }
  }

  async function runPending() {
    if (!pending) return
    const targets = pending.kind === 'batch' ? pending.files : [pending.file]
    // Reprocess starts from scratch; Retry and a batch resume (RETRY_FORCES).
    const force = pending.kind === 'reprocess' ? true : pending.kind === 'retry' ? RETRY_FORCES : false
    const names = Object.fromEntries(targets.map((f) => [f.asset_id, f.name]))
    try {
      const res = await snippetApi.process(projectId, targets.map((f) => f.asset_id), force)
      report(res, names)
      if (pending.kind === 'batch') setSelected(new Set())
      await list.mutate()
    } catch (err) {
      toast(errorMessage(err, 'Could not start processing.'), 'error')
      throw err
    }
  }

  // ── Speakers ─────────────────────────────────────────────────────────────
  const [busyTrack, setBusyTrack] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<{ file: SnippetFile; track: number } | null>(null)

  async function assign(file: SnippetFile, trackIndex: number, speakerId: string) {
    if (!file.media_file_id) return
    setBusyTrack(`${file.media_file_id}:${trackIndex}`)
    try {
      const res = await snippetApi.setTrackSpeaker(file.media_file_id, trackIndex, speakerId)
      const detectFailed = res.detect_summary?.reason?.startsWith('Clip detection failed') ?? false
      toast(detectSummaryText(res.detect_summary), detectFailed ? 'error' : 'success')
      await list.mutate()
    } catch (err) {
      toast(errorMessage(err, 'Could not save the speaker.'), 'error')
    } finally {
      setBusyTrack(null)
    }
  }

  async function addSpeaker(name: string) {
    if (!adding) return
    const speaker = await snippetApi.createSpeaker(projectId, name)
    await mutateSpeakers(
      (cur) => (cur?.some((s) => s.id === speaker.id) ? cur : [...(cur ?? []), speaker]),
      { revalidate: false },
    )
    await assign(adding.file, adding.track, speaker.id)
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const selectedFiles = items.filter((f) => selected.has(f.asset_id))
  const confirm = confirmCopy(pending ?? lastPending.current)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block sm:w-72">
          <span className="sr-only">Search files</span>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setQ(text.trim())
                setPage(1)
              }
            }}
            placeholder="Search file names"
            className="h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-secondary pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus"
          />
        </label>
        {canManage && (
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <span className="text-xs text-text-tertiary tabular-nums" aria-live="polite">
              {selected.size > 0 ? `${selected.size} selected` : `Select up to ${MAX_PROCESS_BATCH}`}
              {full && ' (the most per batch)'}
            </span>
            <Button
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setPending({ kind: 'batch', files: selectedFiles })}
            >
              Process selected{selected.size > 0 ? ` (${selected.size})` : ''}
            </Button>
          </div>
        )}
      </div>

      {polling && (
        <p className="text-xs text-text-tertiary" role="status">
          Processing in progress. This list refreshes every {POLL_INTERVAL_MS / 1000} s.
        </p>
      )}

      {!list.data && !list.error ? (
        <FilesSkeleton />
      ) : list.error && !list.data ? (
        <EmptyState
          icon={FileX2}
          title="Could not load the files"
          description={errorMessage(list.error)}
          action={{ label: 'Retry', onClick: () => void list.mutate() }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileX2}
          title={q ? 'No files match' : 'No video or audio files yet'}
          description={
            q ? 'Try another part of the name.' : 'Files in the source folder chosen in the settings show up here.'
          }
          action={q ? { label: 'Clear search', onClick: () => setText('') } : undefined}
        />
      ) : (
        <div role="table" aria-label="Files" className="rounded-lg border border-border bg-bg-secondary">
          <div role="rowgroup" className="hidden lg:block">
            <div
              role="row"
              className={cn(
                COLUMNS,
                'border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-text-tertiary',
              )}
            >
              <span role="columnheader">
                {canManage && (
                  <input
                    type="checkbox"
                    aria-label="Select all ready files on this page"
                    checked={allOnPage}
                    disabled={selectable.length === 0}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                )}
              </span>
              <span role="columnheader">Name</span>
              <span role="columnheader">Folder</span>
              <span role="columnheader">Status</span>
              <span role="columnheader" className="text-right">
                Segments
              </span>
              <span role="columnheader" className="text-right">
                Clips
              </span>
              <span role="columnheader">Speakers per track</span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
          </div>
          <div role="rowgroup" className="divide-y divide-border">
            {items.map((f) => (
              <FileRow
                key={f.asset_id}
                file={f}
                canManage={canManage}
                selected={selected.has(f.asset_id)}
                selectDisabled={!canSelect(f) || (full && !selected.has(f.asset_id))}
                onToggle={() => toggle(f.asset_id)}
                speakers={speakers ?? []}
                busyTrack={busyTrack}
                onAssign={(track, speakerId) => void assign(f, track, speakerId)}
                onAddSpeaker={(track) => setAdding({ file: f, track })}
                onReprocess={() => setPending({ kind: 'reprocess', file: f })}
                onRetry={() => setPending({ kind: 'retry', file: f })}
              />
            ))}
          </div>
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 text-xs text-text-tertiary">
          <span className="tabular-nums">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={confirm.title}
        description={confirm.body}
        confirmLabel={confirm.action}
        onConfirm={runPending}
      />
      <AddSpeakerDialog
        target={adding}
        onOpenChange={(open) => {
          if (!open) setAdding(null)
        }}
        onAdd={addSpeaker}
      />
    </div>
  )
}

/** The confirm dialog's words for each action. */
function confirmCopy(p: Pending | null): { title: string; body: React.ReactNode; action: string } {
  if (!p) return { title: '', body: null, action: 'Confirm' }
  const files = p.kind === 'batch' ? p.files : [p.file]
  const force = p.kind === 'reprocess'
  const est = formatEstimate(
    estimateProcessing(files.map((f) => ({ durationMs: f.duration_ms, tracks: tracksToTranscribe(f, force) }))),
  )
  const body = (
    <span className="block space-y-2">
      <span className="block">
        Estimate: <strong className="font-medium text-text-primary">{est}</strong>
        {` (file length × audio tracks still to transcribe ÷ ${SERVER_CPU_SPEED_FACTOR}; the real time depends on the server).`}
      </span>
      <span className="flex gap-2 text-status-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          Long files occupy the server: it transcribes one file at a time, and other transcriptions wait behind
          them.
        </span>
      </span>
      {p.kind === 'batch' && (
        <span className="block">
          Files with a finished transcript are skipped; use Reprocess for those. A file that failed or stopped
          continues where it stopped.
        </span>
      )}
      {p.kind === 'retry' && (
        <span className="block">
          It continues where it stopped: tracks already transcribed, or found to have no speech, are kept, and
          only what is missing is redone.
        </span>
      )}
      {p.kind === 'reprocess' && (
        <span className="block">
          The transcript is made again from scratch, every track included. Approved, edited and hand-made clips
          stay; untouched auto suggestions are replaced.
        </span>
      )}
    </span>
  )
  if (p.kind === 'batch') {
    const n = p.files.length
    return { title: `Process ${n} ${n === 1 ? 'file' : 'files'}?`, body, action: 'Process' }
  }
  if (p.kind === 'reprocess') return { title: `Reprocess ${p.file.name}?`, body, action: 'Reprocess' }
  return { title: `Retry ${p.file.name}?`, body, action: 'Retry' }
}

function FileRow({
  file: f,
  canManage,
  selected,
  selectDisabled,
  onToggle,
  speakers,
  busyTrack,
  onAssign,
  onAddSpeaker,
  onReprocess,
  onRetry,
}: {
  file: SnippetFile
  canManage: boolean
  selected: boolean
  selectDisabled: boolean
  onToggle: () => void
  speakers: SnippetSpeaker[]
  busyTrack: string | null
  onAssign: (track: number, speakerId: string) => void
  onAddSpeaker: (track: number) => void
  onReprocess: () => void
  onRetry: () => void
}) {
  const status = statusLabel(f)
  const notReady = f.not_ready_reason != null
  const Icon = f.kind === 'audio' ? Music : Film
  const meta = [f.duration_ms != null ? formatLength(f.duration_ms) : null, f.kind === 'audio' ? 'Audio' : 'Video']
    .filter(Boolean)
    .join(' · ')
  const indent = canManage && 'pl-7 lg:pl-0'

  return (
    <div
      role="row"
      aria-disabled={notReady || undefined}
      className={cn(COLUMNS, 'relative flex flex-col gap-2 px-3 py-3', notReady && 'bg-bg-primary/40')}
    >
      {/* Checkbox */}
      <span role="cell" className="absolute left-3 top-3.5 lg:static">
        {canManage && (
          <input
            type="checkbox"
            aria-label={`Select ${f.name}`}
            title={notReady ? `Not ready: ${f.not_ready_reason}` : undefined}
            checked={selected}
            disabled={selectDisabled}
            onChange={onToggle}
            className="h-4 w-4 lg:h-3.5 lg:w-3.5 accent-[var(--accent)] disabled:opacity-40"
          />
        )}
      </span>

      {/* Name */}
      <span role="cell" className={cn('min-w-0', indent)}>
        <span className="flex min-w-0 items-center gap-2">
          <Icon className={cn('h-4 w-4 shrink-0 text-text-tertiary', notReady && 'opacity-50')} aria-hidden />
          <span
            className={cn('truncate text-sm font-medium', notReady ? 'text-text-tertiary' : 'text-text-primary')}
            title={f.name}
          >
            {f.name}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-tertiary">
          <span className="lg:hidden">{f.folder_path} · </span>
          {meta}
        </span>
      </span>

      {/* Folder */}
      <span role="cell" className="hidden truncate text-xs text-text-secondary lg:block" title={f.folder_path}>
        {f.folder_path}
      </span>

      {/* Status */}
      <span role="cell" className={cn('flex flex-wrap items-center gap-2', indent)}>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium',
            TONE[status.tone],
          )}
        >
          <span
            className={cn('h-1.5 w-1.5 rounded-full', DOT[status.tone], f.snippet_status === 'running' && 'animate-pulse')}
          />
          {status.label}
        </span>
        <span className="text-xs text-text-tertiary tabular-nums lg:hidden">
          {f.segment_count} segments · {f.snippet_count} clips
        </span>
      </span>

      {/* Counts */}
      <span role="cell" className="hidden text-right text-xs text-text-secondary tabular-nums lg:block">
        {f.segment_count}
      </span>
      <span role="cell" className="hidden text-right text-xs text-text-secondary tabular-nums lg:block">
        {f.snippet_count}
      </span>

      {/* Tracks */}
      <span role="cell" className={cn('min-w-0 space-y-1.5', indent)}>
        {f.tracks.length === 0 ? (
          <span className="text-xs text-text-tertiary">No audio tracks known yet</span>
        ) : (
          f.tracks.map((t) => (
            <span key={t.track_index} className="flex min-w-0 items-center gap-2">
              <span className="w-24 shrink-0 truncate text-xs text-text-tertiary lg:w-28" title={t.label}>
                {t.label}
              </span>
              <SpeakerSelect
                value={t.speaker_id}
                fallbackName={t.speaker_name}
                speakers={speakers}
                disabled={notReady || !f.media_file_id}
                busy={busyTrack === `${f.media_file_id}:${t.track_index}`}
                label={`Speaker on ${t.label}, ${f.name}`}
                onChange={(id) => onAssign(t.track_index, id)}
                onAdd={() => onAddSpeaker(t.track_index)}
              />
            </span>
          ))
        )}
      </span>

      {/* Actions */}
      <span role="cell" className={cn('flex items-center gap-2 empty:hidden lg:justify-end', indent)}>
        {canManage && !notReady && f.snippet_status === 'failed' && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        )}
        {canManage && !notReady && f.snippet_status === 'done' && (
          <Button variant="ghost" size="sm" onClick={onReprocess}>
            Reprocess
          </Button>
        )}
      </span>

      {/* Why it failed, or why it cannot be processed yet: under the row. */}
      {(f.error || notReady) && (
        <p
          className={cn(
            'text-xs lg:col-span-6 lg:col-start-2',
            indent,
            notReady
              ? 'text-text-tertiary'
              : f.snippet_status === 'failed'
                ? 'text-status-error'
                : 'text-status-warning',
          )}
        >
          {notReady ? `Not ready: ${f.not_ready_reason}.` : f.error}
        </p>
      )}
    </div>
  )
}

/** Radix Select reserves "" (it shows the placeholder), so "add" gets a sentinel. */
const ADD_NEW = '__add_new_speaker__'

function SpeakerSelect({
  value,
  fallbackName,
  speakers,
  disabled,
  busy,
  label,
  onChange,
  onAdd,
}: {
  value: string | null
  /** The name the list row carries, for a speaker the roster has not loaded yet. */
  fallbackName: string | null
  speakers: SnippetSpeaker[]
  disabled: boolean
  busy: boolean
  label: string
  onChange: (speakerId: string) => void
  onAdd: () => void
}) {
  const options =
    value && !speakers.some((s) => s.id === value)
      ? [{ id: value, name: fallbackName ?? 'Unknown' }, ...speakers]
      : speakers
  return (
    <Select.Root
      value={value ?? ''}
      disabled={disabled || busy}
      onValueChange={(v) => {
        if (v === ADD_NEW) onAdd()
        else if (v && v !== value) onChange(v)
      }}
    >
      <Select.Trigger
        aria-label={label}
        aria-busy={busy || undefined}
        className="inline-flex h-8 hover-none:h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border bg-bg-primary px-2.5 text-xs text-text-primary transition-colors hover:bg-bg-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50 lg:max-w-[12rem]"
      >
        <span className={cn('truncate', !value && 'text-text-tertiary')}>
          <Select.Value placeholder="Name speaker…" />
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[60] min-w-[12rem] max-h-[60vh] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl"
        >
          <Select.Viewport className="p-1">
            {options.map((s) => (
              <Select.Item
                key={s.id}
                value={s.id}
                className="relative flex cursor-pointer items-center gap-2 rounded-sm px-7 py-1.5 hover-none:py-2.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </Select.ItemIndicator>
                <Select.ItemText>{s.name}</Select.ItemText>
              </Select.Item>
            ))}
            {options.length > 0 && <Select.Separator className="my-1 h-px bg-border" />}
            <Select.Item
              value={ADD_NEW}
              className="relative flex cursor-pointer items-center gap-2 rounded-sm px-7 py-1.5 hover-none:py-2.5 text-sm text-accent outline-none data-[highlighted]:bg-bg-hover"
            >
              <Plus className="absolute left-2 h-3.5 w-3.5" aria-hidden />
              <Select.ItemText>Add new speaker…</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

function AddSpeakerDialog({
  target,
  onOpenChange,
  onAdd,
}: {
  target: { file: SnippetFile; track: number } | null
  onOpenChange: (open: boolean) => void
  onAdd: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (target) {
      setName('')
      setError(null)
    }
  }, [target])
  const trackLabel = target?.file.tracks.find((t) => t.track_index === target.track)?.label

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Enter a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onAdd(name.trim())
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err, 'Could not add the speaker.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold text-text-primary">Add a speaker</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1.5 text-sm text-text-tertiary">
            Added to this project&apos;s speakers and put on {trackLabel ?? 'the track'} of {target?.file.name}.
          </Dialog.Description>
          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-text-secondary">Name</span>
              <input
                autoFocus
                value={name}
                maxLength={255}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-status-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                Add and assign
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function FilesSkeleton() {
  return (
    <div
      className="space-y-px overflow-hidden rounded-lg border border-border"
      aria-busy="true"
      aria-label="Loading files"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 bg-bg-secondary px-3 py-3">
          <Skeleton className="h-4 w-4" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  )
}
