'use client'

import * as React from 'react'
import Link from 'next/link'
import * as Popover from '@radix-ui/react-popover'
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  FolderIcon,
  GitBranch,
  Image as ImageIcon,
  Images,
  Music,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { cn, TRASH_RETENTION_DAYS } from '@/lib/utils'
import { useFormatBytes } from '@/hooks/use-byte-units'
import { useOptionalToast } from '@/components/shared/toast'
import { useTrash, type TrashQuery } from '@/hooks/use-folders'
import type { TrashEntry, TrashKind, TrashSort } from '@/types'

/**
 * How long the search box waits before it becomes a request (§241 item 3).
 *
 * Exported so a test can drive the same number the component uses rather
 * than a copy of it.
 */
export const TRASH_SEARCH_DEBOUNCE_MS = 300

/** Rows per page. The API caps `limit` at 100; this is a readable page. */
export const TRASH_PAGE_SIZE = 25

const assetTypeIcons: Record<string, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
}

/**
 * The six orderings the owner asked for, as ONE list.
 *
 * Each is a (`sort`, `order`) pair for the API, which has four sort keys
 * and a direction — "Newest deleted" and "Oldest deleted" are the same key
 * in opposite directions, so a single flat list is what keeps the control
 * and the request in step. `expires_at` sorts identically to `deleted_at`
 * on the server (it is that column plus a constant), and is kept as its
 * own option because "what am I about to lose" is the question it answers.
 */
export const TRASH_SORT_OPTIONS: {
  value: string
  label: string
  sort: TrashSort
  order: 'asc' | 'desc'
}[] = [
  { value: 'newest', label: 'Newest deleted', sort: 'deleted_at', order: 'desc' },
  { value: 'oldest', label: 'Oldest deleted', sort: 'deleted_at', order: 'asc' },
  { value: 'name_asc', label: 'Name A–Z', sort: 'name', order: 'asc' },
  { value: 'name_desc', label: 'Name Z–A', sort: 'name', order: 'desc' },
  { value: 'largest', label: 'Largest', sort: 'size', order: 'desc' },
  { value: 'expiring', label: 'Expiring soonest', sort: 'expires_at', order: 'asc' },
]

const KIND_OPTIONS: { value: TrashKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'asset', label: 'Assets' },
  { value: 'folder', label: 'Folders' },
  { value: 'version', label: 'Versions' },
]

/** The deleter filter's value for rows the server has no deleter for. */
const UNKNOWN_DELETER = 'unknown'

/**
 * Whole days left before the purge takes it, and how alarmed to look.
 *
 * `expires_at` comes from the API (`deleted_at` + the server's retention
 * window) rather than being recomputed here, so a server whose retention
 * is not 30 days is still reported truthfully.
 *
 * Amber from a week out, red in the last three days: the owner asked for
 * "red/amber when ≤ 7 days", and the two steps are what makes "next week"
 * distinguishable from "tomorrow" at a glance.
 */
export function expiryState(
  expiresAt: string | null,
  now: number = Date.now(),
): { days: number; label: string; className: string } | null {
  if (!expiresAt) return null
  const at = new Date(expiresAt)
  if (Number.isNaN(at.getTime())) return null
  const ms = at.getTime() - now
  if (ms <= 0) {
    return {
      days: 0,
      label: 'expiring shortly',
      className: 'text-status-error',
    }
  }
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  const label = days === 0 ? 'less than a day left' : `${days} day${days === 1 ? '' : 's'} left`
  return {
    days,
    label,
    className:
      days <= 3 ? 'text-status-error' : days <= 7 ? 'text-status-warning' : 'text-text-tertiary',
  }
}

/** "Version 3 of “Opening shot.mov”" — a version row must never read as a
 *  file of its own. */
export function trashEntryTitle(item: TrashEntry): string {
  if (item.kind === 'version' && item.version_number !== null) {
    return `Version ${item.version_number} of “${item.name}”`
  }
  return item.name
}

