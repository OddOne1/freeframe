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
 * The whole list is read (100 a page, at most FILES_LOAD_LIMIT files), so the
 * filter chips, their counts, sorting and the folder groups work on every
 * file, not one page. The search box matches the name and the folder path
 * here; when the project has more files than were read, it also asks the
 * server (`q`, which matches names) so a name past the limit is still found.
 * Search, chip, sort and grouping live in the URL (lib/snippet-files.ts,
 * FILES_VIEW_KEYS), so a reload or a shared link shows the same view.
 *
 * One tree for every width: below `lg` each file is a card, from `lg` up the
 * same elements line up as a table under a header row. There the headers
 * sort (the same `files_sort` as the dropdown) and their borders drag to
 * resize; widths, and whether long names wrap, are this viewer's own and kept
 * in localStorage when it is available.
 *
 * While any listed file is queued or running the list is re-read every 5 s
 * (POLL_INTERVAL_MS), and polling stops by itself once none is.
 */
import * as React from 'react'
import useSWR from 'swr'
import { usePathname, useSearchParams } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  FileX2,
  Film,
  FolderClosed,
  Music,
  Plus,
  RotateCcw,
  Search,
  WrapText,
  X,
} from 'lucide-react'
import { cn, formatRelativeTime } from '@/lib/utils'
import { errorMessage, snippetApi, snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import {
  DEFAULT_COLUMN_WIDTHS,
  FILE_COLUMNS,
  FILE_FILTERS,
  FILE_SORTS,
  MAX_COLUMN_WIDTH,
  ariaSortOf,
  clampColumnWidth,
  columnTemplate,
  needsSpeaker,
  sanitizeColumnWidths,
  tableMinWidth,
  toggleSort,
  trackNeedsSpeaker,
  type ColumnWidths,
  type FileColumn,
  type FileColumnKey,
  type FileSort,
  type FileSortKey,
  FILES_LOAD_LIMIT,
  MAX_PROCESS_BATCH,
  POLL_INTERVAL_MS,
  SERVER_CPU_SPEED_FACTOR,
  anyActive,
  canSelect,
  detectSummaryText,
  estimateProcessing,
  fetchAllFiles,
  filterCounts,
  folderLabel,
  formatEstimate,
  formatLength,
  groupByFolder,
  matchesFilter,
  matchesSearch,
  readFilesView,
  RETRY_FORCES,
  selectAllTargets,
  sortFiles,
  statusLabel,
  summaryText,
  trackHasSpeech,
  trackName,
  tracksToTranscribe,
  writeFilesView,
  type FilesView,
  type StatusTone,
} from '@/lib/snippet-files'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/skeleton'
import { useOptionalToast } from '@/components/shared/toast'
import { Chip, SnippetSelect } from '@/components/snippets/snippet-ui'
import type { SnippetFile, SnippetFilesResponse, SnippetProcessResponse, SnippetSpeaker } from '@/types'

/** How long the search box waits after the last key before it applies. */
const SEARCH_DEBOUNCE_MS = 250

/** The table's columns from `lg` up; the header row and every row share the
 *  template the table sets in --files-cols (columnTemplate). */
const COLUMNS = 'lg:grid lg:[grid-template-columns:var(--files-cols)] lg:items-center lg:gap-2'

/** Per-viewer conveniences in localStorage; the tab works without them. */
const WIDTHS_KEY = 'ff.snippet-files.column-widths.v1'
const WRAP_KEY = 'ff.snippet-files.wrap-names.v1'

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Private mode, blocked storage, quota: the setting lasts for this visit.
  }
}

/** Column widths: read after mount (no server/client mismatch), written a
 *  moment after the last change; defaults are not stored. */
