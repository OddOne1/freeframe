'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { AssetMenuItems } from './asset-menu-items'
import { Film, Music, Image as ImageIcon, Images, MessageSquare, MoreHorizontal, Check, Share2, Download, Link as LinkIcon, Pencil, Trash2, Folder as FolderIcon } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes } from '@/lib/utils'
import { StarRating } from '@/components/shared/star-rating'
import type { Asset, AssetType, User } from '@/types'
import type { AspectRatio, ThumbnailScale, TitleLines } from '@/stores/view-store'

const assetTypeIcons: Record<AssetType, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
}

const aspectMap = {
  landscape: 'aspect-[16/10]',
  square: 'aspect-square',
  portrait: 'aspect-[3/4]',
}

interface AssetCardProps {
  asset: Asset
  projectId: string
  versionCount?: number
  assignee?: User | null
  authorName?: string
  thumbnailUrl?: string | null
  commentCount?: number
  duration?: number | null
  selected?: boolean
  onSelect?: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onShare?: () => void
  onDownload?: () => void
  onRename?: () => void
  onDelete?: () => void
  /** Right-click anywhere on the card (§28). The grid owns the menu, since
   *  it is the only thing that knows the current multi-selection. */
  onContextMenu?: (e: React.MouseEvent) => void
  fileSize?: number | null
  canVote?: boolean
  onVote?: (stars: number) => void
  /** Folder path label shown when Flatten Folders is on, e.g. "Test / Sub" */
  folderPath?: string
  // Appearance settings
  showInfo?: boolean
  showFileSize?: boolean
  showUploader?: boolean
  titleLines?: TitleLines
  aspectRatio?: AspectRatio
  thumbnailScale?: ThumbnailScale
  className?: string
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const rm = m % 60
    return `${h}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function AssetCard({
  asset,
  projectId,
  versionCount = 1,
  assignee,
  authorName,
  thumbnailUrl,
  commentCount,
  duration,
  selected = false,
  onSelect,
  onDragStart,
  onShare,
  onDownload,
  onRename,
  onDelete,
  onContextMenu,
  fileSize,
  canVote = false,
  onVote,
  folderPath,
  showInfo = true,
  showFileSize = true,
  showUploader = true,
  titleLines = '1',
  aspectRatio = 'landscape',
  thumbnailScale = 'fit',
  className,
}: AssetCardProps) {
  const TypeIcon = assetTypeIcons[asset.asset_type]
  const lineClamp = titleLines === '1' ? 'line-clamp-1' : titleLines === '2' ? 'line-clamp-2' : 'line-clamp-3'
  const [imgError, setImgError] = React.useState(false)
  const assetUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/projects/${asset.project_id}/assets/${asset.id}`
      : null

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      data-asset-card={asset.id}
      className={cn(
        'group flex flex-col rounded-lg overflow-hidden transition-all duration-150 cursor-pointer',
        'border-2',
        selected
          ? 'border-accent bg-accent/5 shadow-lg shadow-accent/10'
          : 'border-transparent hover:border-border-focus',
        className,
      )}
    >
      {/* Thumbnail area */}
      <div className={cn(
        'relative w-full bg-bg-tertiary overflow-hidden flex items-center justify-center',
        aspectMap[aspectRatio],
      )}>
        {thumbnailUrl && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={asset.name}
            onError={() => setImgError(true)}
            className={cn(
              'h-full w-full transition-transform duration-200 group-hover:scale-[1.02]',
              thumbnailScale === 'fill' ? 'object-cover' : 'object-contain',
            )}
          />
        ) : (
          <div className="flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-hover text-text-secondary">
              <TypeIcon className="h-7 w-7" />
            </div>
          </div>
        )}

        {/* Selection checkbox — top-left */}
        {onSelect && (
          <button
            aria-label={selected ? `Deselect ${asset.name}` : `Select ${asset.name}`}
            onClick={(e) => { e.stopPropagation(); onSelect(e) }}
            className={cn(
              'absolute top-2 left-2 h-5 w-5 rounded flex items-center justify-center transition-all',
              selected
                ? 'bg-accent text-white'
                : 'bg-black/40 text-transparent group-hover:text-white/60 backdrop-blur-sm',
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Rating — top-right */}
        {(canVote || (asset.rating_count ?? 0) > 0) && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-2 right-2 inline-flex items-center gap-1 rounded bg-black/40 px-1.5 py-0.5 backdrop-blur-sm"
          >
            <StarRating
              value={asset.my_rating ?? null}
              onChange={canVote ? (stars) => onVote?.(stars) : undefined}
              readOnly={!canVote}
              size="sm"
            />
            {(asset.rating_count ?? 0) > 0 && (
              <span className="text-2xs font-medium text-white/80 tabular-nums">
                {asset.avg_rating?.toFixed(1)}
              </span>
            )}
          </div>
        )}

        {/* §108 — unseen new version. Top-left, above the thumbnail, using
            the same chip language as the version pills elsewhere rather than
            a new visual system. Only ever shown when a NEWER version exists
            than the one this user opened, so a single-version asset and an
            asset you have already looked at both show nothing. */}
        {asset.has_unseen_version && versionCount > 1 && (
          <span
            data-testid="unseen-version-badge"
            title={`New version (v${versionCount}) you have not opened yet`}
            className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-foreground shadow-sm"
          >
            V{versionCount} · New Version
          </span>
        )}

        {/* Duration badge — bottom-right (for video/audio) */}
        {duration != null && duration > 0 && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white tabular-nums backdrop-blur-sm">
            {formatDuration(duration)}
          </span>
        )}

        {/* Comment count badge — bottom-left */}
        {commentCount != null && commentCount > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-2xs font-medium text-white backdrop-blur-sm">
            <MessageSquare className="h-3 w-3" />
            {commentCount}
          </span>
        )}
      </div>

      {/* Info section */}
      {showInfo && (
        <div className="flex flex-col gap-1 px-2 pt-2 pb-1.5">
          {/* Title + context menu */}
          <div className="flex items-start justify-between gap-1">
            <p className={cn('text-sm font-medium text-text-primary leading-tight', lineClamp)}>
              {asset.name}
            </p>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-bg-hover hover:text-text-primary transition-all outline-none"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="z-[100] min-w-[200px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Shared with the right-click menu (§28) so the two can
                      never drift out of step. */}
                  <AssetMenuItems
                    onShare={onShare}
                    onDownload={onDownload}
                    onRename={onRename}
                    onDelete={onDelete}
                    assetUrl={assetUrl}
                  />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>

          {/* Folder path — shown when Flatten Folders is on */}
          {folderPath && (
            <p className="flex items-center gap-1 text-2xs text-text-tertiary line-clamp-1">
              <FolderIcon className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{folderPath}</span>
            </p>
          )}

          {/* Author + date + file size row.
              The whole line used to be `line-clamp-1`, so a long uploader
              name pushed the date and file size past the clamp and they
              vanished entirely (§51). Only the NAME truncates now — it is
              the one part that can be arbitrarily long — and the date and
              size sit outside the truncated span, where an ellipsis cannot
              eat them. `min-w-0` on the flex child is what actually lets the
              name shrink; without it a long name refuses to and pushes the
              rest out again. */}
          <p className="flex items-center gap-1 text-2xs text-text-tertiary">
            {showUploader && authorName && (
              <>
                <span className="min-w-0 truncate">{authorName}</span>
                <span className="shrink-0">&bull;</span>
              </>
            )}
            <span className="shrink-0">{formatRelativeTime(asset.created_at)}</span>
            {showFileSize && fileSize ? (
              <>
                <span className="shrink-0">&bull;</span>
                <span className="shrink-0">{formatBytes(fileSize)}</span>
              </>
            ) : null}
          </p>
        </div>
      )}
    </div>
  )
}
