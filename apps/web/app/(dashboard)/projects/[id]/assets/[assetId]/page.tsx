'use client'

import { useState, useEffect, useMemo, useRef, type ElementType, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ReviewProvider, useReview } from '@/components/review/review-provider'
import { VideoPlayer } from '@/components/review/video-player'
import { AudioPlayer } from '@/components/review/audio-player'
import { ImageViewer } from '@/components/review/image-viewer'
import { StatusDropdown } from '@/components/shared/status-dropdown'
import { StarRating } from '@/components/shared/star-rating'
import { Avatar } from '@/components/shared/avatar'
import { AnnotationCanvas } from '@/components/review/annotation-canvas'
import { AnnotationOverlay } from '@/components/review/annotation-overlay'
import { CommentPanel } from '@/components/review/comment-panel'
import { CommentInput } from '@/components/review/comment-input'
import { CustomFieldInput } from '@/components/projects/asset-metadata'
// ApprovalBar removed for now
import { VersionSwitcher } from '@/components/review/version-switcher'
import { ShareDialog } from '@/components/review/share-dialog'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import type { CommentWithReplies } from '@/hooks/use-comments'
import { api, ApiError } from '@/lib/api'
import { useUploadStore } from '@/stores/upload-store'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Info,
  Loader2,
  Columns2,
  Upload,
  FileText,
  Tag,
  CircleDot,
  Star,
  GitBranch,
  Activity,
    MessageSquare,
  Clock,
  HardDrive,
  Timer,
  Gauge,
  File as FileIcon,
  User as UserIcon,
  Pencil,
  CalendarDays,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatBytes, formatRelativeTime, formatTime } from '@/lib/utils'
import { usePageTitle } from '@/hooks/use-page-title'
import type {
  Project,
  AssetResponse,
  ProjectMember,
  FolderTreeNode,
  AssetStatus,
  User,
  TechnicalMetadata,
  MetadataField,
  AssetMetadata,
} from '@/types'

interface VoteEntry {
  user_id: string
  name: string
  avatar_url: string | null
  stars: number
  created_at: string | null
}

function countAllComments(list: CommentWithReplies[]): number {
  return list.reduce((sum, c) => sum + 1 + countAllComments(c.replies ?? []), 0)
}

function FieldRow({
  icon: Icon,
  label,
  children,
}: {
  icon: ElementType
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/60 last:border-0">
      <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="text-xs text-text-primary font-medium text-right min-w-0 truncate">
        {children}
      </span>
    </div>
  )
}

