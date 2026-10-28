'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { AlertCircle, AlertTriangle, Loader2, CheckCircle2, ChevronDown, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
}

export function VersionSwitcher({
  versions,
  className,
  canDeleteVersion,
  onDeleteVersion,
}: VersionSwitcherProps) {
  const currentVersion = useReviewStore((s) => s.currentVersion)
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)

  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => a.version_number - b.version_number),
    [versions],
  )

  const [pendingDelete, setPendingDelete] = React.useState<AssetVersion | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  // Which rows may offer a delete at all. The LAST remaining version is
  // still listed with the control — disabled, carrying the reason —
  // rather than silently without it: "why can I delete v2 but there is no
  // option on v1" is the question the explanation answers.
  const deletable = Boolean(onDeleteVersion && canDeleteVersion)
  const offersDelete = deletable && sorted.some((v) => canDeleteVersion!(v))
  const isOnlyVersion = sorted.length <= 1

  // With one version and nothing to delete there is nothing a menu could
  // show, so the trigger stays a plain label as before.
  const hasMenu = sorted.length > 1 || offersDelete

  if (sorted.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-xs text-text-tertiary shrink-0">Version:</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center justify-center gap-1 rounded-md px-2.5 py-1 hover-none:min-h-11 hover-none:px-4 bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors outline-none">
            v{currentVersion?.version_number ?? sorted[sorted.length - 1].version_number}
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
              {sorted.map((version) => {
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
                      <span>v{version.version_number}</span>
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
                This version and the comments, annotations and approvals on
                it will be hidden from this file. The other versions and
                their comments are untouched. This cannot be undone from
                the app.
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
