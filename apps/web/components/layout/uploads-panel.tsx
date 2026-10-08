'use client'

import * as React from 'react'
import {
  X,
  CheckCircle,
  AlertCircle,
  Loader2,
  Film,
  Music,
  Image as ImageIcon,
  FileIcon,
  RotateCcw,
  Ban,
  Cog,
  Pause,
  Play,
  Upload,
  Trash2,
} from 'lucide-react'
import { cn, formatRelativeTime, formatSpeed, formatEta } from '@/lib/utils'
import { useFormatBytes } from '@/hooks/use-byte-units'
import { useUploadStore, type UploadFile, type UploadStatus } from '@/stores/upload-store'
import { fileFromHandle, type UploadSession } from '@/lib/upload-sessions'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFileIcon(fileType: string) {
  if (fileType.startsWith('video/')) return <Film className="h-5 w-5" />
  if (fileType.startsWith('audio/')) return <Music className="h-5 w-5" />
  if (fileType.startsWith('image/')) return <ImageIcon className="h-5 w-5" />
  return <FileIcon className="h-5 w-5" />
}

type FilterTab = 'all' | 'active' | 'complete' | 'failed'

function matchesFilter(status: UploadStatus, filter: FilterTab): boolean {
  switch (filter) {
    case 'all': return true
    case 'active': return status === 'pending' || status === 'uploading' || status === 'paused' || status === 'processing'
    case 'complete': return status === 'complete'
    case 'failed': return status === 'failed' || status === 'cancelled'
  }
}