function VoteBreakdown({ voters }: { voters: VoteEntry[] }) {
  if (voters.length === 0) return null

  const row = (v: VoteEntry) => (
    <div key={v.user_id} className="flex items-center justify-between gap-2 px-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Avatar src={v.avatar_url} name={v.name} size="sm" />
        <span className="text-xs text-text-primary truncate">{v.name}</span>
      </div>
      <StarRating value={v.stars} readOnly size="sm" />
    </div>
  )

  if (voters.length <= 5) {
    return (
      <div className="mt-1.5 rounded-md border border-border/60 divide-y divide-border/60">
        {voters.map(row)}
      </div>
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="mt-1.5 w-full flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
          <span>Show all {voters.length} ratings</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[100] w-64 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1 divide-y divide-border/60"
        >
          {voters.map(row)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function AssigneePicker({
  users,
  value,
  onChange,
  disabled,
}: {
  users: User[]
  value: string | null
  onChange: (userId: string | null) => void
  disabled: boolean
}) {
  const current = value ? users.find((u) => u.id === value) : null

  if (disabled) {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        {current && <Avatar src={current.avatar_url} name={current.name} size="sm" className="h-5 w-5" />}
        <span className="text-xs text-text-primary font-medium truncate">{current?.name ?? '—'}</span>
      </span>
    )
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-0 rounded-md border border-border h-7 px-2 text-2xs text-text-primary hover:bg-bg-hover transition-colors"
        >
          {current ? (
            <>
              <Avatar src={current.avatar_url} name={current.name} size="sm" className="h-4 w-4" />
              <span className="truncate max-w-[100px]">{current.name}</span>
            </>
          ) : (
            <span className="text-text-tertiary">Unassigned</span>
          )}
          <ChevronDown className="h-3 w-3 text-text-tertiary shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[100] w-56 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1"
        >
          <DropdownMenu.Item
            onSelect={() => onChange(null)}
            className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-secondary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
          >
            Unassigned
          </DropdownMenu.Item>
          {users.map((u) => (
            <DropdownMenu.Item
              key={u.id}
              onSelect={() => onChange(u.id)}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
            >
              <Avatar src={u.avatar_url} name={u.name} size="sm" className="h-5 w-5" />
              <span className="truncate">{u.name}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function formatCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—'
  return String(value)
}

function formatBitrate(bps?: number | null): string | null {
  if (!bps) return null
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`
  return `${bps} bps`
}

function formatSampleRate(hz?: number | null): string | null {
  if (!hz) return null
  return `${(hz / 1000).toFixed(1)} kHz`
}

const TECHNICAL_METADATA_FIELDS: Array<{
  key: keyof TechnicalMetadata
  label: string
  format?: (v: any) => string
}> = [
  { key: 'video_codec', label: 'Video codec' },
  { key: 'video_bit_rate', label: 'Video bitrate', format: (v) => formatBitrate(v) ?? String(v) },
  { key: 'visual_bit_depth', label: 'Bit depth', format: (v) => `${v}-bit` },
  { key: 'alpha_channel', label: 'Alpha channel', format: (v) => (v ? 'Yes' : 'No') },
  { key: 'color_space', label: 'Color space' },
  { key: 'dynamic_range', label: 'Dynamic range' },
  { key: 'audio_codec', label: 'Audio codec' },
  { key: 'audio_bit_rate', label: 'Audio bitrate', format: (v) => formatBitrate(v) ?? String(v) },
  { key: 'audio_bit_depth', label: 'Audio bit depth', format: (v) => `${v}-bit` },
  { key: 'audio_channels', label: 'Audio channels' },
  { key: 'audio_sample_rate', label: 'Audio sample rate', format: (v) => formatSampleRate(v) ?? String(v) },
]

function TechnicalMetadataList({ metadata }: { metadata: TechnicalMetadata }) {
  const rows = TECHNICAL_METADATA_FIELDS
    .filter((f) => metadata[f.key] !== undefined && metadata[f.key] !== null)
    .map((f) => ({
      label: f.label,
      value: f.format ? f.format(metadata[f.key]) : String(metadata[f.key]),
    }))

  if (rows.length === 0) return null

  return (
    <div className="mt-1.5 rounded-md border border-border/60 divide-y divide-border/60">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
          <span className="text-xs text-text-tertiary">{r.label}</span>
          <span className="text-xs text-text-primary font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// Inline rename control for the Fields tab header — same optimistic-update
// shape as handleStatusChange (parent owns the state/API call; this is
// presentational). Falls back to a plain label when the viewer can't edit.
function EditableAssetName({
  name,
  canEdit,
  onSave,
}: {
  name: string
  canEdit: boolean
  onSave: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(name)
  }, [name])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) {
      onSave(trimmed)
    } else {
      setDraft(name)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(name)
            setEditing(false)
          }
        }}
        className="flex-1 min-w-0 bg-transparent border-b border-border text-sm font-medium text-text-primary focus:outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      disabled={!canEdit}
      onClick={() => canEdit && setEditing(true)}
      className={cn('group flex items-center gap-1.5 min-w-0 text-left', canEdit && 'cursor-text')}
    >
      <span className="text-sm font-medium text-text-primary truncate">{name}</span>
      {canEdit && (
        <Pencil className="h-3 w-3 text-text-tertiary opacity-0 group-hover:opacity-100 shrink-0" />
      )}
    </button>
  )
}

const acceptByType: Record<string, string> = {
  video: 'video/*',
  audio: 'audio/*',
  image: 'image/*',
  image_carousel: 'image/*',
}

function ReviewScreenInner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { asset, versions, isLoading, refetchComments, refetchVersions } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, seekTo, setFocusedCommentId, setActiveAnnotation } = useReviewStore()
  const { user, isSuperAdmin } = useAuthStore()
  const startVersionUpload = useUploadStore((s) => s.startVersionUpload)
  const versionFileInputRef = useRef<HTMLInputElement>(null)
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs)
  const setLabel = useBreadcrumbStore((s) => s.setLabel)
  usePageTitle(asset?.name ?? null)
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [activeTab, setActiveTab] = useState<'comments' | 'fields'>('comments')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const deepLinkApplied = useRef(false)

  // Fetch folder tree to build the folder path for the breadcrumb
  const { data: folderTree } = useSWR<FolderTreeNode[]>(
    asset ? `/projects/${projectId}/folder-tree` : null,
    () => api.get<FolderTreeNode[]>(`/projects/${projectId}/folder-tree`),
  )

  // Set extra crumbs = [folder path..., asset name]
  // Don't register asset UUID as a label — use extraCrumbs for correct ordering
  useEffect(() => {
    if (!asset?.name) return

    function findPath(
      nodes: FolderTreeNode[],
      targetId: string,
      trail: { id: string; name: string }[],
    ): { id: string; name: string }[] | null {
      for (const node of nodes) {
        const next = [...trail, { id: node.id, name: node.name }]
        if (node.id === targetId) return next
        const found = findPath(node.children, targetId, next)
        if (found) return found
      }
      return null
    }

    const folderPath = asset.folder_id && folderTree
      ? (findPath(folderTree, asset.folder_id, []) ?? [])
      : []

    setExtraCrumbs([
      ...folderPath.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` })),
      { label: asset.name }, // asset name — no href (current page)
    ])
  }, [asset?.id, asset?.name, asset?.folder_id, folderTree, setExtraCrumbs])

  // Fetch project info for breadcrumb + register project name as label
  const { data: project } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )
  useEffect(() => {
    if (project?.name) setLabel(projectId, project.name)
  }, [project?.name, projectId, setLabel])

  // Role-based permissions
  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )
  // Project member user records, for the assignee picker in the Fields tab
  const memberIds = useMemo(() => (members ?? []).map((m) => m.user_id), [members])
  const { data: memberUsers } = useSWR<User[]>(
    memberIds.length > 0 ? `/users?ids=${memberIds.join(',')}` : null,
    (key: string) => api.get<User[]>(key),
  )

  const currentMember = members?.find((m) => m.user_id === user?.id)
  const currentRole = currentMember?.role ?? 'viewer'
  const canComment = currentRole !== 'viewer'
  const canVote = currentRole !== 'viewer'
  const canEditStatus = currentRole === 'owner' || currentRole === 'editor'
  const canArchive = isSuperAdmin
  // Who can manually restart a stuck/failed version — the person who
  // uploaded it, the project owner, or a superadmin. Not opened up to
  // editors in general since it dispatches a real transcode job.
  const canRetryProcessing = Boolean(
    currentVersion && (isSuperAdmin || currentRole === 'owner' || currentVersion.created_by === user?.id),
  )

  const [statusOverride, setStatusOverride] = useState<AssetStatus | null>(null)
  useEffect(() => {
    setStatusOverride(null)
  }, [asset?.id])
  const displayStatus = statusOverride ?? asset?.status

  async function handleStatusChange(newStatus: AssetStatus) {
    if (!asset) return
    const previous = displayStatus
    setStatusOverride(newStatus)
    try {
      await api.patch(`/assets/${asset.id}`, { status: newStatus })
    } catch {
      setStatusOverride(previous ?? null)
    }
  }

  // Asset name override — same optimistic-update shape as statusOverride
  // above. Gated by canEditStatus: renaming is an asset-mutation action,
  // same permission bar already used for status changes in this file.
  const [nameOverride, setNameOverride] = useState<string | null>(null)
  useEffect(() => {
    setNameOverride(null)
  }, [asset?.id])
  const displayName = nameOverride ?? asset?.name

  async function handleRenameAsset(newName: string) {
    if (!asset) return
    const previous = displayName
    setNameOverride(newName)
    try {
      await api.patch(`/assets/${asset.id}`, { name: newName })
    } catch {
      setNameOverride(previous ?? null)
    }
  }

  // Expand/collapse for the full technical_metadata list in the Fields tab
  const [showAllFields, setShowAllFields] = useState(false)
  useEffect(() => {
    setShowAllFields(false)
  }, [asset?.id])

  // Rating state — overrides the value embedded in `asset` once the user rates it
  const [ratingState, setRatingState] = useState<{ avg_rating: number | null; rating_count: number; my_rating: number | null } | null>(null)
  useEffect(() => {
    setRatingState(null)
  }, [asset?.id])
  const avgRating = ratingState?.avg_rating ?? asset?.avg_rating ?? null
  const ratingCount = ratingState?.rating_count ?? asset?.rating_count ?? 0
  const myRating = ratingState?.my_rating ?? asset?.my_rating ?? null

  async function handleRate(stars: number) {
    if (!asset) return
    try {
      const result = await api.post<{ avg_rating: number | null; rating_count: number; my_rating: number | null }>(
        `/assets/${asset.id}/vote`,
        { stars },
      )
      setRatingState(result)
    } catch {
      // no-op — leave state as-is on failure
    }
  }

  // Due date / assignee / keywords — same optimistic-override shape as
  // statusOverride/nameOverride above. `undefined` means "no override yet,
  // defer to `asset`"; unlike statusOverride these fields can legitimately
  // be null (unassigned/no due date), so `??` alone can't distinguish an
  // explicit-null override from "no override" — hence the undefined sentinel.
  const [dueDateOverride, setDueDateOverride] = useState<string | null | undefined>(undefined)
  const [assigneeOverride, setAssigneeOverride] = useState<string | null | undefined>(undefined)
  const [keywordsOverride, setKeywordsOverride] = useState<string[] | undefined>(undefined)
  useEffect(() => {
    setDueDateOverride(undefined)
    setAssigneeOverride(undefined)
    setKeywordsOverride(undefined)
  }, [asset?.id])
  const displayDueDate = dueDateOverride !== undefined ? dueDateOverride : (asset?.due_date ?? null)
  const displayAssigneeId = assigneeOverride !== undefined ? assigneeOverride : (asset?.assignee_id ?? null)
  const displayKeywords = keywordsOverride !== undefined ? keywordsOverride : (asset?.keywords ?? [])
  const [keywordInput, setKeywordInput] = useState('')

  async function handleDueDateChange(newDate: string) {
    if (!asset) return
    const previous = displayDueDate
    const value = newDate || null
    setDueDateOverride(value)
    try {
      await api.patch(`/assets/${asset.id}/assignment`, { due_date: value })
    } catch {
      setDueDateOverride(previous)
    }
  }

  async function handleAssigneeChange(newAssigneeId: string | null) {
    if (!asset) return
    const previous = displayAssigneeId
    setAssigneeOverride(newAssigneeId)
    try {
      await api.patch(`/assets/${asset.id}/assignment`, { assignee_id: newAssigneeId })
    } catch {
      setAssigneeOverride(previous)
    }
  }

  async function saveKeywords(newKeywords: string[]) {
    if (!asset) return
    const previous = displayKeywords
    setKeywordsOverride(newKeywords)
    try {
      await api.patch(`/assets/${asset.id}`, { keywords: newKeywords })
    } catch {
      setKeywordsOverride(previous)
    }
  }

  function handleAddKeyword() {
    const kw = keywordInput.trim()
    if (kw && !displayKeywords.includes(kw)) {
      saveKeywords([...displayKeywords, kw])
      setKeywordInput('')
    }
  }

  function handleRemoveKeyword(kw: string) {
    saveKeywords(displayKeywords.filter((k) => k !== kw))
  }

  // Project-defined custom metadata fields (Settings-managed schema) + this
  // asset's current values for them. Saved individually via PUT
  // /assets/{id}/metadata, debounced per-field so free-text/number inputs
  // don't fire a request per keystroke.
  const { data: metadataFields } = useSWR<MetadataField[]>(
    `/projects/${projectId}/metadata-fields`,
    () => api.get<MetadataField[]>(`/projects/${projectId}/metadata-fields`),
  )
  const { data: assetMetadata } = useSWR<AssetMetadata[]>(
    asset ? `/assets/${asset.id}/metadata` : null,
    () => api.get<AssetMetadata[]>(`/assets/${asset.id}/metadata`),
  )
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({})
  useEffect(() => {
    if (assetMetadata) {
      const map: Record<string, unknown> = {}
      for (const m of assetMetadata) map[m.field_id] = m.value
      setCustomValues(map)
    }
  }, [assetMetadata])

  const customFieldTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => {
    const timers = customFieldTimers.current
    return () => {
      Object.values(timers).forEach(clearTimeout)
    }
  }, [asset?.id])

  function handleCustomFieldChange(fieldId: string, value: unknown) {
    setCustomValues((prev) => ({ ...prev, [fieldId]: value }))
    if (customFieldTimers.current[fieldId]) clearTimeout(customFieldTimers.current[fieldId])
    customFieldTimers.current[fieldId] = setTimeout(() => {
      if (!asset) return
      api.put(`/assets/${asset.id}/metadata`, [{ field_id: fieldId, value }]).catch(() => {})
    }, 600)
  }

  // Manual restart for a version stuck in 'processing' or that ended
  // 'failed' — see the backend endpoint for the elapsed-time guard against
  // double-dispatching a still-running transcode.
  const [retryingVersion, setRetryingVersion] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  async function handleRetryProcessing() {
    if (!asset || !currentVersion) return
    setRetryingVersion(true)
    setRetryError(null)
    try {
      await api.post(`/assets/${asset.id}/versions/${currentVersion.id}/retry-processing`, {})
      await refetchVersions()
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.detail : 'Failed to restart processing')
    } finally {
      setRetryingVersion(false)
    }
  }

  // Fetch all assets for navigation (1 of N)
  const { data: allAssets } = useSWR<AssetResponse[]>(
    `/projects/${projectId}/assets`,
    () => api.get<AssetResponse[]>(`/projects/${projectId}/assets`),
  )

  const {
    comments,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '')

  // Voter breakdown (who voted, how many stars each) — Fields tab
  const { data: voters } = useSWR<VoteEntry[]>(
    asset && ratingCount > 0 ? `/assets/${asset.id}/votes` : null,
    (key: string) => api.get<VoteEntry[]>(key),
  )

  // Uploader name for the Fields tab (asset.created_by is just a user id)
  const { data: uploaderUsers } = useSWR<User[]>(
    asset ? `/users?ids=${asset.created_by}` : null,
    (key: string) => api.get<User[]>(key),
  )
  const uploaderName = uploaderUsers?.[0]?.name ?? null

  const commentCount = countAllComments(comments)
  const primaryFile = currentVersion?.files?.[0]
  const totalFileSize = (currentVersion?.files ?? []).reduce((sum, f) => sum + (f.file_size_bytes || 0), 0)

  // Condensed resolution/codec/bitrate line under the header name — only
  // populates once ffprobe metadata exists (older assets predate the column).
  const tm = primaryFile?.technical_metadata
  const summaryParts = [
    primaryFile?.width != null && primaryFile?.height != null ? `${primaryFile.width}×${primaryFile.height}` : null,
    tm?.video_codec ?? tm?.audio_codec ?? null,
    formatBitrate(tm?.video_bit_rate ?? tm?.audio_bit_rate),
  ].filter(Boolean) as string[]

  // Deep-link to a specific comment from notification (?commentId=...)
  // Runs once after comments are loaded — seeks to timecode, focuses comment, shows annotation
  useEffect(() => {
    const commentId = searchParams.get('commentId')
    if (!commentId || deepLinkApplied.current || comments.length === 0) return
    const target = comments.find((c: any) => c.id === commentId)
    if (!target) return
    deepLinkApplied.current = true
    setFocusedCommentId(commentId)
    setActiveTab('comments')
    if ((target as any).timecode_start !== null && (target as any).timecode_start !== undefined) {
      seekTo((target as any).timecode_start, true)
    }
    if ((target as any).annotation?.drawing_data) {
      setActiveAnnotation((target as any).annotation.drawing_data)
    }
  }, [comments, searchParams, seekTo, setFocusedCommentId, setActiveAnnotation])

  // Asset navigation
  const currentIndex = allAssets?.findIndex((a) => a.id === asset?.id) ?? -1
  const totalAssets = allAssets?.length ?? 0
  const prevAsset = currentIndex > 0 ? allAssets?.[currentIndex - 1] : null
  const nextAsset = currentIndex < totalAssets - 1 ? allAssets?.[currentIndex + 1] : null

  const navigateAsset = (assetId: string) => {
    router.push(`/projects/${projectId}/assets/${assetId}`)
  }

  // Keyboard navigation for prev/next asset
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft' && prevAsset) {
        e.preventDefault()
        navigateAsset(prevAsset.id)
      }
      if (e.key === 'ArrowRight' && nextAsset) {
        e.preventDefault()
        navigateAsset(nextAsset.id)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [prevAsset, nextAsset])

  if (isLoading || !asset) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-text-tertiary">Loading asset...</span>
        </div>
      </div>
    )
  }

  const handleSubmitComment = async (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotation?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ) => {
    await createComment(
      body,
      timecodeStart,
      timecodeEnd,
      annotation || annotationData || undefined,
      parentId,
      visibility,
      mentionUserIds,
    )
    setAnnotationData(null)
    refetchComments()
  }

  const handleSubmitReply = async (parentId: string, body: string) => {
    await createComment(body, undefined, undefined, undefined, parentId)
    refetchComments()
  }

  const versionReady = currentVersion?.processing_status === 'ready'
  const versionProcessing =
    currentVersion?.processing_status === 'processing' ||
    currentVersion?.processing_status === 'uploading'
  // Past this, a legitimately-running transcode is very unlikely to still
  // be mid-flight — matches STUCK_PROCESSING_THRESHOLD_SECONDS server-side.
  const versionStuckProcessing =
    currentVersion?.processing_status === 'processing' &&
    Date.now() - new Date(currentVersion.created_at).getTime() > 30 * 60 * 1000

  const renderMediaViewer = () => {
    if (!currentVersion || !versionReady) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            {versionProcessing ? (
              <>
                <div className="h-12 w-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing asset</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This may take a few minutes depending on file size.
                  </p>
                </div>
                {versionStuckProcessing && canRetryProcessing && (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-xs text-text-tertiary">
                      Taking much longer than usual? The worker may have died mid-task.
                    </p>
                    <button
                      onClick={handleRetryProcessing}
                      disabled={retryingVersion}
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                    >
                      {retryingVersion ? 'Restarting…' : 'Restart processing'}
                    </button>
                    {retryError && <p className="text-xs text-status-error">{retryError}</p>}
                  </div>
                )}
              </>
            ) : currentVersion?.processing_status === 'failed' ? (
              <>
                <div className="h-12 w-12 rounded-full bg-status-error/10 flex items-center justify-center">
                  <Info className="h-6 w-6 text-status-error" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing failed</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    Try uploading a new version of this asset{canRetryProcessing ? ', or restart processing on this one' : ''}.
                  </p>
                </div>
                {canRetryProcessing && (
                  <div className="flex flex-col items-center gap-2">
                    <button
                      onClick={handleRetryProcessing}
                      disabled={retryingVersion}
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                    >
                      {retryingVersion ? 'Restarting…' : 'Restart processing'}
                    </button>
                    {retryError && <p className="text-xs text-status-error">{retryError}</p>}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center">
                  <Info className="h-6 w-6 text-text-tertiary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Version not ready</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This version is still being prepared.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )
    }

    switch (asset.asset_type) {
      case 'video':
        return (
          <VideoPlayer
            assetId={asset.id}
            comments={comments}
            className="flex-1 min-h-0"
            overlay={
              <>
                <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                {isDrawingMode && (
                  <AnnotationCanvas
                    onSave={(data) => setAnnotationData(data)}
                  />
                )}
              </>
            }
          />
        )
      case 'audio':
        return (
          <AudioPlayer
            asset={asset}
            version={currentVersion}
            comments={comments}
            className="flex-1"
          />
        )
      case 'image':
      case 'image_carousel':
        return (
          <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
            <ImageViewer
              asset={asset}
              version={currentVersion as any}
              annotationCanvas={
                <>
                  <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                  {isDrawingMode && (
                    <AnnotationCanvas
                      onSave={(data) => setAnnotationData(data)}
                    />
                  )}
                </>
              }
            />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* ─── Top bar (Frame.io style) ──────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        {/* Left: back + breadcrumb */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <Link
            href={`/projects/${asset.project_id}`}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          {/* Asset name only */}
          <span className="text-[13px] text-text-primary font-medium truncate">
            {asset.name}
          </span>
        </div>

        {/* Center: asset navigation */}
        {totalAssets > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => prevAsset && navigateAsset(prevAsset.id)}
              disabled={!prevAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous asset (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-text-secondary tabular-nums px-1">
              {currentIndex + 1} of {totalAssets}
            </span>
            <button
              onClick={() => nextAsset && navigateAsset(nextAsset.id)}
              disabled={!nextAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next asset (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Right: version, share, sidebar toggle */}
        <div className="flex items-center gap-2 shrink-0 flex-1 justify-end">
          {/* Hidden file input for new version upload */}
          <input
            ref={versionFileInputRef}
            type="file"
            className="hidden"
            accept={acceptByType[asset.asset_type] ?? '*/*'}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file || !asset) return
              startVersionUpload(file, asset.id, asset.name, asset.project_id)
              e.target.value = ''
              // Refetch versions after a short delay to show the new uploading version
              setTimeout(() => refetchVersions(), 800)
            }}
          />
          <VersionSwitcher versions={versions} />
          <button
            onClick={() => versionFileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Upload new version"
          >
            <Upload className="h-3.5 w-3.5" />
            New Version
          </button>
          {displayStatus && (
            <StatusDropdown
              status={displayStatus}
              onChange={canEditStatus ? handleStatusChange : undefined}
              readOnly={!canEditStatus}
              canArchive={canArchive}
              className={
                canEditStatus
                  ? 'bg-transparent border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors'
                  : undefined
              }
            />
          )}
          {(canVote || ratingCount > 0) && (
            <div className="inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 border border-border">
              <StarRating
                value={myRating}
                onChange={canVote ? handleRate : undefined}
                readOnly={!canVote}
                size="sm"
              />
              {ratingCount > 0 && (
                <span className="text-xs text-text-secondary tabular-nums">{avgRating?.toFixed(1)}</span>
              )}
            </div>
          )}
          <ShareDialog assetId={asset.id} assetName={asset.name} projectId={projectId} asset={asset} />
          <button
            onClick={() => setSidebarOpen((p) => !p)}
            className={cn(
              'flex items-center justify-center h-8 w-8 rounded-md transition-colors',
              sidebarOpen
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
            title="Toggle sidebar"
          >
            <Columns2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Main content: viewer + sidebar ────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: viewer column */}
        <div className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0">
          {/* Media viewer */}
          {renderMediaViewer()}
        </div>

        {/* Right: comments sidebar */}
        {sidebarOpen && (
          <div className="w-[360px] flex flex-col border-l border-border bg-bg-secondary shrink-0 animate-in slide-in-from-right-2 duration-150">
            {/* Tabs (Frame.io pill style) */}
            <div className="px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center bg-bg-tertiary rounded-lg p-0.5">
                <button
                  onClick={() => setActiveTab('comments')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'comments'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Comments
                </button>
                <button
                  onClick={() => setActiveTab('fields')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'fields'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Fields
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {activeTab === 'comments' ? (
                <>
                  <CommentPanel
                    comments={comments as any}
                    currentUserId={user?.id}
                    onResolve={resolveComment}
                    onDelete={deleteComment}
                    onAddReaction={addReaction}
                    onRemoveReaction={removeReaction}
                    onReply={() => {}}
                    onSubmitReply={handleSubmitReply}
                  />
                  {canComment && (
                    <CommentInput
                      assetId={asset.id}
                      projectId={asset.project_id}
                      assetType={asset.asset_type}
                      onSubmit={handleSubmitComment}
                      annotationData={annotationData}
                  />
                  )}
                </>
              ) : (
                <div className="flex-1 overflow-y-auto p-4">
                  <div>
                    <div className="pb-3 mb-1 border-b border-border/60">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
                        <EditableAssetName
                          name={displayName ?? ''}
                          canEdit={canEditStatus}
                          onSave={handleRenameAsset}
                        />
                      </div>
                      {summaryParts.length > 0 && (
                        <p className="mt-1 pl-5 text-2xs text-text-tertiary">{summaryParts.join(' · ')}</p>
                      )}
                    </div>
                    <FieldRow icon={Tag} label="Type">
                      <span className="capitalize">{asset.asset_type.replace('_', ' ')}</span>
                    </FieldRow>

                    {/* Status — same control as the toolbar, compact */}
                    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/60">
                      <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0">
                      <CircleDot className="h-3.5 w-3.5" />
                        Status
                    </span>
                      {displayStatus && (
                        <StatusDropdown
                          status={displayStatus}
                          onChange={canEditStatus ? handleStatusChange : undefined}
                          readOnly={!canEditStatus}
                          canArchive={canArchive}
                          className={canEditStatus ? 'h-7 px-2 text-2xs bg-transparent border-border' : 'h-6 px-2'}
                        />
                    )}
                    </div>

                    {/* Rating + per-voter breakdown — hidden entirely for users
                      with no access at all (e.g. viewers); reviewers still
                      see their own vote (canVote) but never the aggregate,
                      which stays gated behind ratingCount from the backend. */}
                    {(canVote || ratingCount > 0) && (
                      <div className="py-2 border-b border-border/60">
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0">
                          <Star className="h-3.5 w-3.5" />
                            Rating
                        </span>
                          <div className="flex items-center gap-1.5">
                            <StarRating
                              value={myRating}
                              onChange={canVote ? handleRate : undefined}
                            readOnly={!canVote}
                            size="sm"
                          />
                            {ratingCount > 0 && (
                              <span className="text-xs text-text-secondary tabular-nums">{avgRating?.toFixed(1)}</span>
                          )}
                        </div>
                        </div>
                      {ratingCount > 0 && <VoteBreakdown voters={voters ?? []} />}
                    </div>
                    )}

                    {/* Assignee */}
                    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/60">
                      <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0">
                        <UserIcon className="h-3.5 w-3.5" />
                        Assignee
                      </span>
                      <AssigneePicker
                        users={memberUsers ?? []}
                        value={displayAssigneeId}
                        onChange={handleAssigneeChange}
                        disabled={!canEditStatus}
                      />
                    </div>

                    {/* Due date */}
                    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/60">
                      <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0">
                        <CalendarDays className="h-3.5 w-3.5" />
                        Due Date
                      </span>
                      {canEditStatus ? (
                        <input
                          type="date"
                          value={displayDueDate ? displayDueDate.slice(0, 10) : ''}
                          onChange={(e) => handleDueDateChange(e.target.value)}
                          className="h-7 rounded-md border border-border bg-transparent px-2 text-2xs text-text-primary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
                        />
                      ) : (
                        <span className="text-xs text-text-primary font-medium">
                          {displayDueDate ? new Date(displayDueDate).toLocaleDateString() : '—'}
                        </span>
                      )}
                    </div>

                    {/* Keywords */}
                    <div className="py-2 border-b border-border/60">
                      <span className="flex items-center gap-2 text-xs text-text-tertiary shrink-0 mb-1.5">
                        <Tag className="h-3.5 w-3.5" />
                        Keywords
                      </span>
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {displayKeywords.length === 0 && (
                          <span className="text-xs text-text-primary">—</span>
                        )}
                        {displayKeywords.map((kw) => (
                          <span
                            key={kw}
                            className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary border border-border px-2 py-0.5 text-2xs text-text-secondary"
                          >
                            {kw}
                            {canEditStatus && (
                              <button
                                type="button"
                                onClick={() => handleRemoveKeyword(kw)}
                                className="text-text-tertiary hover:text-text-primary transition-colors"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                      {canEditStatus && (
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={keywordInput}
                            onChange={(e) => setKeywordInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                handleAddKeyword()
                              }
                            }}
                            placeholder="Add keyword..."
                            className="flex h-7 flex-1 min-w-0 rounded-md border border-border bg-transparent px-2 text-2xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
                          />
                          <button
                            type="button"
                            onClick={handleAddKeyword}
                            className="h-7 px-2 rounded-md border border-border text-2xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
                          >
                            Add
                          </button>
                        </div>
                      )}
                    </div>

                    {currentVersion && (
                      <FieldRow icon={GitBranch} label="Version">v{currentVersion.version_number}</FieldRow>
                    )}
                    {currentVersion && (
                      <FieldRow icon={Activity} label="Processing">
                        <span className={cn(
                          'capitalize',
                          currentVersion.processing_status === 'ready' && 'text-status-success',
                          currentVersion.processing_status === 'processing' && 'text-status-warning',
                          currentVersion.processing_status === 'failed' && 'text-status-error',
                        currentVersion.processing_status === 'uploading' && 'text-text-tertiary',
                      )}>
                          {currentVersion.processing_status}
                      </span>
                      </FieldRow>
                    )}
                    <FieldRow icon={MessageSquare} label="Comments">{commentCount}</FieldRow>
                    <FieldRow icon={Clock} label="Uploaded">{formatRelativeTime(asset.created_at)}</FieldRow>
                    <FieldRow icon={UserIcon} label="Uploaded by">{uploaderName ?? '—'}</FieldRow>
                    {totalFileSize > 0 && (
                      <FieldRow icon={HardDrive} label="File size">{formatBytes(totalFileSize)}</FieldRow>
                    )}
                    {primaryFile?.duration_seconds != null && (
                      <FieldRow icon={Timer} label="Duration">{formatTime(primaryFile.duration_seconds)}</FieldRow>
                    )}
                    {primaryFile?.fps != null && (
                      <FieldRow icon={Gauge} label="Frame rate">{primaryFile.fps} fps</FieldRow>
                    )}
                    {primaryFile?.original_filename && (
                      <FieldRow icon={FileIcon} label="Source filename">{primaryFile.original_filename}</FieldRow>
                    )}

                    {primaryFile?.technical_metadata &&
                      Object.values(primaryFile.technical_metadata).some((v) => v !== undefined && v !== null) && (
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => setShowAllFields((v) => !v)}
                            className="w-full flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                          >
                            <span>{showAllFields ? 'Hide' : 'Show'} all fields</span>
                            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAllFields && 'rotate-180')} />
                          </button>
                          {showAllFields && <TechnicalMetadataList metadata={primaryFile.technical_metadata} />}
                        </div>
                      )}

                    {/* Custom project-defined fields */}
                    {metadataFields && metadataFields.length > 0 && (
                      <div className="pt-3 mt-2 border-t border-border">
                        <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wide mb-2">
                          Custom Fields
                        </p>
                        <div className="space-y-3">
                          {metadataFields.map((field) => (
                            <div key={field.id} className="flex flex-col gap-1.5">
                              <label className="text-xs text-text-secondary flex items-center gap-1">
                                {field.name}
                                {field.required && <span className="text-status-error">*</span>}
                              </label>
                              {canEditStatus ? (
                                <CustomFieldInput
                                  field={field}
                                  value={customValues[field.id]}
                                  onChange={(v) => handleCustomFieldChange(field.id, v)}
                                />
                              ) : (
                                <span className="text-xs text-text-primary">
                                  {formatCustomFieldValue(customValues[field.id])}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ReviewPage({
     params,
}: {
  params: { id: string; assetId: string }
}) {
  const { id: projectId, assetId } = params

  return (
    <ReviewProvider assetId={assetId}>
      <ReviewScreenInner projectId={projectId} />
    </ReviewProvider>
  )
}
