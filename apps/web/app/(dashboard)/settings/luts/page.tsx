'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Popover from '@radix-ui/react-popover'
import {
  SwatchBook,
  Upload,
  Trash2,
  Share2,
  Loader2,
  MoreHorizontal,
  Check,
  Globe,
  FolderPlus,
  ChevronDown,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/shared/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { LutThumbnail } from '@/components/shared/lut-thumbnail'
import { LutPreviewDialog } from '@/components/shared/lut-preview-dialog'
import { useAuthStore } from '@/stores/auth-store'
import type { Lut, LutGroup, Project } from '@/types'

// The literal label the user chose. Not "Superadmin LUTs", not "Global" --
// this wording was decided, not a placeholder.
const PLATFORM_SECTION_LABEL = 'Platform LUTs'

export default function LutsSettingsPage() {
  const { isSuperAdmin } = useAuthStore()

  const { data: luts, isLoading, mutate } = useSWR<Lut[]>(
    '/me/luts',
    (key: string) => api.get<Lut[]>(key),
  )
  // Every platform-wide LUT from *any* superadmin, not just the viewer's --
  // which is exactly why this is a separate endpoint from /me/luts.
  const { data: platformLuts, mutate: mutatePlatform } = useSWR<Lut[]>(
    '/luts/platform',
    (key: string) => api.get<Lut[]>(key),
  )
  const { data: groups, mutate: mutateGroups } = useSWR<LutGroup[]>(
    '/me/lut-groups',
    (key: string) => api.get<LutGroup[]>(key),
  )
  const { data: projects } = useSWR<Project[]>(
    '/projects',
    (key: string) => api.get<Project[]>(key),
  )

  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<Lut | null>(null)
  // Which LUT's frame is open in the zoom dialog. One dialog for the page,
  // the same way `deleting` is one ConfirmDialog rather than one per row.
  const [previewing, setPreviewing] = React.useState<Lut | null>(null)
  const [deletingGroup, setDeletingGroup] = React.useState<LutGroup | null>(null)
  const [newGroupOpen, setNewGroupOpen] = React.useState(false)
  const [newGroupName, setNewGroupName] = React.useState('')

  const refreshAll = React.useCallback(async () => {
    await Promise.all([mutate(), mutatePlatform(), mutateGroups()])
  }, [mutate, mutatePlatform, mutateGroups])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      await api.upload<Lut>('/me/luts', form)
      await refreshAll()
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'detail' in err
        ? String((err as { detail: unknown }).detail)
        : 'Upload failed'
      setError(msg)
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    await api.delete(`/me/luts/${target.id}`)
    await refreshAll()
  }

  async function handleDeleteGroup() {
    if (!deletingGroup) return
    const target = deletingGroup
    setDeletingGroup(null)
    await api.delete(`/me/lut-groups/${target.id}`)
    await refreshAll()
  }

  async function handleCreateGroup() {
    const name = newGroupName.trim()
    if (!name) return
    await api.post('/me/lut-groups', { name })
    setNewGroupName('')
    setNewGroupOpen(false)
    await mutateGroups()
  }

  const ownLuts = luts ?? []
  const platform = platformLuts ?? []
  // Own LUTs already promoted into the pinned section aren't repeated below.
  const platformIds = new Set(platform.map((l) => l.id))
  const ownNotPlatform = ownLuts.filter((l) => !platformIds.has(l.id))

  const groupList = groups ?? []
  const ungrouped = ownNotPlatform.filter((l) => !l.group_id)

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <SwatchBook className="h-5 w-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">LUTs</h1>
          <p className="text-sm text-text-secondary">
            Your personal color LUTs, available in every project you work on.
          </p>
        </div>
        <input ref={fileRef} type="file" accept=".cube" onChange={handleFile} className="hidden" />
        <Button size="sm" variant="secondary" onClick={() => setNewGroupOpen(true)}>
          <FolderPlus className="h-4 w-4" />
          New group
        </Button>
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload .cube
        </Button>
      </div>

      {error && (
        <p className="text-xs text-red-400 border border-red-400/30 bg-red-400/5 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* ── Pinned Platform LUTs ──
          Always at the very top, always expanded, shown to every user.
          Superadmins get the full controls; everyone else sees it read-only,
          since these aren't their LUTs to manage. */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-text-tertiary" />
          <h2 className="text-sm font-semibold text-text-primary">{PLATFORM_SECTION_LABEL}</h2>
          <span className="text-xs text-text-tertiary">
            Available in every project, to everyone
          </span>
        </div>

        {platform.length === 0 ? (
          <p className="text-xs text-text-tertiary border border-border border-dashed rounded-lg px-3 py-4">
            {isSuperAdmin
              ? 'No platform LUTs yet. Use the ⋯ menu on any of your LUTs to make one platform-wide.'
              : 'No platform LUTs have been published yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {platform.map((lut) => (
              <LutRow
                key={lut.id}
                lut={lut}
                groups={groupList}
                projects={projects ?? []}
                // Read-only for non-superadmins even when they happen to own
                // the row: management of a published platform LUT is a
                // superadmin action.
                canManage={isSuperAdmin && lut.is_owner}
                canTogglePlatform={isSuperAdmin}
                // Deliberate: no relative-time label on Platform LUT rows.
                // created_at is still stored and still drives sort order --
                // this is display-only.
                showTimestamp={false}
                onChanged={refreshAll}
                onDelete={() => setDeleting(lut)}
                onPreview={() => setPreviewing(lut)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── The viewer's own library ── */}
      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 rounded-lg border border-border bg-bg-secondary animate-pulse" />
          ))}
        </div>
      ) : ownNotPlatform.length === 0 && groupList.length === 0 ? (
        <EmptyState
          icon={SwatchBook}
          title="No LUTs yet"
          description="Upload a .cube file to preview it on any video or image, and share it into a project when you want the team to see it too."
        />
      ) : (
        <div className="space-y-6">
          {groupList.map((group) => {
            const members = ownNotPlatform.filter((l) => l.group_id === group.id)
            return (
              <section key={group.id} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-text-primary">{group.name}</h2>
                  <span className="text-xs text-text-tertiary">{members.length}</span>
                  <button
                    onClick={() => setDeletingGroup(group)}
                    className="ml-auto text-xs text-text-tertiary hover:text-status-error transition-colors"
                  >
                    Delete group
                  </button>
                </div>
                {members.length === 0 ? (
                  <p className="text-xs text-text-tertiary">Empty — move a LUT here from its ⋯ menu.</p>
                ) : (
                  <div className="space-y-3">
                    {members.map((lut) => (
                      <LutRow
                        key={lut.id}
                        lut={lut}
                        groups={groupList}
                        projects={projects ?? []}
                        canManage
                        canTogglePlatform={isSuperAdmin}
                        showTimestamp
                        onChanged={refreshAll}
                        onDelete={() => setDeleting(lut)}
                        onPreview={() => setPreviewing(lut)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )
          })}

          {ungrouped.length > 0 && (
            <section className="space-y-3">
              {groupList.length > 0 && (
                <h2 className="text-sm font-semibold text-text-primary">Ungrouped</h2>
              )}
              <div className="space-y-3">
                {ungrouped.map((lut) => (
                  <LutRow
                    key={lut.id}
                    lut={lut}
                    groups={groupList}
                    projects={projects ?? []}
                    canManage
                    canTogglePlatform={isSuperAdmin}
                    showTimestamp
                    onChanged={refreshAll}
                    onDelete={() => setDeleting(lut)}
                    onPreview={() => setPreviewing(lut)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* New group */}
      {newGroupOpen && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary p-3">
          <Input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreateGroup()
              if (e.key === 'Escape') setNewGroupOpen(false)
            }}
            placeholder="Group name"
            className="h-8 text-xs"
          />
          <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNewGroupOpen(false)}>
            Cancel
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete LUT"
        description={
          deleting
            ? `"${deleting.name}" will be removed from your library and unshared from every project. Any shot currently graded with it falls back to no grade.`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={deletingGroup !== null}
        onOpenChange={(open) => !open && setDeletingGroup(null)}
        title="Delete group"
        description={
          deletingGroup
            ? `"${deletingGroup.name}" will be removed. The LUTs inside it are kept and become ungrouped.`
            : ''
        }
        confirmLabel="Delete group"
        variant="danger"
        onConfirm={handleDeleteGroup}
      />

      <LutPreviewDialog
        lut={previewing}
        onOpenChange={(open) => !open && setPreviewing(null)}
      />
    </div>
  )
}

// ─── One LUT row ─────────────────────────────────────────────────────────────

function LutRow({
  lut,
  groups,
  projects,
  canManage,
  canTogglePlatform,
  showTimestamp,
  onChanged,
  onDelete,
  onPreview,
}: {
  lut: Lut
  groups: LutGroup[]
  projects: Project[]
  canManage: boolean
  canTogglePlatform: boolean
  /** False for Platform LUT rows — display-only, created_at is still stored. */
  showTimestamp: boolean
  onChanged: () => void | Promise<void>
  onDelete: () => void
  /** Opens the zoom view of this LUT's frame. Not gated on canManage: looking
   *  at a grade is not managing it, and the read-only Platform rows are
   *  exactly where a bigger look is most useful. */
  onPreview: () => void
}) {
  const [busy, setBusy] = React.useState(false)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      await api.patch(`/me/luts/${lut.id}`, body)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-bg-secondary">
      {/* The swatch is the zoom trigger. Deliberately only here: a
          LutPicker row already selects the LUT on click, so a second
          click meaning on the same row would be a genuine ambiguity. */}
      <button
        type="button"
        onClick={onPreview}
        aria-label={`Preview ${lut.name}`}
        className="shrink-0 rounded transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <LutThumbnail lut={lut} className="h-8 w-12" />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-text-primary truncate">{lut.name}</h3>
          {lut.is_platform_wide && (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-2xs bg-accent-muted text-accent">
              Platform
            </span>
          )}
        </div>
        <p className="text-xs text-text-tertiary mt-0.5">
          {lut.lut_size ? `${lut.lut_size}³` : ''}
          {lut.lut_size && (showTimestamp || lut.owner_name) ? ' · ' : ''}
          {/* Platform rows deliberately omit the relative time. */}
          {showTimestamp ? `added ${formatRelativeTime(lut.created_at)}` : lut.owner_name ?? ''}
        </p>
      </div>

      {busy && <Loader2 className="h-4 w-4 animate-spin text-text-tertiary shrink-0" />}

      {canManage && (
        <>
          <SharePopover lut={lut} projects={projects} onChanged={onChanged} />

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
                aria-label={`More actions for ${lut.name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-[100] w-56 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1"
              >
                {canTogglePlatform && (
                  <>
                    <DropdownMenu.Item
                      onSelect={() => void patch({ is_platform_wide: !lut.is_platform_wide })}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                    >
                      <Globe className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                      {lut.is_platform_wide ? 'Remove from Platform LUTs' : 'Make platform-wide'}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  </>
                )}

                <DropdownMenu.Label className="px-2.5 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                  Move to group
                </DropdownMenu.Label>
                <DropdownMenu.Item
                  onSelect={() => void patch({ group_id: null })}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-text-secondary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  Ungrouped
                  {!lut.group_id && <Check className="h-3.5 w-3.5 text-accent" />}
                </DropdownMenu.Item>
                {groups.map((g) => (
                  <DropdownMenu.Item
                    key={g.id}
                    onSelect={() => void patch({ group_id: g.id })}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                  >
                    <span className="truncate">{g.name}</span>
                    {lut.group_id === g.id && <Check className="h-3.5 w-3.5 text-accent shrink-0" />}
                  </DropdownMenu.Item>
                ))}

                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={onDelete}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </>
      )}
    </div>
  )
}

// ─── Share popover ───────────────────────────────────────────────────────────

/**
 * Always-visible Share control, replacing the old buried
 * ⋯ → "Share into project" menu item. Each project is a toggle reflecting
 * current state, so the same control both shares and unshares — the old UI
 * had no unshare path at all outside the API.
 */
function SharePopover({
  lut,
  projects,
  onChanged,
}: {
  lut: Lut
  projects: Project[]
  onChanged: () => void | Promise<void>
}) {
  const [pending, setPending] = React.useState<string | null>(null)
  // Optimistic local view, so a toggle responds immediately rather than
  // waiting on a refetch of the whole list.
  const [shared, setShared] = React.useState<Set<string>>(
    () => new Set(lut.shared_project_ids ?? []),
  )
  React.useEffect(() => {
    setShared(new Set(lut.shared_project_ids ?? []))
  }, [lut.shared_project_ids])

  async function toggle(project: Project) {
    const isShared = shared.has(project.id)
    setPending(project.id)
    // Flip locally first; reverted below if the request fails.
    setShared((prev) => {
      const next = new Set(prev)
      if (isShared) next.delete(project.id)
      else next.add(project.id)
      return next
    })
    try {
      if (isShared) {
        await api.delete(`/projects/${project.id}/luts/${lut.id}/share`)
      } else {
        await api.post(`/projects/${project.id}/luts/${lut.id}/share`, {})
      }
      await onChanged()
    } catch {
      setShared((prev) => {
        const next = new Set(prev)
        if (isShared) next.add(project.id)
        else next.delete(project.id)
        return next
      })
    } finally {
      setPending(null)
    }
  }

  const count = shared.size

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={cn(
            'flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors shrink-0',
            count > 0
              ? 'border-accent text-accent'
              : 'border-border text-text-secondary hover:text-text-primary',
          )}
          aria-label={`Share ${lut.name} into projects`}
        >
          <Share2 className="h-3.5 w-3.5" />
          Share
          {count > 0 && <span className="tabular-nums">{count}</span>}
          <ChevronDown className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[100] w-64 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl p-1"
        >
          <p className="px-2.5 py-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
            Share into project
          </p>
          {projects.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-text-tertiary">
              You&apos;re not on any projects yet
            </p>
          ) : (
            projects.map((p) => {
              const on = shared.has(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => void toggle(p)}
                  disabled={pending === p.id}
                  className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-xs text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
                >
                  <span className="truncate">{p.name}</span>
                  {pending === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-text-tertiary shrink-0" />
                  ) : (
                    <span
                      className={cn(
                        'flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors',
                        on ? 'bg-accent justify-end' : 'bg-bg-tertiary justify-start',
                      )}
                    >
                      <span className="h-3 w-3 rounded-full bg-white" />
                    </span>
                  )}
                </button>
              )
            })
          )}
          {lut.is_platform_wide && (
            <p className="px-2.5 py-2 text-2xs text-text-tertiary border-t border-border mt-1">
              This is a Platform LUT — already available in every project
              regardless of the toggles above.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