function groupByDate(files: UploadFile[]): { label: string; items: UploadFile[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000

  const groups: Record<string, UploadFile[]> = {}

  for (const f of files) {
    let label: string
    if (f.createdAt >= today) {
      label = 'Today'
    } else if (f.createdAt >= yesterday) {
      label = 'Yesterday'
    } else {
      label = new Date(f.createdAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    }
    if (!groups[label]) groups[label] = []
    groups[label].push(f)
  }

  return Object.entries(groups).map(([label, items]) => ({ label, items }))
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: UploadStatus }) {
  switch (status) {
    case 'pending':
      return <span className="inline-flex items-center rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-tertiary">Queued</span>
    case 'uploading':
      return <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"><Loader2 className="h-2.5 w-2.5 animate-spin" />Uploading</span>
    case 'paused':
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"><Pause className="h-2.5 w-2.5" />Paused</span>
    case 'processing':
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"><Cog className="h-2.5 w-2.5 animate-spin" />Processing</span>
    case 'complete':
      return <span className="inline-flex items-center gap-1 rounded-full bg-status-success/10 px-2 py-0.5 text-[10px] font-medium text-status-success"><CheckCircle className="h-2.5 w-2.5" />Ready</span>
    case 'failed':
      return <span className="inline-flex items-center gap-1 rounded-full bg-status-error/10 px-2 py-0.5 text-[10px] font-medium text-status-error"><AlertCircle className="h-2.5 w-2.5" />Failed</span>
    case 'cancelled':
      return <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-text-tertiary"><Ban className="h-2.5 w-2.5" />Cancelled</span>
  }
}

// ─── Upload Item ──────────────────────────────────────────────────────────────

function UploadItem({ upload }: { upload: UploadFile }) {
  const formatBytes = useFormatBytes()
  const { cancelUpload, pauseUpload, resumeUpload, removeFile } = useUploadStore()
  const isActive = upload.status === 'pending' || upload.status === 'uploading' || upload.status === 'paused'
  const isProcessing = upload.status === 'processing'
  const showProgress = isActive || isProcessing

  const progressValue = isProcessing ? upload.processingProgress : upload.progress

  return (
    <div className="group flex items-start gap-3 px-4 py-3 hover:bg-bg-hover/50 transition-colors">
      {/* Icon */}
      <div className="h-10 w-10 shrink-0 rounded-md bg-bg-tertiary flex items-center justify-center text-text-tertiary overflow-hidden">
        {getFileIcon(upload.fileType)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-text-primary truncate flex-1">{upload.assetName}</p>
          <StatusBadge status={upload.status} />
        </div>
        <p className="text-xs text-text-tertiary truncate mt-0.5">
          {upload.projectName || upload.projectId.slice(0, 8)} &middot; {formatBytes(upload.fileSize)}
        </p>

        {/* Progress bar */}
        {showProgress && (
          <div className="mt-2 h-1.5 w-full rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                isProcessing ? 'bg-amber-400' : upload.status === 'paused' ? 'bg-amber-400' : 'bg-accent',
              )}
              style={{ width: `${progressValue}%` }}
            />
          </div>
        )}

        {/* Detail line */}
        <div className="flex items-center gap-1 mt-1">
          {upload.status === 'uploading' && (
            <span className="text-[11px] text-text-secondary truncate">
              Uploading {upload.progress}%
              {upload.speedBps != null && ` · ${formatSpeed(upload.speedBps)}`}
              {upload.etaSeconds != null && ` · ${formatEta(upload.etaSeconds)} left`}
            </span>
          )}
          {upload.status === 'paused' && upload.pauseReason === 'manual' && (
            <span className="text-[11px] text-amber-400">
              Paused at {upload.progress}% &middot; click resume to continue
            </span>
          )}
          {upload.status === 'paused' && upload.pauseReason === 'retrying' && (
            <span className="text-[11px] text-amber-400 truncate">
              {upload.error ?? 'Connection interrupted — retrying…'}
            </span>
          )}
          {upload.status === 'processing' && (
            <span className="text-[11px] text-amber-400">
              {upload.processingProgress > 0 ? `Processing ${upload.processingProgress}%` : 'Processing...'}
            </span>
          )}
          {upload.status === 'complete' && (
            <span className="text-[11px] text-text-tertiary">
              {formatRelativeTime(new Date(upload.createdAt).toISOString())}
            </span>
          )}
          {upload.status === 'failed' && upload.error && (
            <span className="text-[11px] text-status-error truncate">{upload.error}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {upload.status === 'uploading' && (
          <button
            onClick={() => pauseUpload(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Pause upload"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {upload.status === 'paused' && upload.pauseReason === 'manual' && (
          <button
            onClick={() => resumeUpload(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Resume upload"
          >
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
        {upload.status === 'paused' && upload.pauseReason === 'retrying' && (
          <button
            onClick={() => pauseUpload(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Pause upload"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
        {isActive && (
          <button
            onClick={() => cancelUpload(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Cancel upload"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {(upload.status === 'complete' || upload.status === 'cancelled') && (
          <button
            onClick={() => removeFile(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {upload.status === 'failed' && (
          <button
            onClick={() => removeFile(upload.id)}
            className="h-6 w-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * §213 — an upload this browser can still finish.
 *
 * A browser cannot reopen a file by itself after the tab closed, so this
 * row exists to ask for the same file back. Where the File System Access
 * API is available (Chromium) the handle was stored and this is one
 * permission click; everywhere else it is a file picker. Both paths end in
 * the same `resumeInterrupted`, which refuses a file that is not the same
 * one rather than uploading it into the wrong session.
 */
function InterruptedItem({ session }: { session: UploadSession }) {
  const { resumeInterrupted, discardInterrupted } = useUploadStore()
  const formatBytes = useFormatBytes()
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const start = React.useCallback(
    async (file: File) => {
      setError(null)
      setBusy(true)
      try {
        await resumeInterrupted(session.uploadId, file)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not resume that upload.')
      } finally {
        setBusy(false)
      }
    },
    [resumeInterrupted, session.uploadId],
  )

  const onResume = React.useCallback(async () => {
    // The stored handle first, when there is one and permission is still
    // (or can still be) granted. It falls back to the picker for every
    // "no", which is the path Safari and Firefox always take.
    const fromHandle = await fileFromHandle(session)
    if (fromHandle) {
      void start(fromHandle)
      return
    }
    inputRef.current?.click()
  }, [session, start])

  const done = session.uploadedBytes
  const pct = session.fileSize > 0 ? Math.min(99, Math.round((done / session.fileSize) * 100)) : 0

  return (
    <div className="px-4 py-3 border-b border-border/50">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-text-tertiary">{getFileIcon(session.fileType)}</div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-text-primary truncate" title={session.fileName}>
            {session.fileName}
          </p>
          <p className="text-[11px] text-text-tertiary mt-0.5">
            {formatBytes(done)} of {formatBytes(session.fileSize)} uploaded ({pct}%)
          </p>
          <p className="text-[11px] text-text-tertiary mt-1">
            Select the same file to continue — only the missing parts are sent.
          </p>
          {error && <p className="text-[11px] text-error mt-1">{error}</p>}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onResume}
              disabled={busy}
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded bg-white/10 text-text-primary hover:bg-white/15 disabled:opacity-50 transition-colors"
            >
              <Upload className="h-3 w-3" />
              Resume
            </button>
            <button
              onClick={() => void discardInterrupted(session.uploadId)}
              disabled={busy}
              title="Discard this unfinished upload. The parts already uploaded are deleted."
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover disabled:opacity-50 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Discard
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Cleared so choosing the same file twice (after a mismatch
              // message, say) still fires a change event.
              e.target.value = ''
              if (file) void start(file)
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function UploadsPanel() {
  const { files, panelOpen, setPanelOpen, clearCompleted, fetchHistory, fetchMoreHistory, fetchProcessing, historyHasMore, historyLoading, interrupted, loadInterrupted } = useUploadStore()
  const [filter, setFilter] = React.useState<FilterTab>('all')
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  // Fetch backend history when panel opens
  //
  // §113 — plus everything still in flight, which the recency pages can miss
  // entirely: they load 20 at a time and only go further as the user scrolls,
  // so a still-processing asset with 20+ newer ones behind it never re-enters
  // the list after a reload. Not ordered relative to fetchHistory on purpose
  // — both merge through the same path, and whichever lands second simply
  // merges into the other's result.
  React.useEffect(() => {
    if (panelOpen) {
      fetchHistory()
      fetchProcessing()
    }
  }, [panelOpen, fetchHistory, fetchProcessing])

  // §213 — on ANY page load, not just when the panel opens.
  //
  // An interrupted upload is the one thing in here the user has to act on
  // for anything to happen: a browser cannot reopen the file by itself. If
  // it only appeared once the panel was open, the normal case — reload the
  // page, carry on working — would never show it at all.
  React.useEffect(() => {
    void loadInterrupted()
  }, [loadInterrupted])

  // Infinite scroll — IntersectionObserver on sentinel
  React.useEffect(() => {
    if (!panelOpen) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && historyHasMore && !historyLoading) {
          fetchMoreHistory()
        }
      },
      { root: scrollRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [panelOpen, historyHasMore, historyLoading, fetchMoreHistory])

  if (!panelOpen) return null

  // Sort descending by createdAt
  const sorted = [...files].sort((a, b) => b.createdAt - a.createdAt)
  const filtered = sorted.filter((f) => matchesFilter(f.status, filter))
  const groups = groupByDate(filtered)

  const counts = {
    all: files.length,
    active: files.filter((f) => f.status === 'pending' || f.status === 'uploading' || f.status === 'paused' || f.status === 'processing').length,
    complete: files.filter((f) => f.status === 'complete').length,
    failed: files.filter((f) => f.status === 'failed' || f.status === 'cancelled').length,
  }

  const tabs: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'active', label: 'Active', count: counts.active },
    { id: 'complete', label: 'Complete', count: counts.complete },
    { id: 'failed', label: 'Failed', count: counts.failed },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => setPanelOpen(false)}
      />

      {/* Panel */}
      <div className="fixed left-[52px] top-0 z-50 h-screen w-[380px] border-r border-border bg-bg-secondary shadow-2xl flex flex-col animate-in slide-in-from-left-4 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">
            Uploads
            {counts.active > 0 && (
              <span className="ml-1.5 text-xs font-normal text-accent">
                {counts.active} active
              </span>
            )}
          </h2>
          <div className="flex items-center gap-1">
            {counts.complete > 0 && (
              <button
                onClick={clearCompleted}
                className="text-xs text-text-tertiary hover:text-text-secondary transition-colors px-2 py-1 rounded hover:bg-bg-hover"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setPanelOpen(false)}
              className="h-7 w-7 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="px-3 pt-2.5 pb-1 shrink-0">
          <div className="flex items-center bg-white/5 rounded-lg p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={cn(
                  'flex-1 py-1.5 text-[11px] font-medium rounded-md transition-all',
                  filter === tab.id
                    ? 'bg-white/10 text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={cn(
                    'ml-1 text-[10px]',
                    filter === tab.id ? 'text-text-secondary' : 'text-text-quaternary',
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {/* §213 — above the list and above the empty state, because this
              is the only section that needs the user to do something, and
              an unfinished 97 GiB upload is not a footnote. */}
          {interrupted.length > 0 && (
            <div className="border-b border-border bg-warning/5">
              <div className="px-4 pt-3 pb-1">
                <span className="text-[10px] font-medium text-warning uppercase tracking-wider">
                  {interrupted.length === 1
                    ? '1 unfinished upload'
                    : `${interrupted.length} unfinished uploads`}
                </span>
              </div>
              {interrupted.map((session) => (
                <InterruptedItem key={session.uploadId} session={session} />
              ))}
            </div>
          )}

          {filtered.length === 0 && !historyLoading && interrupted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center mb-3">
                <FileIcon className="h-6 w-6 text-text-tertiary" />
              </div>
              <p className="text-sm text-text-secondary">
                {filter === 'all' ? 'No uploads yet' : `No ${filter} uploads`}
              </p>
              <p className="text-xs text-text-tertiary mt-1">
                {filter === 'all'
                  ? 'Upload files from any project to track them here.'
                  : 'Items will appear here as uploads progress.'}
              </p>
            </div>
          ) : (
            <>
              {groups.map((group) => (
                <div key={group.label}>
                  <div className="px-4 pt-4 pb-1">
                    <span className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                      {group.label}
                    </span>
                  </div>
                  {group.items.map((upload) => (
                    <UploadItem key={upload.id} upload={upload} />
                  ))}
                </div>
              ))}

              {/* Sentinel for infinite scroll + loading indicator */}
              <div ref={sentinelRef} className="h-1" />
              {historyLoading && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
