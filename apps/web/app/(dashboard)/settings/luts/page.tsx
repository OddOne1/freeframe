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
  Pencil,
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

/** A private drag type rather than application/json, so a section only lights
 *  up for a LUT being dragged -- dragging a file in from the desktop, or an
 *  asset from elsewhere in the app, must not look like a valid drop here.
 *  The id is unreadable during dragover (only the type list is), which is
 *  exactly why the type has to carry the meaning. */
const LUT_DRAG_TYPE = 'application/x-freeframe-lut'

/**
 * A section that accepts a dragged LUT.
 *
 * A component rather than a hook because the group sections are rendered from
 * a map, and a hook cannot be called in a loop.
 */
function LutDropZone({
  enabled,
  onDropLut,
  className,
  children,
}: {
  /** False renders a plain section with no drop behaviour and no affordance
   *  -- which is how a non-superadmin sees the Platform section. */
  enabled: boolean
  onDropLut: (lutId: string) => void
  className?: string
  children: React.ReactNode
}) {
  const [over, setOver] = React.useState(false)

  if (!enabled) return <section className={className}>{children}</section>

  return (
    <section
      className={cn(
        className,
        'rounded-lg transition-shadow',
        over && 'ring-2 ring-accent/50 bg-accent/5',
      )}
      data-drop-active={over ? 'true' : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(LUT_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => {
        // dragleave fires for every child the pointer crosses too, so a leave
        // that lands somewhere still inside this section is not a leave.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setOver(false)
      }}
      onDrop={(e) => {
        const lutId = e.dataTransfer.getData(LUT_DRAG_TYPE)
        e.preventDefault()
        setOver(false)
        if (lutId) onDropLut(lutId)
      }}
    >
      {children}
    </section>
  )
}

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
  // Progress across a whole batch, not a bare boolean: picking twelve .cube
  // files and watching one spinner say nothing for a minute is worse than
  // watching a count.
  const [uploading, setUploading] = React.useState<{ done: number; total: number } | null>(null)
  // Per file, not one aggregate line. Two bad .cubes in a batch of ten must
  // name themselves; the other eight are already in the library by then.
  const [uploadErrors, setUploadErrors] = React.useState<{ file: string; detail: string }[]>([])
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

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // let the same files be re-picked after a failure
    if (files.length === 0) return

    setUploadErrors([])
    setUploading({ done: 0, total: files.length })

    // Sequential on purpose. /me/luts is one small text upload per call, the
    // count is a user-picked handful, and a failure has to be attributable to
    // its own file -- none of which a parallel burst buys anything for.
    const failures: { file: string; detail: string }[] = []
    let succeeded = 0
    for (const file of files) {
      try {
        const form = new FormData()
        form.append('file', file)
        await api.upload<Lut>('/me/luts', form)
        succeeded += 1
      } catch (err: unknown) {
        const detail = err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : 'Upload failed'
        failures.push({ file: file.name, detail })
      }
      setUploading((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
    }

    setUploading(null)
    setUploadErrors(failures)
    // One refresh for the batch. Nothing to refresh if every file failed.
    if (succeeded > 0) await refreshAll()
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

  /** The same PATCH the ⋯ menu's "Move to group" already sends. Drag is a
   *  second path to one mutation, not a second mutation. */
  const moveLutToGroup = React.useCallback(
    async (lutId: string, groupId: string | null) => {
      const current = (luts ?? []).find((l) => l.id === lutId)
      // Dropping a LUT back where it already is is not a change.
      if (!current || (current.group_id ?? null) === groupId) return
      await api.patch(`/me/luts/${lutId}`, { group_id: groupId })
      await refreshAll()
    },
    [luts, refreshAll],
  )

  /** Dropping onto the pinned section promotes, matching the row's own
   *  Platform button. Demoting by dragging back out isn't offered: a promoted
   *  LUT is still someone's own row underneath, so "out" has no one target. */
  const promoteLutToPlatform = React.useCallback(
    async (lutId: string) => {
      const current = (luts ?? []).find((l) => l.id === lutId)
      if (!current || current.is_platform_wide) return
      await api.patch(`/me/luts/${lutId}`, { is_platform_wide: true })
      await refreshAll()
    },
    [luts, refreshAll],
  )

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
        <input
          ref={fileRef}
          type="file"
          accept=".cube"
          multiple
          onChange={handleFiles}
          className="hidden"
        />
        <Button size="sm" variant="secondary" onClick={() => setNewGroupOpen(true)}>
          <FolderPlus className="h-4 w-4" />
          New group
        </Button>
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading !== null}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading && uploading.total > 1
            ? `Uploading ${uploading.done + 1}/${uploading.total}`
            : 'Upload .cube'}
        </Button>
      </div>

      {uploadErrors.length > 0 && (
        <div className="space-y-1 rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2">
          {uploadErrors.map((f) => (
            <p key={f.file} className="text-xs text-red-400">
              <span className="font-medium">{f.file}</span> — {f.detail}
            </p>
          ))}
        </div>
      )}

      {/* ── Pinned Platform LUTs ──
          Always at the very top, always expanded, shown to every user.
          Superadmins get the full controls; everyone else sees it read-only,
          since these aren't their LUTs to manage. */}
      <LutDropZone
        enabled={isSuperAdmin}
        onDropLut={(lutId) => void promoteLutToPlatform(lutId)}
        className="space-y-3"
      >
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
              ? 'No platform LUTs yet. Drag one here, or use the Platform button on any of your LUTs.'
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
                // Dragging a promoted LUT back out isn't offered -- see
                // promoteLutToPlatform.
                canDrag={false}
              />
            ))}
          </div>
        )}
      </LutDropZone>

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
              <LutDropZone
                key={group.id}
                enabled
                onDropLut={(lutId) => void moveLutToGroup(lutId, group.id)}
                className="space-y-3"
              >
                <GroupHeader
                  group={group}
                  count={members.length}
                  onChanged={refreshAll}
                  onDelete={() => setDeletingGroup(group)}
                />
                {members.length === 0 ? (
                  <p className="text-xs text-text-tertiary">
                    Empty — drag a LUT here, or move it from its ⋯ menu.
                  </p>
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
                        canDrag
                      />
                    ))}
                  </div>
                )}
              </LutDropZone>
            )
          })}

          {/* Rendered even when empty as soon as a group exists: it is the
              only drop target that takes a LUT back out of a group. */}
          {(ungrouped.length > 0 || groupList.length > 0) && (
            <LutDropZone
              enabled
              onDropLut={(lutId) => void moveLutToGroup(lutId, null)}
              className="space-y-3"
            >
              {groupList.length > 0 && (
                <h2 className="text-sm font-semibold text-text-primary">Ungrouped</h2>
              )}
              {ungrouped.length === 0 ? (
                <p className="text-xs text-text-tertiary">
                  Empty — drag a LUT here, or move it from its ⋯ menu.
                </p>
              ) : (
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
                      canDrag
                    />
                  ))}
                </div>
              )}
            </LutDropZone>
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
  canDrag,
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
  /** False on the pinned Platform rows, which have nowhere meaningful to be
   *  dragged to. */
  canDrag: boolean
}) {
  const [busy, setBusy] = React.useState(false)
  const [renaming, setRenaming] = React.useState(false)
  const [draftName, setDraftName] = React.useState(lut.name)
  // Renaming starts when the ⋯ menu has finished closing, not when its item
  // is selected. Opening the input underneath a closing menu put it in the
  // path of Radix's focus restoration, which blurred it -- and blur commits,
  // so the field closed itself before a key could be pressed.
  const renameOnMenuClose = React.useRef(false)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      await api.patch(`/me/luts/${lut.id}`, body)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function commitRename() {
    const name = draftName.trim()
    setRenaming(false)
    // An unchanged or emptied name is a cancel, not a PATCH.
    if (!name || name === lut.name) return
    await patch({ name })
  }

  return (
    <div
      // Renaming turns dragging off: dragging is how you select text in the
      // input, and a row that flies away mid-edit is unusable.
      draggable={canDrag && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(LUT_DRAG_TYPE, lut.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={cn(
        'flex items-center gap-3 p-4 rounded-lg border border-border bg-bg-secondary',
        canDrag && !renaming && 'cursor-grab active:cursor-grabbing',
      )}
    >
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
          {renaming ? (
            // Same inline-rename shape folder-tree.tsx already uses: commit on
            // Enter or blur, abandon on Escape.
            <input
              className="min-w-0 flex-1 border-b border-accent bg-transparent px-0.5 text-sm text-text-primary outline-none"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') {
                  setDraftName(lut.name)
                  setRenaming(false)
                }
              }}
              aria-label={`Rename ${lut.name}`}
              autoFocus
            />
          ) : (
            <h3 className="text-sm font-medium text-text-primary truncate">{lut.name}</h3>
          )}
          {lut.is_platform_wide && !renaming && (
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
          {canTogglePlatform && (
            // Promoted out of the ⋯ menu for the same reason SharePopover was:
            // a superadmin could not find it in there. Its border carries the
            // current state, matching SharePopover's own active treatment,
            // rather than being a static verb that never reflects anything.
            <button
              onClick={() => void patch({ is_platform_wide: !lut.is_platform_wide })}
              disabled={busy}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors shrink-0 disabled:opacity-60',
                lut.is_platform_wide
                  ? 'border-accent text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary',
              )}
              aria-label={
                lut.is_platform_wide
                  ? `Remove ${lut.name} from ${PLATFORM_SECTION_LABEL}`
                  : `Make ${lut.name} platform-wide`
              }
              aria-pressed={lut.is_platform_wide}
            >
              <Globe className="h-3.5 w-3.5" />
              Platform
            </button>
          )}

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
                onCloseAutoFocus={(e) => {
                  if (!renameOnMenuClose.current) return
                  renameOnMenuClose.current = false
                  // Keep focus off the trigger; the input takes it instead.
                  e.preventDefault()
                  setDraftName(lut.name)
                  setRenaming(true)
                }}
                className="z-[100] w-56 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1"
              >
                {/* No platform item here any more: it has its own always-visible
                    button above, and two paths to one action is exactly what
                    made it undiscoverable. */}
                <DropdownMenu.Item
                  onSelect={() => {
                    renameOnMenuClose.current = true
                  }}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                  Rename
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />

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

// ─── Group header ────────────────────────────────────────────────────────────

/**
 * A group's name, count and its two actions.
 *
 * Rename is inline rather than a dialog, matching folder-tree.tsx's own
 * pattern — and PATCH /me/lut-groups/{id} already existed for it, so this was
 * only ever a missing affordance. Groups come from /me/lut-groups, which
 * returns the caller's own only, so there is no owner gate to apply here that
 * the query hasn't already applied.
 */
function GroupHeader({
  group,
  count,
  onChanged,
  onDelete,
}: {
  group: LutGroup
  count: number
  onChanged: () => void | Promise<void>
  onDelete: () => void
}) {
  const [renaming, setRenaming] = React.useState(false)
  const [draftName, setDraftName] = React.useState(group.name)

  async function commitRename() {
    const name = draftName.trim()
    setRenaming(false)
    if (!name || name === group.name) return
    await api.patch(`/me/lut-groups/${group.id}`, { name })
    await onChanged()
  }

  return (
    <div className="flex items-center gap-2">
      {renaming ? (
        <input
          className="min-w-0 flex-1 border-b border-accent bg-transparent px-0.5 text-sm font-semibold text-text-primary outline-none"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') {
              setDraftName(group.name)
              setRenaming(false)
            }
          }}
          aria-label={`Rename ${group.name}`}
          autoFocus
        />
      ) : (
        <>
          <h2 className="text-sm font-semibold text-text-primary">{group.name}</h2>
          <span className="text-xs text-text-tertiary">{count}</span>
        </>
      )}
      <button
        onClick={() => {
          setDraftName(group.name)
          setRenaming(true)
        }}
        aria-label={`Rename group ${group.name}`}
        className="ml-auto text-xs text-text-tertiary hover:text-text-primary transition-colors"
      >
        Rename
      </button>
      <button
        onClick={onDelete}
        className="text-xs text-text-tertiary hover:text-status-error transition-colors"
      >
        Delete group
      </button>
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