function useColumnWidths() {
  const [widths, setWidths] = React.useState<ColumnWidths>(DEFAULT_COLUMN_WIDTHS)
  const loaded = React.useRef(false)
  React.useEffect(() => {
    const raw = readStored(WIDTHS_KEY)
    if (raw) {
      try {
        setWidths(sanitizeColumnWidths(JSON.parse(raw)))
      } catch {
        // Unreadable: keep the defaults.
      }
    }
    loaded.current = true
  }, [])
  React.useEffect(() => {
    if (!loaded.current) return
    const t = setTimeout(() => {
      const isDefault = FILE_COLUMNS.every((c) => widths[c.key] === DEFAULT_COLUMN_WIDTHS[c.key])
      writeStored(WIDTHS_KEY, isDefault ? null : JSON.stringify(widths))
    }, 200)
    return () => clearTimeout(t)
  }, [widths])
  const setWidth = React.useCallback(
    (key: FileColumnKey, px: number) =>
      setWidths((cur) => {
        const next = clampColumnWidth(key, px)
        return cur[key] === next ? cur : { ...cur, [key]: next }
      }),
    [],
  )
  const reset = React.useCallback(
    (key?: FileColumnKey) =>
      setWidths((cur) => (key ? { ...cur, [key]: DEFAULT_COLUMN_WIDTHS[key] } : { ...DEFAULT_COLUMN_WIDTHS })),
    [],
  )
  const isDefault = FILE_COLUMNS.every((c) => widths[c.key] === DEFAULT_COLUMN_WIDTHS[c.key])
  return { widths, setWidth, reset, isDefault }
}

/** Whether long names wrap onto two lines (the default) or stay on one. */
function useWrapNames(): [boolean, (on: boolean) => void] {
  const [wrap, setWrap] = React.useState(true)
  React.useEffect(() => {
    if (readStored(WRAP_KEY) === '0') setWrap(false)
  }, [])
  const update = React.useCallback((on: boolean) => {
    setWrap(on)
    writeStored(WRAP_KEY, on ? null : '0')
  }, [])
  return [wrap, update]
}

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

/**
 * The view (search, chip, sort, grouping), read from and written to the URL.
 * Written with history.replaceState, which Next (14.1+) feeds back into
 * useSearchParams: no soft navigation per keystroke, and the page title that
 * a router navigation would reset to the layout's stays.
 */
function useFilesView(): [FilesView, (patch: Partial<FilesView>) => void] {
  const pathname = usePathname()
  const params = useSearchParams()
  const view = React.useMemo(() => readFilesView(params), [params])
  const update = React.useCallback(
    (patch: Partial<FilesView>) => {
      const qs = writeFilesView(params, { ...view, ...patch }).toString()
      // `null`, not history.state: Next's own marker in that state makes its
      // patched replaceState skip the router update. Next copies its state over.
      window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname)
    },
    [params, view, pathname],
  )
  return [view, update]
}

/** Every file of the project (or every name match for `q`), polled while any is busy. */
function useAllFiles(projectId: string, q: string | null) {
  return useSWR<SnippetFilesResponse>(
    q === null ? null : ['snippet/files/all', projectId, q],
    () =>
      fetchAllFiles((page, page_size) => snippetApi.listFiles(projectId, { q: q || undefined, page, page_size })),
    {
      keepPreviousData: true,
      shouldRetryOnError: false,
      refreshInterval: (latest) => (anyActive(latest?.items) ? POLL_INTERVAL_MS : 0),
    },
  )
}

