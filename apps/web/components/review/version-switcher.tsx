'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  AlertCircle,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ChevronDown,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useOptionalToast } from '@/components/shared/toast'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion, AssetVersionStatus } from '@/types'

export const versionStatusConfig: Record<
  AssetVersionStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  uploading: {
    label: 'Uploading',
    className: 'text-status-info',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  processing: {
    label: 'Processing',
    className: 'text-status-warning',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  ready: {
    label: 'DONE',
    className: 'text-status-success',
    icon: <CheckCircle2 className="h-2.5 w-2.5" />,
  },
  failed: {
    label: 'Failed',
    className: 'text-status-error',
    icon: <AlertCircle className="h-2.5 w-2.5" />,
  },
}

/**
 * §238 — a `failed` version whose UPLOAD never finished.
 *
 * Deliberately not red and deliberately not the word "Failed": nothing
 * broke, an upload was interrupted. Red "Failed" sent the owner looking
 * for a processing problem that did not exist, and to a "Restart
 * processing" that could never work. Amber is the same tone the app uses
 * for "needs your attention, nothing is wrong", as `processing` does.
 */
export const uploadIncompleteStatus = {
  label: 'Upload incomplete',
  className: 'text-status-warning',
  icon: <AlertTriangle className="h-2.5 w-2.5" />,
}

/**
 * How to label THIS version — the status, unless the server says the
 * failure was an incomplete upload (§238).
 *
 * A function rather than a sixth key on `versionStatusConfig`: that map is
 * keyed by `processing_status`, which is a real enum with four values, and
 * "upload incomplete" is not a fifth status. It is a failed version plus
 * the server's `failure_stage`.
 */
export function versionStatusFor(
  version: Pick<AssetVersion, 'processing_status' | 'failure_stage'>,
) {
  if (version.processing_status === 'failed' && version.failure_stage === 'upload') {
    return uploadIncompleteStatus
  }
  return versionStatusConfig[version.processing_status]
}

/**
 * §242 — "a new version arrived while you were looking at this".
 *
 * On the TRIGGER, which is the only part of the switcher visible with the
 * menu closed — and the whole point is to be seen without opening anything.
 * White on the trigger's accent fill, because the grid's own new-version
 * chip is `bg-accent` and an accent dot on an accent button is invisible;
 * the ring is what keeps it readable over the lighter hover fill.
 *
 * Not a button and not focusable: it is a notice, and the thing to do about
 * it (pick the version) is the menu it sits on.
 */
function NewVersionDot({ versionNumber }: { versionNumber: number }) {
  const label = `New version v${versionNumber} available`
  return (
    <span
      data-testid="new-version-dot"
      title={label}
      aria-label={label}
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-white ring-1 ring-white/70"
    />
  )
}

/** The same notice on the row itself, so an open list says WHICH version it
 *  was. `bg-accent`/`text-accent-foreground` is the pair asset-card.tsx
 *  uses for its unseen-version chip (§111). */
function NewVersionTag({ versionNumber }: { versionNumber: number }) {
  return (
    <span
      data-testid={`new-version-tag-${versionNumber}`}
      className="rounded bg-accent px-1 py-px text-[10px] font-semibold uppercase leading-tight text-accent-foreground"
    >
      New
    </span>
  )
}

/**
 * §241 item 1 — a version that was removed, still in the list.
 *
 * Red, the word "Removed", and NOT a selectable row: `disabled` is what
 * stops both a click and the arrow keys landing on a version that has no
 * media behind it (the server empties `files` for a deleted row, so a
 * player pointed at it would have nothing to play and no thumbnail to
 * show).
 *
 * §240b — the server sends a removed row only to someone who may restore
 * it (the deleter, the project owner, a superadmin); everyone else gets no
 * row at all, and nothing here filters. The deleter's name is printed
 * only when the server sent one, never assembled from a member list.
 */
function RemovedVersionRow({
  version,
  restoring,
  onRestore,
}: {
  version: AssetVersion
  restoring: boolean
  onRestore?: () => void
}) {
  const deletedAt = version.deleted_at ? new Date(version.deleted_at) : null
  const who = version.deleted_by_name?.trim() || null
  // Who and when, as one line under the row — the tooltip carries the
  // exact timestamp, which a relative date cannot be checked against.
  const detail = [
    who ? `Removed by ${who}` : null,
    deletedAt && !Number.isNaN(deletedAt.getTime())
      ? deletedAt.toLocaleDateString(undefined, { dateStyle: 'medium' })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex items-stretch" data-testid={`removed-version-${version.version_number}`}>
      <DropdownMenu.Item
        disabled
        aria-disabled="true"
        title={detail || undefined}
        className={cn(
          'flex flex-1 flex-col items-start gap-0 ml-1 px-2.5 py-2 hover-none:min-h-11 rounded-lg text-sm outline-none',
          onRestore ? 'mr-0' : 'mr-1',
          'text-status-error cursor-not-allowed data-[disabled]:pointer-events-none',
        )}
      >
        <span className="flex w-full items-center justify-between gap-3">
          <span className="line-through">v{version.version_number}</span>
          <span className="inline-flex items-center gap-1 text-[11px] uppercase">
            <Trash2 className="h-2.5 w-2.5" />
            Removed
          </span>
        </span>
        {detail && (
          <span className="text-[10px] leading-tight text-text-tertiary">{detail}</span>
        )}
      </DropdownMenu.Item>
      {/* §240 C — only the deleter, the project owner and a superadmin get
          this, and the server is the one that says so. Since §240b they
          are also the only ones sent the row; the flag is still read
          rather than assumed. */}
      {onRestore && version.can_restore && (
        <DropdownMenu.Item
          data-testid={`restore-version-${version.version_number}`}
          aria-label={`Restore v${version.version_number}`}
          title={`Restore v${version.version_number}`}
          disabled={restoring}
          onSelect={(e) => {
            // The menu would close under the toast otherwise, and a second
            // restore of the same row is a 404 the user did not ask for.
            e.preventDefault()
            onRestore()
          }}
          className={cn(
            'flex items-center justify-center mr-1 px-2 hover-none:min-w-11 rounded-lg cursor-pointer outline-none transition-colors',
            'text-accent hover:bg-accent/10',
            restoring && 'opacity-40 cursor-wait',
          )}
        >
          {restoring ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
        </DropdownMenu.Item>
      )}
    </div>
  )
}

interface VersionSwitcherProps {
  versions: AssetVersion[]
  className?: string
  /**
   * §239 — may the signed-in user delete THIS version? Per version, not
   * once for the current one: the rule is "the uploader, the project
   * owner, or a superadmin", and in a project with several contributors
   * the answer differs row by row. Asked of the caller rather than
   * computed here because the page already holds the member list and the
   * auth store, and the server's `can_manage_version` is the only real
   * authority either way.
   *
   * Omitted (share mode, or a viewer) and no delete affordance is
   * rendered at all.
   */
  canDeleteVersion?: (version: AssetVersion) => boolean
  /** Performs the delete and refreshes the page's state. Throws on refusal;
   *  the message is shown in the dialog, which stays open. */
  onDeleteVersion?: (version: AssetVersion) => Promise<void>
  /**
   * §242 — versions that ARRIVED while the page has been open, were
   * uploaded by someone else, and are ready to look at.
   *
   * A set rather than a flag because several can land in a row: the
   * trigger shows ONE dot naming the newest of them, and each of their
   * rows is tagged. Who qualifies is not this component's business — the
   * diff against what the page knew at open, the own-upload exclusion and
   * the clearing on selection all live in `useLiveVersions`. Omitted (or
   * empty) and nothing about this component changes.
   */
  newVersionIds?: ReadonlySet<string>
  /**
   * §241 item 1 — versions that were REMOVED, still listed.
   *
   * A deleted version used to vanish from the history, so "where did v2
   * go" had no answer anywhere in the app. These rows stay in place, in
   * red, marked "Removed", and are not selectable: there is no media
   * behind them (the server empties `files`) and nothing to play.
   *
   * Kept as a SEPARATE list rather than mixed into `versions`: the live
   * list drives the player, §242's arrivals and the selection, and a
   * deleted row inside it would be a candidate for every one of those.
   * Who may see the deleter's name and who may restore are the server's
   * answers, carried on each row (`deleted_by_name`, `can_restore`).
   */
  removedVersions?: AssetVersion[]
  /**
   * Puts one removed version back. Rendered only for rows whose
   * `can_restore` the server set — the deleter, the project owner or a
   * superadmin; the uploader who did not delete it is NOT among them, so
   * this is never re-derived from `created_by`.
   *
   * No confirm dialog: a restore is reversible and cheap. It reports with
   * a toast either way, and the failure toast is the server's own message
   * (a 409 `storage_limit` reads for itself).
   */
  onRestoreVersion?: (version: AssetVersion) => Promise<void>
}

export function VersionSwitcher({
  versions,
  className,
  canDeleteVersion,
  onDeleteVersion,
  newVersionIds,
  removedVersions,
  onRestoreVersion,
}: VersionSwitcherProps) {
  const currentVersion = useReviewStore((s) => s.currentVersion)
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)
  // `useOptionalToast`, not `useToast`: this component is rendered by a
  // dozen tests on its own and `useToast` throws without a provider.
  const toast = useOptionalToast()

  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => a.version_number - b.version_number),
    [versions],
  )

  // The newest of the arrivals — the one the dot's tooltip names. One dot
  // for any number of them (§242 B5).
  const newestArrival = React.useMemo(() => {
    if (!newVersionIds || newVersionIds.size === 0) return null
    const tagged = sorted.filter((v) => newVersionIds.has(v.id))
    return tagged.length ? tagged[tagged.length - 1] : null
  }, [sorted, newVersionIds])

  const [pendingDelete, setPendingDelete] = React.useState<AssetVersion | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [restoring, setRestoring] = React.useState<string | null>(null)

  /**
   * The list the menu actually renders: live and removed versions in ONE
   * numeric order, so a removed v2 sits between v1 and v3 where the user
   * left it rather than in a separate block at the end.
   */
  const rows = React.useMemo(() => {
    const removed = (removedVersions ?? []).filter((v) => v.deleted_at !== null)
    const live = new Set(sorted.map((v) => v.id))
    return [...sorted, ...removed.filter((v) => !live.has(v.id))]
      .sort((a, b) => a.version_number - b.version_number)
      .map((version) => ({ version, removed: !live.has(version.id) }))
  }, [sorted, removedVersions])

  const handleRestore = React.useCallback(
    async (version: AssetVersion) => {
      if (!onRestoreVersion) return
      setRestoring(version.id)
      try {
        await onRestoreVersion(version)
        toast(`v${version.version_number} restored`, 'success')
      } catch (err) {
        // The server's own sentence. A 409 `storage_limit` already says
        // that the storage limit is what blocks it; a 403 and a 404 read
        // for themselves too, and the client has nothing truer to add.
        toast(
          err instanceof Error && err.message
            ? err.message
            : 'Could not restore this version.',
          'error',
        )
      } finally {
        setRestoring(null)
      }
    },
    [onRestoreVersion, toast],
  )

  // Which rows may offer a delete at all. The LAST remaining version is
  // still listed with the control — disabled, carrying the reason —
  // rather than silently without it: "why can I delete v2 but there is no
  // option on v1" is the question the explanation answers.
  const deletable = Boolean(onDeleteVersion && canDeleteVersion)
  const offersDelete = deletable && sorted.some((v) => canDeleteVersion!(v))
  const isOnlyVersion = sorted.length <= 1

  // With one version and nothing to delete there is nothing a menu could
  // show, so the trigger stays a plain label as before. A removed version
  // is a reason to open the menu even when only one live version is left:
  // it is where "v2 was removed" is said at all.
  const hasMenu = rows.length > 1 || offersDelete

  // Nothing live and nothing removed: no list, no trigger. A removed-only
  // asset cannot happen (the last version cannot be deleted), but the
  // trigger below reads `sorted`, so the guard says which list it means.
  if (rows.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-xs text-text-tertiary shrink-0">Version:</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center justify-center gap-1 rounded-md px-2.5 py-1 hover-none:min-h-11 hover-none:px-4 bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors outline-none">
            v
            {currentVersion?.version_number ??
              sorted[sorted.length - 1]?.version_number ??
              rows[rows.length - 1].version.version_number}
            {newestArrival && <NewVersionDot versionNumber={newestArrival.version_number} />}
            {hasMenu && <ChevronDown className="h-3 w-3 opacity-70" />}
          </button>
        </DropdownMenu.Trigger>
        {hasMenu && (
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="z-[100] min-w-[160px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            >
              {rows.map(({ version, removed }) => {
                if (removed) {
                  return (
                    <RemovedVersionRow
                      key={version.id}
                      version={version}
                      restoring={restoring === version.id}
                      onRestore={onRestoreVersion ? () => handleRestore(version) : undefined}
                    />
                  )
                }
                const isActive = currentVersion?.id === version.id
                const statusCfg = versionStatusFor(version)
                const isDisabled =
                  version.processing_status === 'uploading' ||
                  version.processing_status === 'processing'
                const showDelete = deletable && canDeleteVersion!(version)
                // Why a delete is refused, if it is — the server answers
                // the same two 409s, and saying it here saves a round
                // trip that can only fail.
                const deleteBlockedReason = isOnlyVersion
                  ? 'The only version — delete the asset instead'
                  : isDisabled
                    ? 'Still uploading or processing — cancel or restart it first'
                    : null
                return (
                  <div key={version.id} className="flex items-stretch">
                    {/* Two menu items in one visual row, which is what the
                        rest of the app's menus do (folder-card, the asset
                        cards): one real `Item` per action, so arrow keys
                        reach the delete and nothing interactive is nested
                        inside a menuitem. */}
                    <DropdownMenu.Item
                      disabled={isDisabled}
                      onSelect={() => setCurrentVersion(version)}
                      className={cn(
                        'flex flex-1 items-center justify-between gap-3 ml-1 px-2.5 py-2 hover-none:min-h-11 rounded-lg text-sm cursor-pointer outline-none transition-colors',
                        showDelete ? 'mr-0' : 'mr-1',
                        isActive
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                        isDisabled && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        v{version.version_number}
                        {newVersionIds?.has(version.id) && (
                          <NewVersionTag versionNumber={version.version_number} />
                        )}
                      </span>
                      <span
                        className={cn('inline-flex items-center gap-1 text-[11px]', statusCfg.className)}
                        title={statusCfg.label}
                      >
                        {statusCfg.icon}
                        {statusCfg.label}
                      </span>
                    </DropdownMenu.Item>
                    {showDelete && (
                      <DropdownMenu.Item
                        disabled={Boolean(deleteBlockedReason)}
                        data-testid={`delete-version-${version.version_number}`}
                        aria-label={`Delete v${version.version_number}`}
                        title={deleteBlockedReason ?? `Delete v${version.version_number}`}
                        onSelect={() => {
                          setDeleteError(null)
                          setPendingDelete(version)
                        }}
                        className={cn(
                          'flex items-center justify-center mr-1 px-2 hover-none:min-w-11 rounded-lg cursor-pointer outline-none transition-colors',
                          'text-text-tertiary hover:bg-status-error/10 hover:text-status-error',
                          deleteBlockedReason && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-text-tertiary',
                        )}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </DropdownMenu.Item>
                    )}
                  </div>
                )
              })}
              {offersDelete && isOnlyVersion && (
                <DropdownMenu.Label className="px-3 pt-1.5 pb-0.5 text-[11px] leading-snug text-text-tertiary max-w-[220px]">
                  This is the only version, so it cannot be deleted on its
                  own. Delete the asset instead.
                </DropdownMenu.Label>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </DropdownMenu.Root>

      {/* §239 — the same ConfirmDialog every other destructive action on
          this app uses. Three things it has to say, because none of them
          is recoverable from the UI: which version, that the comments go
          with it, and that the app cannot undo it. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            setDeleteError(null)
          }
        }}
        title={`Delete v${pendingDelete?.version_number ?? ''}?`}
        description={
          <>
            {/* §238 — an incomplete upload has no comments to hide and no
                history to lose, and its number comes BACK. Saying the
                §239 sentence over it would be false in both halves. */}
            {pendingDelete?.failure_stage === 'upload' ? (
              <>
                This version was never fully uploaded, so there is nothing
                in it to lose. Removing it frees v
                {pendingDelete.version_number} for your next upload of this
                file.
              </>
            ) : (
              <>
                {/* §241 item 4 — no deadline is promised here, because
                    there is none: `purge_expired` selects on assets and
                    folders only, so a soft-deleted VERSION is never due
                    and never purged (§240's report says so in as many
                    words). The 30-day sentence the asset and folder
                    dialogs now carry would be false on this one. */}
                This version will be removed. Its comments, annotations and
                approvals are hidden with it. You can restore it from the
                version list or from Recently Deleted.
              </>
            )}
            {deleteError && (
              <span className="mt-2 block text-status-error">{deleteError}</span>
            )}
          </>
        }
        confirmLabel="Delete version"
        variant="danger"
        onConfirm={async () => {
          if (!pendingDelete || !onDeleteVersion) return
          try {
            await onDeleteVersion(pendingDelete)
          } catch (err) {
            // Shown in the dialog, which ConfirmDialog leaves open when
            // onConfirm throws. The server's own message: a 409
            // `last_version`, a 403, or a 404 all read for themselves and
            // the client has nothing truer to say than what it was told.
            setDeleteError(err instanceof Error ? err.message : 'Could not delete this version.')
            throw err
          }
        }}
      />
    </div>
  )
}
