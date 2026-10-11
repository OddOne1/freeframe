'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Folder as FolderIcon,
  Link as LinkIcon,
  MinusCircle,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ShareLinkListItem } from '@/types'

/**
 * The project's share links, as a navigation list (§227).
 *
 * Lifted verbatim out of `projects/[id]/page.tsx`'s left column, where it
 * was the only place it existed — and that column is `hidden xl:flex`, so
 * on a phone or a small tablet the owner's report was exact: "no way to
 * get to the share links". §224's folder sheet carried only `FolderTree`.
 *
 * ONE component, two mount points: the left column at `xl`+ and §227's
 * expanding folder navigator below it. Not a copy — a copy is how the two
 * start offering different menus on the same links, and how the "+" in one
 * of them stops clearing `showTrash`. Everything it does is passed in, so
 * it holds no state of its own: `shareLinksExpanded`, `showShareLinks` and
 * `selectedShareLink` all still live in the page, which is what the main
 * view reads.
 *
 * The markup is unchanged from the column's, down to the class strings, so
 * the desktop rendering is byte-for-byte what it was. `onSelect` exists
 * only so the navigator can close its panel after a pick; the column
 * passes nothing and behaves exactly as before.
 */
export function ShareLinksSection({
  shareLinks,
  expanded,
  onToggleExpanded,
  showShareLinks,
  selectedShareLink,
  onCreate,
  onSelectAll,
  onSelectLink,
  onToggleEnabled,
  onDelete,
  onSelect,
}: {
  shareLinks: ShareLinkListItem[]
  expanded: boolean
  onToggleExpanded: () => void
  showShareLinks: boolean
  selectedShareLink: string | null
  /** Opens the create dialog — the page's `openShareDialog([], [])`. */
  onCreate: () => void
  /** Selects the "All Share Links" view. */
  onSelectAll: () => void
  onSelectLink: (token: string) => void
  onToggleEnabled: (token: string, enabled: boolean) => void
  onDelete: (token: string) => void
  /** Called after any pick, so a mount point can dismiss itself. */
  onSelect?: () => void
}) {
  return (
    <div className="px-3 py-2 border-t border-border">
      <div className="w-full flex items-center justify-between px-2 mb-1">
        <span
          className="text-2xs font-semibold text-text-tertiary uppercase tracking-wider cursor-pointer"
          onClick={onToggleExpanded}
        >
          Share Links
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreate();
            }}
            className="text-text-tertiary hover:text-text-primary transition-colors"
            title="Create share link"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onToggleExpanded}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-0.5">
          <button
            onClick={() => {
              onSelectAll();
              onSelect?.();
            }}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors",
              showShareLinks && !selectedShareLink
                ? "bg-bg-hover text-text-primary"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
            )}
          >
            <LinkIcon className="h-4 w-4" />
            <span>All Share Links ({shareLinks.length})</span>
          </button>
          {shareLinks.map((link) => (
            <div
              key={link.token}
              className={cn(
                // pl-6 = 24px, which is exactly what folder-tree.tsx's
                // own `8 + depth * 16` gives a depth-1 row (§21d). The
                // "All Share Links" button above sits at px-2 = 8px,
                // i.e. depth 0 — so these read as its children rather
                // than its siblings, using the indent convention this
                // sidebar already has instead of a new one.
                "group w-full flex items-center gap-2 pl-6 pr-2 py-1.5 rounded text-sm transition-colors cursor-pointer",
                selectedShareLink === link.token
                  ? "bg-bg-hover text-text-primary"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
              )}
              onClick={() => {
                onSelectLink(link.token);
                onSelect?.();
              }}
            >
              {link.share_type === "folder" ? (
                <FolderIcon className="h-4 w-4 shrink-0" />
              ) : (
                <FileText className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate flex-1">
                {link.title || link.target_name}
              </span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    className="h-5 w-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity shrink-0 hover-none:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="z-50 min-w-[180px] rounded-xl border border-border bg-bg-secondary p-1 shadow-xl"
                    sideOffset={4}
                    align="end"
                  >
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                      onSelect={() =>
                        window.open(
                          `${window.location.origin}/share/${link.token}`,
                          "_blank",
                        )
                      }
                    >
                      <ExternalLink className="h-4 w-4 text-text-tertiary" />
                      Open Share
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                      onSelect={() =>
                        navigator.clipboard.writeText(
                          `${window.location.origin}/share/${link.token}`,
                        )
                      }
                    >
                      <LinkIcon className="h-4 w-4 text-text-tertiary" />
                      Copy Link
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                      onSelect={() =>
                        onToggleEnabled(link.token, !link.is_enabled)
                      }
                    >
                      <MinusCircle className="h-4 w-4 text-text-tertiary" />
                      {link.is_enabled ? "Disable Access" : "Enable Access"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                      onSelect={() => onDelete(link.token)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The project's storage figure, as the left column's foot shows it (§227).
 *
 * Same extraction, same reason: it lived only in the `hidden xl:flex`
 * column, so below 1280px the number did not exist anywhere — Claude
 * Code's own §224b report said so. It is now also the last thing in the
 * folder navigator's panel.
 *
 * `fixedHeight` is the column's 89px box, which exists to line this
 * block's `border-t` up with the global rail's at the same distance from
 * the viewport bottom. In the navigator panel there is no rail to line up
 * with and the panel scrolls, so that height and its 20px spacer would be
 * dead space; everything else is identical, and the column passes
 * `fixedHeight` so its rendering is unchanged.
 */
export function ProjectStorageMeter({
  used,
  limit,
  formatBytes,
  fixedHeight = false,
}: {
  used: number
  limit: number | null
  formatBytes: (bytes: number) => string
  fixedHeight?: boolean
}) {
  const box = cn('border-t border-border shrink-0 p-2 space-y-1', fixedHeight && 'h-[89px]')

  if (limit === null) {
    return (
      <div className={box}>
        <div className="flex flex-col gap-1 px-2.5 py-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-text-secondary">Storage</span>
            <span className="text-[10px] tabular-nums text-text-tertiary">
              {formatBytes(used)} used
            </span>
          </div>
        </div>
        {fixedHeight && <div className="h-5" />}
      </div>
    );
  }

  const pct = Math.min((used / limit) * 100, 100);
  const isCritical = pct >= 90;
  const isWarning = pct >= 80;
  return (
    <div className={box}>
      <div className="flex flex-col gap-1 px-2.5 py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-text-secondary">Storage</span>
          <span className={cn(
            "text-[10px] tabular-nums",
            isCritical ? "text-status-error font-medium" : isWarning ? "text-amber-400 font-medium" : "text-text-tertiary",
          )}>
            {formatBytes(used)} / {formatBytes(limit)}
          </span>
        </div>
        <div className="h-1 w-full rounded-full bg-bg-hover overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              isCritical ? "bg-status-error" : isWarning ? "bg-amber-400" : "bg-accent",
            )}
            style={{ width: `${Math.max(pct, 1)}%` }}
          />
        </div>
      </div>
      {fixedHeight && <div className="h-5" />}
    </div>
  );
}