export function SnippetFilesTab({
  projectId,
  canManage,
}: {
  projectId: string
  /** Owner or superadmin: may process. Editors see and name speakers only. */
  canManage: boolean
}) {
  const toast = useOptionalToast()
  const [view, setView] = useFilesView()
  const columns = useColumnWidths()
  const [wrapNames, setWrapNames] = useWrapNames()

  // ── Search box: typed text, applied to the URL after a pause ─────────────
  const [text, setText] = React.useState(view.q)
  const applied = React.useRef(view.q)
  React.useEffect(() => {
    // Back/forward or a pasted link changed the URL: show its search.
    if (view.q !== applied.current) {
      applied.current = view.q
      setText(view.q)
    }
  }, [view.q])
  React.useEffect(() => {
    const next = text.trim()
    if (next === applied.current) return
    const t = setTimeout(() => {
      applied.current = next
      setView({ q: next })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text, setView])
  const q = view.q

  // ── Data ─────────────────────────────────────────────────────────────────
  const list = useAllFiles(projectId, '')
  const truncated = list.data != null && list.data.items.length < list.data.total
  // Past the load limit the server's name search reaches the files not read.
  const byName = useAllFiles(projectId, truncated && q ? q : null)
  const { data: speakers, mutate: mutateSpeakers } = useSWR<SnippetSpeaker[]>(
    snippetKeys.speakers(projectId),
    snippetFetcher,
  )
  const { mutate: mutateList } = list
  const { mutate: mutateByName } = byName
  const refresh = React.useCallback(
    () => Promise.all([mutateList(), mutateByName()]),
    [mutateList, mutateByName],
  )

  const all = React.useMemo(() => list.data?.items ?? [], [list.data])
  const total = list.data?.total ?? 0
  const pool = React.useMemo(() => {
    const extra = byName.data?.items ?? []
    if (extra.length === 0) return all
    const ids = new Set(all.map((f) => f.asset_id))
    return [...all, ...extra.filter((f) => !ids.has(f.asset_id))]
  }, [all, byName.data])
  const searched = React.useMemo(() => pool.filter((f) => matchesSearch(f, q)), [pool, q])
  const counts = React.useMemo(() => filterCounts(searched), [searched])
  const shown = React.useMemo(
    () => sortFiles(searched.filter((f) => matchesFilter(f, view.filter)), view.sort),
    [searched, view.filter, view.sort],
  )
  const groups = React.useMemo(() => (view.grouped ? groupByFolder(shown) : null), [shown, view.grouped])
  /** The rows in the order they are on screen (collapsed groups included). */
  const ordered = React.useMemo(() => (groups ? groups.flatMap((g) => g.files) : shown), [groups, shown])
  const polling = anyActive(pool)
  const filtering = q !== '' || view.filter !== 'all'

  // ── Folder groups: collapsed ones, for this visit only ───────────────────
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set())
  const toggleGroup = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // ── Selection (ids, so it survives the 5 s refresh) ──────────────────────
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  /** The last "select all" that hit the per-request limit, while it stands. */
  const [clip, setClip] = React.useState<{ ids: string[]; eligible: number } | null>(null)
  // Drop ids that stopped being selectable (started running, gone from the list).
  React.useEffect(() => {
    setSelected((cur) => {
      const ok = new Set(pool.filter(canSelect).map((f) => f.asset_id))
      const next = new Set(Array.from(cur).filter((id) => ok.has(id)))
      return next.size === cur.size ? cur : next
    })
  }, [pool])
  const full = selected.size >= MAX_PROCESS_BATCH
  const toggle = (id: string) => {
    setClip(null)
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_PROCESS_BATCH) next.add(id)
      return next
    })
  }
  const targets = React.useMemo(() => selectAllTargets(ordered), [ordered])
  const allShownSelected = targets.ids.length > 0 && targets.ids.every((id) => selected.has(id))
  const someShownSelected = !allShownSelected && targets.ids.some((id) => selected.has(id))
  const toggleAll = () => {
    if (allShownSelected) {
      const shownIds = new Set(ordered.map((f) => f.asset_id))
      setSelected((cur) => new Set(Array.from(cur).filter((id) => !shownIds.has(id))))
      setClip(null)
      return
    }
    setSelected(new Set(targets.ids))
    setClip(targets.clipped > 0 ? { ids: targets.ids, eligible: targets.eligible } : null)
  }
  const clipStands =
    clip != null && clip.ids.length === selected.size && clip.ids.every((id) => selected.has(id))
  const hiddenSelected = React.useMemo(() => {
    const shownIds = new Set(shown.map((f) => f.asset_id))
    return Array.from(selected).filter((id) => !shownIds.has(id)).length
  }, [selected, shown])

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
      if (pending.kind === 'batch') {
        setSelected(new Set())
        setClip(null)
      }
      await refresh()
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
      await refresh()
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
  const selectedFiles = pool.filter((f) => selected.has(f.asset_id))
  const confirm = confirmCopy(pending ?? lastPending.current)
  const clearView = () => {
    setText('')
    applied.current = ''
    setView({ q: '', filter: 'all' })
  }
  const row = (f: SnippetFile) => (
    <FileRow
      key={f.asset_id}
      file={f}
      canManage={canManage}
      wrapName={wrapNames}
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
  )

  return (
    <div className="space-y-4">
      {/* Search, sort, grouping */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block min-w-0 sm:w-72">
          <span className="sr-only">Search file names and folders</span>
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
                applied.current = text.trim()
                setView({ q: text.trim() })
              }
            }}
            maxLength={200}
            placeholder="Search names and folders"
            className="h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-secondary pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus"
          />
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SnippetSelect
            label="Sort"
            value={view.sort}
            onChange={(sort) => setView({ sort })}
            options={FILE_SORTS}
            className="min-w-0 max-w-full"
          />
          <Chip active={view.grouped} onClick={() => setView({ grouped: !view.grouped })}>
            <FolderClosed className="h-3.5 w-3.5" aria-hidden />
            Group by folder
          </Chip>
          <Chip active={wrapNames} onClick={() => setWrapNames(!wrapNames)} title="Long names on up to two lines">
            <WrapText className="h-3.5 w-3.5" aria-hidden />
            Wrap names
          </Chip>
          <button
            type="button"
            onClick={() => columns.reset()}
            disabled={columns.isDefault}
            className="hidden rounded px-1 text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:hover:text-text-tertiary lg:inline"
          >
            Reset columns
          </button>
        </div>
      </div>

      {/* Filter chips with counts (after the search) */}
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
        {FILE_FILTERS.map(({ value, label }) => (
          <Chip
            key={value}
            active={view.filter === value}
            onClick={() => setView({ filter: view.filter === value && value !== 'all' ? 'all' : value })}
          >
            {label}
            <span className="tabular-nums opacity-70">{list.data ? counts[value] : '…'}</span>
          </Chip>
        ))}
      </div>

      {/* Summary, how many are shown, and selection */}
      {list.data && (
        <div className="flex flex-col gap-2 text-xs text-text-tertiary sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <p className="text-text-secondary">{summaryText(all, total)}</p>
            <p aria-live="polite" className="tabular-nums">
              Showing {shown.length} of {total}
              {truncated &&
                ` (the first ${FILES_LOAD_LIMIT} are loaded; counts and sorting cover those, search also finds names beyond them)`}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 sm:justify-end">
              <label className="inline-flex min-h-[2rem] items-center gap-2 text-text-secondary">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someShownSelected
                  }}
                  disabled={targets.eligible === 0}
                  onChange={toggleAll}
                  className="h-4 w-4 lg:h-3.5 lg:w-3.5 accent-[var(--accent)] disabled:opacity-40"
                />
                Select all shown{targets.eligible > 0 && ` (${targets.eligible})`}
              </label>
              <span className="tabular-nums" aria-live="polite">
                {selected.size > 0 ? `${selected.size} selected` : `Up to ${MAX_PROCESS_BATCH} per batch`}
                {hiddenSelected > 0 && `, ${hiddenSelected} not shown`}
                {full && !clipStands && ' (the most per batch)'}
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
      )}
      {canManage && clipStands && clip && (
        <p className="flex gap-2 text-xs text-status-warning" role="status">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Selected the first {MAX_PROCESS_BATCH} of the {clip.eligible} files shown that can be processed: one
            batch takes at most {MAX_PROCESS_BATCH}. Process these, then select again for the rest.
          </span>
        </p>
      )}

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
      ) : pool.length === 0 ? (
        <EmptyState
          icon={FileX2}
          title="No video or audio files yet"
          description="Files in the source folder chosen in the settings show up here."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={FileX2}
          title="No files match"
          description={
            q ? 'Try another part of the name or folder, or another filter.' : 'No file is in this state right now.'
          }
          action={filtering ? { label: 'Clear search and filter', onClick: clearView } : undefined}
        />
      ) : (
        // Wider than the page (dragged columns, a narrow window): the table
        // scrolls sideways inside this box, not the page.
        <div className="rounded-lg border border-border bg-bg-secondary lg:overflow-x-auto">
          <Tooltip.Provider delayDuration={300}>
            <div
              role="table"
              aria-label="Files"
              className="lg:min-w-[var(--files-min)]"
              style={
                {
                  '--files-cols': columnTemplate(columns.widths),
                  '--files-min': `${tableMinWidth(columns.widths)}px`,
                } as React.CSSProperties
              }
            >
          <div role="rowgroup" className="hidden lg:block">
            <div
              role="row"
              className={cn(
                COLUMNS,
                'border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-text-tertiary',
              )}
            >
              <span role="columnheader">
                <span className="sr-only">Selected</span>
              </span>
              {FILE_COLUMNS.map((col) => (
                <HeaderCell
                  key={col.key}
                  col={col}
                  width={columns.widths[col.key]}
                  sort={view.sort}
                  onSort={(key) => setView({ sort: toggleSort(view.sort, key) })}
                  onResize={(px) => columns.setWidth(col.key, px)}
                  onReset={() => columns.reset(col.key)}
                />
              ))}
              <span aria-hidden />
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
          </div>
          {groups ? (
            groups.map((g) => {
              const open = !collapsed.has(g.key)
              const id = `snippet-files-group-${encodeURIComponent(g.key)}`
              return (
                <div key={g.key} role="rowgroup" className="border-b border-border last:border-b-0">
                  <div role="row" className="bg-bg-primary/40">
                    <span role="rowheader" className="block">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={id}
                        onClick={() => toggleGroup(g.key)}
                        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 hover-none:py-3 text-left text-xs font-semibold text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
                        )}
                        <span className="truncate" title={g.label}>
                          {g.label}
                        </span>
                        <span className="shrink-0 font-normal tabular-nums text-text-tertiary">
                          {g.files.length} {g.files.length === 1 ? 'file' : 'files'}
                        </span>
                      </button>
                    </span>
                  </div>
                  <div id={id} hidden={!open} className="divide-y divide-border border-t border-border">
                    {open && g.files.map(row)}
                  </div>
                </div>
              )
            })
          ) : (
            <div role="rowgroup" className="divide-y divide-border">
              {shown.map(row)}
            </div>
          )}
            </div>
          </Tooltip.Provider>
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
  wrapName,
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
  /** Long names on up to two lines; false keeps them on one. */
  wrapName: boolean
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
  const meta = [
    f.duration_ms != null ? formatLength(f.duration_ms) : null,
    f.kind === 'audio' ? 'Audio' : 'Video',
    f.updated_at ? `updated ${formatRelativeTime(f.updated_at)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const folder = folderLabel(f.folder_path)
  const indent = canManage && 'pl-7 lg:pl-0'
  // Only a file that counts as needing a name warns (see needsSpeaker).
  const warnable = needsSpeaker(f)

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

      {/* Name, folder path; length, kind and update time on cards only */}
      <span role="cell" className={cn('min-w-0', indent)}>
        <span className="flex min-w-0 items-start gap-2">
          <Icon className={cn('mt-0.5 h-4 w-4 shrink-0 text-text-tertiary', notReady && 'opacity-50')} aria-hidden />
          <FileName name={f.name} wrap={wrapName} dim={notReady} />
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-secondary" title={folder}>
          <span className="sr-only">Folder: </span>
          {folder}
        </span>
        <span className="block truncate text-xs text-text-tertiary lg:hidden">{meta}</span>
      </span>

      {/* Kind and folder (table only) */}
      <span role="cell" className="hidden text-xs text-text-secondary lg:block">
        {f.kind === 'audio' ? 'Audio' : 'Video'}
      </span>
      <span role="cell" className="hidden truncate text-xs text-text-secondary lg:block" title={folder}>
        {folder}
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

      {/* Length, counts, last updated (table only) */}
      <span role="cell" className="hidden text-right text-xs text-text-secondary tabular-nums lg:block">
        {f.duration_ms != null ? formatLength(f.duration_ms) : '–'}
      </span>
      <span role="cell" className="hidden text-right text-xs text-text-secondary tabular-nums lg:block">
        {f.segment_count}
      </span>
      <span role="cell" className="hidden text-right text-xs text-text-secondary tabular-nums lg:block">
        {f.snippet_count}
      </span>
      <span
        role="cell"
        className="hidden truncate text-xs text-text-secondary lg:block"
        title={f.updated_at ? new Date(f.updated_at).toLocaleString() : undefined}
      >
        {f.updated_at ? formatRelativeTime(f.updated_at) : '–'}
      </span>

      {/* Tracks */}
      <span role="cell" className={cn('min-w-0 space-y-1.5', indent)}>
        {f.tracks.length === 0 ? (
          <span className="text-xs text-text-tertiary">No audio tracks known yet</span>
        ) : (
          f.tracks.map((t) => (
            <span key={t.track_index} className="flex min-w-0 items-center gap-2">
              <span
                className="w-14 shrink-0 text-xs text-text-tertiary tabular-nums"
                title={t.label}
              >
                {trackName(t)}
              </span>
              <SpeakerSelect
                value={t.speaker_id}
                fallbackName={t.speaker_name}
                hasSpeech={trackHasSpeech(t)}
                warn={warnable && trackNeedsSpeaker(t)}
                speakers={speakers}
                disabled={notReady || !f.media_file_id}
                busy={busyTrack === `${f.media_file_id}:${t.track_index}`}
                label={`Speaker on ${trackName(t)} (${t.label}), ${f.name}`}
                onChange={(id) => onAssign(t.track_index, id)}
                onAdd={() => onAddSpeaker(t.track_index)}
              />
            </span>
          ))
        )}
      </span>

      {/* Spare width (table only) */}
      <span aria-hidden className="hidden lg:block" />

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
            'break-words text-xs lg:[grid-column:2/-2]',
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

/**
 * A long name on up to two lines (then an ellipsis), or on one with `wrap`
 * off. The full name is in a tooltip on hover and on keyboard focus.
 */
function FileName({ name, wrap, dim }: { name: string; wrap: boolean; dim: boolean }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span
          tabIndex={0}
          className={cn(
            'min-w-0 rounded text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            wrap ? 'line-clamp-2' : 'truncate',
            dim ? 'text-text-tertiary' : 'text-text-primary',
          )}
        >
          {name}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[70] max-w-[min(32rem,calc(100vw-1rem))] rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-primary shadow-lg [overflow-wrap:anywhere]"
        >
          {name}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

/** Arrow keys move a focused resize handle by this much (Shift: four times). */
const RESIZE_STEP = 8

/**
 * A table header: the label sorts (click, Enter or Space; again flips the
 * direction), and the handle on its right border resizes the column (drag
 * with mouse or touch, arrow keys, double-click to reset).
 */
function HeaderCell({
  col,
  width,
  sort,
  onSort,
  onResize,
  onReset,
}: {
  col: FileColumn
  width: number
  sort: FileSort
  onSort: (key: FileSortKey) => void
  onResize: (px: number) => void
  onReset: () => void
}) {
  const ariaSort = col.sort ? ariaSortOf(sort, col.sort) : 'none'
  const SortIcon = ariaSort === 'ascending' ? ArrowUp : ariaSort === 'descending' ? ArrowDown : ArrowUpDown
  const drag = React.useRef<{ x: number; w: number; id: number } | null>(null)
  const label = <span className="truncate">{col.label}</span>

  return (
    <span
      role="columnheader"
      aria-sort={ariaSort === 'none' ? undefined : ariaSort}
      className={cn('relative flex min-w-0 items-center', col.align === 'right' && 'justify-end')}
    >
      {col.sort ? (
        <button
          type="button"
          onClick={() => onSort(col.sort!)}
          className={cn(
            'flex min-w-0 items-center gap-1 rounded uppercase tracking-wider hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            col.align === 'right' && 'flex-row-reverse',
            ariaSort !== 'none' && 'text-text-primary',
          )}
        >
          {label}
          <SortIcon className={cn('h-3 w-3 shrink-0', ariaSort === 'none' && 'opacity-40')} aria-hidden />
        </button>
      ) : (
        label
      )}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize the ${col.label} column`}
        aria-valuenow={width}
        aria-valuemin={col.min}
        aria-valuemax={MAX_COLUMN_WIDTH}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, w: width, id: e.pointerId }
        }}
        onPointerMove={(e) => {
          if (drag.current?.id === e.pointerId) onResize(drag.current.w + e.clientX - drag.current.x)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
        onDoubleClick={onReset}
        onKeyDown={(e) => {
          const step = e.shiftKey ? RESIZE_STEP * 4 : RESIZE_STEP
          if (e.key === 'ArrowLeft') onResize(width - step)
          else if (e.key === 'ArrowRight') onResize(width + step)
          else if (e.key === 'Home' || e.key === 'Escape') onReset()
          else return
          e.preventDefault()
        }}
        className="group/handle absolute -right-[7px] top-[-0.5rem] bottom-[-0.5rem] z-10 flex w-3.5 cursor-col-resize touch-none select-none justify-center focus-visible:outline-none"
      >
        <span className="h-full w-px bg-border transition-colors group-hover/handle:w-0.5 group-hover/handle:bg-accent group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-accent" />
      </span>
    </span>
  )
}

/** Radix Select reserves "" (it shows the placeholder), so "add" gets a sentinel. */
const ADD_NEW = '__add_new_speaker__'

function SpeakerSelect({
  value,
  fallbackName,
  hasSpeech,
  warn,
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
  /** False for a track the last run found no speech on. */
  hasSpeech: boolean
  /** No speaker on a track of a processed file that may have speech. */
  warn: boolean
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
  const missing = !value && warn
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
        className={cn(
          'inline-flex h-8 hover-none:h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border bg-bg-primary px-2.5 text-xs text-text-primary transition-colors hover:bg-bg-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50 lg:max-w-[14rem]',
          missing ? 'border-status-warning/50' : 'border-border',
        )}
      >
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            !value && (missing ? 'font-medium text-status-warning' : 'text-text-tertiary'),
          )}
        >
          {missing && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="truncate">
            <Select.Value placeholder={hasSpeech ? 'no speaker yet' : 'no speech found'} />
          </span>
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