interface RecentlyDeletedProps {
  projectId: string
  /** Called after a successful restore so the caller can refresh the grid,
   *  the folder list and the tree — which rows came back is not knowable
   *  from here. */
  onRestored?: () => void
  /** Hands the item to the caller's existing permanent-delete confirm
   *  (irreversible, so it keeps its dialog and its owner/admin gate). */
  onPurge: (item: { id: string; name: string; kind: 'asset' | 'folder' }) => void
  /** Restores, by kind. The hook's calls, passed in so this view does not
   *  hold a second copy of the three endpoints. */
  onRestoreAsset: (assetId: string) => Promise<void>
  onRestoreFolder: (folderId: string) => Promise<void>
  onRestoreVersion: (assetId: string, versionId: string) => Promise<void>
  /** Bumped by the page when a purge completed, so the list re-reads. */
  refreshToken?: number
}

export function RecentlyDeleted({
  projectId,
  onRestored,
  onPurge,
  onRestoreAsset,
  onRestoreFolder,
  onRestoreVersion,
  refreshToken,
}: RecentlyDeletedProps) {
  const formatBytes = useFormatBytes()
  const toast = useOptionalToast()

  const [search, setSearch] = React.useState('')
  const [debouncedSearch, setDebouncedSearch] = React.useState('')
  const [kind, setKind] = React.useState<TrashKind | 'all'>('all')
  const [deletedBy, setDeletedBy] = React.useState<string>('')
  const [sortValue, setSortValue] = React.useState('newest')
  const [includeNested, setIncludeNested] = React.useState(false)
  const [page, setPage] = React.useState(0)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)

  // One request per pause in typing, not one per keystroke (§241 item 3).
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), TRASH_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // Any change to what is being asked for puts the user back on page 1:
  // page 3 of the old filter is a different set of rows, and an offset past
  // the new `total` answers an empty page the user did not ask for.
  React.useEffect(() => {
    setPage(0)
  }, [debouncedSearch, kind, deletedBy, sortValue, includeNested])

  const sortOption =
    TRASH_SORT_OPTIONS.find((o) => o.value === sortValue) ?? TRASH_SORT_OPTIONS[0]

  const query: TrashQuery = {
    q: debouncedSearch,
    kind,
    deletedBy: deletedBy || null,
    sort: sortOption.sort,
    order: sortOption.order,
    includeNested,
    limit: TRASH_PAGE_SIZE,
    offset: page * TRASH_PAGE_SIZE,
  }

  const {
    items,
    total,
    retentionDays,
    deleters,
    unknownDeleterPresent,
    isLoading,
    mutateTrash,
  } = useTrash(projectId, query)

  React.useEffect(() => {
    if (refreshToken !== undefined) void mutateTrash()
    // mutateTrash is stable per key; the token is the signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  // The number shown anywhere here is the SERVER's retention window when
  // it sent one (§241 item 3) — the constant is only a fallback for an API
  // that does not.
  const retention = retentionDays ?? TRASH_RETENTION_DAYS

  const filtersActive =
    Boolean(debouncedSearch.trim()) || kind !== 'all' || Boolean(deletedBy) || includeNested

  const pageCount = Math.max(1, Math.ceil(total / TRASH_PAGE_SIZE))
  const firstRow = total === 0 ? 0 : page * TRASH_PAGE_SIZE + 1
  const lastRow = Math.min(total, (page + 1) * TRASH_PAGE_SIZE)

  async function handleRestore(item: TrashEntry) {
    setRestoringId(item.id)
    try {
      if (item.kind === 'folder') await onRestoreFolder(item.id)
      else if (item.kind === 'asset') await onRestoreAsset(item.id)
      else if (item.asset_id) await onRestoreVersion(item.asset_id, item.id)
      toast(`${trashEntryTitle(item)} restored`, 'success')
      await mutateTrash()
      onRestored?.()
    } catch (err) {
      // The server's own message: a 403 names who may restore, a 409
      // `storage_limit` says the limit is what blocks it.
      toast(
        err instanceof Error && err.message ? err.message : 'Could not restore this item.',
        'error',
      )
    } finally {
      setRestoringId(null)
    }
  }

  const controls = (variant: 'bar' | 'sheet') => (
    <TrashControls
      variant={variant}
      kind={kind}
      onKindChange={setKind}
      deletedBy={deletedBy}
      onDeletedByChange={setDeletedBy}
      deleters={deleters}
      unknownDeleterPresent={unknownDeleterPresent}
      sortValue={sortValue}
      onSortChange={setSortValue}
      includeNested={includeNested}
      onIncludeNestedChange={setIncludeNested}
    />
  )

  return (
    <div data-testid="recently-deleted" className="flex-1">
      <h2 className="text-sm font-medium text-text-primary mb-1">Recently Deleted</h2>
      <p className="text-xs text-text-tertiary mb-3">
        Items are permanently deleted {retention} days after they were removed.
      </p>

      {/* ─── Search + filters ───────────────────────────────────────────
          The same controls twice, by WIDTH rather than by a media-query
          hook: a row at `md`+, and one "Filter & sort" button below it
          that opens them in a popover. CSS is what the rest of this page
          uses to change shape (§224/§230), so the server and the first
          client render emit the same tree. */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            data-testid="trash-search"
            aria-label="Search deleted items"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search deleted items"
            className="h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-secondary pl-8 pr-8 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
          />
          {search && (
            <button
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-1 top-1/2 flex h-7 w-7 hover-none:h-11 hover-none:w-11 -translate-y-1/2 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Phones and compact landscape: one button, the same controls. */}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              data-testid="trash-filter-sheet-trigger"
              className="flex h-11 min-w-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover md:hidden"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filter &amp; sort
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="z-[100] w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl"
            >
              {controls('sheet')}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <div className="hidden md:flex md:items-center md:gap-2">{controls('bar')}</div>
      </div>

      {/* ─── Rows ───────────────────────────────────────────────────────── */}
      {isLoading && items.length === 0 ? (
        <p className="text-xs text-text-tertiary">Loading…</p>
      ) : items.length === 0 ? (
        filtersActive ? (
          <div data-testid="trash-no-results" className="py-6">
            <p className="text-sm text-text-secondary">Nothing matches those filters.</p>
            <button
              className="mt-2 text-xs text-accent hover:underline"
              onClick={() => {
                setSearch('')
                setKind('all')
                setDeletedBy('')
                setIncludeNested(false)
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          /* §240's visibility rule, said plainly: an editor's trash holds
             only their own deletions, so an empty one is normal rather
             than a sign that nothing was ever deleted. */
          <div data-testid="trash-empty" className="py-6">
            <p className="text-sm text-text-secondary">
              Nothing you deleted is here. Items others deleted can be restored by the
              project owner.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <TrashRow
              key={`${item.kind}-${item.id}`}
              item={item}
              projectId={projectId}
              formatBytes={formatBytes}
              restoring={restoringId === item.id}
              onRestore={() => handleRestore(item)}
              onPurge={() =>
                onPurge({
                  id: item.id,
                  name: item.name,
                  kind: item.kind === 'folder' ? 'folder' : 'asset',
                })
              }
            />
          ))}
        </div>
      )}

      {/* ─── Paging ─────────────────────────────────────────────────────
          Driven by `total`, which is every row the filters match for this
          caller rather than the length of this page — the pre-§240 view
          had no total and therefore no way to know there was more. */}
      {total > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-text-tertiary">
          <span data-testid="trash-range">
            {firstRow}–{lastRow} of {total}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <button
                data-testid="trash-prev-page"
                aria-label="Previous page"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="flex h-8 w-8 hover-none:h-11 hover-none:w-11 items-center justify-center rounded-md border border-border disabled:opacity-40 hover:bg-bg-hover"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span>
                Page {page + 1} of {pageCount}
              </span>
              <button
                data-testid="trash-next-page"
                aria-label="Next page"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
                className="flex h-8 w-8 hover-none:h-11 hover-none:w-11 items-center justify-center rounded-md border border-border disabled:opacity-40 hover:bg-bg-hover"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Kind, deleter, sort and the nested toggle — written once and rendered in
 * both the `md`+ bar and the phone popover, so the two cannot drift into
 * offering different filters.
 *
 * Native `<select>`s: they are keyboard- and screen-reader-correct for
 * free, they are the platform's own picker wheel on a phone, and the page
 * already has no custom select of its own to match.
 */
function TrashControls({
  variant,
  kind,
  onKindChange,
  deletedBy,
  onDeletedByChange,
  deleters,
  unknownDeleterPresent,
  sortValue,
  onSortChange,
  includeNested,
  onIncludeNestedChange,
}: {
  variant: 'bar' | 'sheet'
  kind: TrashKind | 'all'
  onKindChange: (kind: TrashKind | 'all') => void
  deletedBy: string
  onDeletedByChange: (value: string) => void
  deleters: { id: string; name: string }[]
  unknownDeleterPresent: boolean
  sortValue: string
  onSortChange: (value: string) => void
  includeNested: boolean
  onIncludeNestedChange: (value: boolean) => void
}) {
  const sheet = variant === 'sheet'
  const selectClass = cn(
    'rounded-md border border-border bg-bg-secondary px-2 text-sm text-text-primary outline-none focus:border-accent',
    sheet ? 'h-11 w-full' : 'h-9 hover-none:h-11',
  )
  // §240 — the "Deleted by" filter is hidden when there is nobody to
  // choose between: an editor sees only their own deletions, so their
  // `deleters` holds at most themselves and the control would be a
  // one-option dropdown that cannot change the list.
  const showDeleters = deleters.length + (unknownDeleterPresent ? 1 : 0) > 1

  return (
    <div
      data-testid={sheet ? 'trash-controls-sheet' : 'trash-controls-bar'}
      className={cn(sheet ? 'space-y-3' : 'flex items-center gap-2')}
    >
      <label className={cn(sheet ? 'block space-y-1' : 'contents')}>
        <span className={cn('text-xs text-text-tertiary', sheet ? 'block' : 'sr-only')}>
          Kind
        </span>
        <select
          data-testid={sheet ? 'trash-kind-sheet' : 'trash-kind'}
          aria-label="Filter by kind"
          value={kind}
          onChange={(e) => onKindChange(e.target.value as TrashKind | 'all')}
          className={selectClass}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {showDeleters && (
        <label className={cn(sheet ? 'block space-y-1' : 'contents')}>
          <span className={cn('text-xs text-text-tertiary', sheet ? 'block' : 'sr-only')}>
            Deleted by
          </span>
          <select
            data-testid={sheet ? 'trash-deleter-sheet' : 'trash-deleter'}
            aria-label="Filter by who deleted it"
            value={deletedBy}
            onChange={(e) => onDeletedByChange(e.target.value)}
            className={selectClass}
          >
            <option value="">Anyone</option>
            {deleters.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || 'Unnamed user'}
              </option>
            ))}
            {/* Only offered when the server says such rows exist — there
                is no user to name for a deletion made before §240. */}
            {unknownDeleterPresent && <option value={UNKNOWN_DELETER}>Unknown</option>}
          </select>
        </label>
      )}

      <label className={cn(sheet ? 'block space-y-1' : 'contents')}>
        <span className={cn('text-xs text-text-tertiary', sheet ? 'block' : 'sr-only')}>
          Sort
        </span>
        <select
          data-testid={sheet ? 'trash-sort-sheet' : 'trash-sort'}
          aria-label="Sort deleted items"
          value={sortValue}
          onChange={(e) => onSortChange(e.target.value)}
          className={selectClass}
        >
          {TRASH_SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {/* `include_nested`: by default the list shows only the ROOTS of each
          deletion, so a folder with 200 files in it is one row. */}
      <label
        className={cn(
          'flex cursor-pointer items-center gap-2 text-xs text-text-secondary',
          sheet ? 'min-h-11' : 'whitespace-nowrap',
        )}
      >
        <input
          data-testid={sheet ? 'trash-nested-sheet' : 'trash-nested'}
          type="checkbox"
          checked={includeNested}
          onChange={(e) => onIncludeNestedChange(e.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        Show contents of deleted folders
      </label>
    </div>
  )
}

/**
 * One row of Recently Deleted.
 *
 * What it has to say is what the pre-§240 view could not: where the thing
 * used to live, who deleted it, how long is left, how big it is — and, for
 * a version, that it is a version OF something rather than a file.
 *
 * Both actions are rendered from the server's own flags. `can_restore` is
 * "the deleter, the project owner or a superadmin" and `can_purge` mirrors
 * the purge routes (and is never true for a version, which has no purge
 * route at all). Neither is re-derived here.
 */
function TrashRow({
  item,
  projectId,
  formatBytes,
  restoring,
  onRestore,
  onPurge,
}: {
  item: TrashEntry
  projectId: string
  formatBytes: (bytes: number) => string
  restoring: boolean
  onRestore: () => void
  onPurge: () => void
}) {
  const expiry = expiryState(item.expires_at)
  const deletedAt = item.deleted_at ? new Date(item.deleted_at) : null
  const Icon =
    item.kind === 'folder'
      ? FolderIcon
      : (assetTypeIcons[item.asset_type ?? ''] ?? ImageIcon)
  const who = item.deleted_by?.name?.trim() || 'Unknown'

  return (
    <div
      data-testid={`trash-row-${item.id}`}
      data-kind={item.kind}
      className="flex items-start justify-between gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-text-tertiary" />
          <span className="truncate text-sm text-text-primary">{trashEntryTitle(item)}</span>
          {item.kind === 'version' && (
            <span
              data-testid={`trash-version-badge-${item.id}`}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-bg-hover px-1.5 py-px text-[10px] font-semibold uppercase leading-tight text-text-secondary"
            >
              <GitBranch className="h-2.5 w-2.5" />
              Version
            </span>
          )}
          {item.kind === 'folder' && (
            <span className="shrink-0 text-xs text-text-tertiary">Folder</span>
          )}
        </div>

        <p className="mt-0.5 pl-6 text-2xs text-text-tertiary">
          <span>{item.original_path ? `in ${item.original_path}` : 'in the project root'}</span>
          {item.kind === 'folder' && (
            <>
              <span className="mx-1.5 text-text-tertiary/50">·</span>
              <span data-testid={`trash-child-count-${item.id}`}>
                {item.child_count} {item.child_count === 1 ? 'item' : 'items'} inside
              </span>
            </>
          )}
          <span className="mx-1.5 text-text-tertiary/50">·</span>
          <span data-testid={`trash-deleter-${item.id}`}>Deleted by {who}</span>
          {deletedAt && !Number.isNaN(deletedAt.getTime()) && (
            <>
              <span className="mx-1.5 text-text-tertiary/50">·</span>
              <span title={deletedAt.toString()}>
                {deletedAt.toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </>
          )}
          {expiry && (
            <>
              <span className="mx-1.5 text-text-tertiary/50">·</span>
              <span
                data-testid={`trash-expiry-${item.id}`}
                className={expiry.className}
                title={
                  item.expires_at
                    ? `Permanently deleted after ${new Date(item.expires_at).toLocaleString()}`
                    : undefined
                }
              >
                {expiry.label}
              </span>
            </>
          )}
          {item.size_bytes > 0 && (
            <>
              <span className="mx-1.5 text-text-tertiary/50">·</span>
              <span data-testid={`trash-size-${item.id}`}>{formatBytes(item.size_bytes)}</span>
            </>
          )}
        </p>

        {/* The asset is still live for a `version` row (a deleted version of
            a deleted asset is not its own row), so there is always
            somewhere for this to go. */}
        {item.kind === 'version' && item.asset_id && (
          <Link
            data-testid={`trash-go-to-asset-${item.id}`}
            href={`/projects/${projectId}/assets/${item.asset_id}`}
            className="ml-6 mt-0.5 inline-flex items-center gap-1 text-2xs text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Go to asset
          </Link>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {item.can_restore && (
          <button
            data-testid={`trash-restore-${item.id}`}
            disabled={restoring}
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-40 hover-none:min-h-11"
            onClick={onRestore}
          >
            <RotateCcw className="h-3 w-3" />
            Restore
          </button>
        )}
        {item.can_purge && (
          <button
            data-testid={`trash-purge-${item.id}`}
            className="inline-flex items-center gap-1 text-xs text-status-error hover:underline hover-none:min-h-11"
            onClick={onPurge}
          >
            <Trash2 className="h-3 w-3" />
            Delete Permanently
          </button>
        )}
      </div>
    </div>
  )
}
