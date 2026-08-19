'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
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
  FolderUp,
  ChevronDown,
  Pencil,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/shared/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CollapsibleSection } from '@/components/shared/collapsible-section'
import { SortControl, sortRows, useSort, useSortState } from '@/components/shared/sortable'
import { readDroppedEntries } from '@/lib/read-dropped-entries'
import { LutThumbnail } from '@/components/shared/lut-thumbnail'
import { LutPreviewDialog } from '@/components/shared/lut-preview-dialog'
import { useAuthStore } from '@/stores/auth-store'
import type { Lut, LutGroup, Project } from '@/types'

// The literal label the user chose. Not "Superadmin LUTs", not "Global" --
// this wording was decided, not a placeholder.
const PLATFORM_SECTION_LABEL = 'Platform LUTs'

/** Private drag types rather than application/json, so a section only lights
 *  up for a LUT being dragged -- dragging a file in from the desktop, or an
 *  asset from elsewhere in the app, must not look like a valid drop here.
 *  The id is unreadable during dragover (only the type list is), which is
 *  exactly why the type has to carry the meaning.
 *
 *  Two of them, because a personal group must refuse a platform LUT: dragging
 *  one *out* of Platform is deliberately not a thing (§34 revision), and
 *  gating on the type means the zone never lights up for it rather than
 *  accepting a drop the server would reject. */
/** Mirrors MAX_CUBE_BYTES in apps/api/routers/luts.py. Checked here as well
 *  as there so an oversized file is refused before it is streamed up (§42) —
 *  the server's answer is authoritative, this one is just not wasting the
 *  upload. */
const MAX_CUBE_BYTES = 1 * 1024 * 1024 * 1024

/** Case-insensitive, because a card written on Windows is as likely to say
 *  .CUBE. Everything else in a dropped folder is ignored rather than
 *  reported — same spirit as the camera-card junk handling in §23. */
function isCube(name: string) {
  return name.toLowerCase().endsWith('.cube')
}

const LUT_DRAG_TYPE = 'application/x-freeframe-lut'
const PLATFORM_LUT_DRAG_TYPE = 'application/x-freeframe-platform-lut'
/** A whole group being dragged (§41). Its own type rather than overloading
 *  the LUT one: a group id and a LUT id are not interchangeable, and the drop
 *  handler has to know which it has before deciding what to do. */
const GROUP_DRAG_TYPE = 'application/x-freeframe-lut-group'

/**
 * A section that accepts a dragged LUT.
 *
 * A component rather than a hook because the group sections are rendered from
 * a map, and a hook cannot be called in a loop.
 */
function LutDropZone({
  enabled,
  accept = [LUT_DRAG_TYPE],
  dragType,
  dragId,
  onDropLut,
  onDropGroup,
  className,
  children,
}: {
  /** False renders a plain section with no drop behaviour and no affordance
   *  -- which is how a non-superadmin sees the Platform section. */
  enabled: boolean
  /** Which kinds of LUT this zone takes. A personal group takes personal
   *  LUTs only; the platform side takes both, promoting a personal one. */
  accept?: string[]
  /** Set to make this section itself draggable (§41's whole-group drag). */
  dragType?: string
  dragId?: string
  onDropLut: (lutId: string, fromPlatform: boolean) => void
  /** Only the Platform frame box takes a group drop. */
  onDropGroup?: (groupId: string) => void
  className?: string
  children: React.ReactNode
}) {
  const [over, setOver] = React.useState(false)

  const dragProps = dragType
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData(dragType, dragId ?? '')
          e.dataTransfer.effectAllowed = 'move'
          // Otherwise the LUT rows inside also start their own drag as the
          // pointer crosses them.
          e.stopPropagation()
        },
      }
    : {}

  if (!enabled) {
    return (
      <section className={className} {...dragProps}>
        {children}
      </section>
    )
  }

  return (
    <section
      {...dragProps}
      className={cn(
        className,
        'rounded-lg transition-shadow',
        over && 'ring-2 ring-accent/50 bg-accent/5',
      )}
      data-drop-active={over ? 'true' : undefined}
      onDragOver={(e) => {
        if (!accept.some((type) => e.dataTransfer.types.includes(type))) return
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
        const type = accept.find((t) => e.dataTransfer.getData(t))
        const id = type ? e.dataTransfer.getData(type) : ''
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        if (!id) return
        if (type === GROUP_DRAG_TYPE) onDropGroup?.(id)
        else onDropLut(id, type === PLATFORM_LUT_DRAG_TYPE)
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
  // One shared set for everyone, not a per-superadmin view (§39) -- which is
  // exactly why this is a separate endpoint from /me/lut-groups rather than
  // a filter on it.
  const { data: platformGroups, mutate: mutatePlatformGroups } = useSWR<LutGroup[]>(
    '/luts/platform-groups',
    (key: string) => api.get<LutGroup[]>(key),
  )
  const { data: projects } = useSWR<Project[]>(
    '/projects',
    (key: string) => api.get<Project[]>(key),
  )

  const fileRef = React.useRef<HTMLInputElement>(null)
  const folderRef = React.useRef<HTMLInputElement>(null)
  // Progress across a whole batch, not a bare boolean: picking twelve .cube
  // files and watching one spinner say nothing for a minute is worse than
  // watching a count.
  const [uploading, setUploading] = React.useState<{ done: number; total: number } | null>(null)
  // Per file, not one aggregate line. Two bad .cubes in a batch of ten must
  // name themselves; the other eight are already in the library by then.
  // `kind` separates a duplicate (409 — nothing went wrong, the LUT is
  // already there) from a real failure, because reporting "you already have
  // this" in red reads as something being broken (§44).
  const [uploadErrors, setUploadErrors] = React.useState<
    { file: string; detail: string; kind: 'duplicate' | 'error' }[]
  >([])
  // A promote/patch that the server refused — a duplicate on the platform
  // list, most often. Shown in the same panel as the upload results rather
  // than being swallowed, which is what happened before §44 gave PATCH a
  // reason to fail that the user can act on.
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [dropActive, setDropActive] = React.useState(false)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  // Which nested sections are folded up right now, reported by the sections
  // themselves — reading localStorage during render would go stale, since a
  // child toggling its own state does not re-render this page (§41).
  const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(new Set())
  // Offered after a folder upload finishes, once for the batch (§42).
  const [groupPrompt, setGroupPrompt] = React.useState<
    { folderName: string; lutIds: string[] } | null
  >(null)
  const [deleting, setDeleting] = React.useState<Lut | null>(null)
  // Which LUT's frame is open in the zoom dialog. One dialog for the page,
  // the same way `deleting` is one ConfirmDialog rather than one per row.
  const [previewing, setPreviewing] = React.useState<Lut | null>(null)
  const [deletingGroup, setDeletingGroup] = React.useState<LutGroup | null>(null)
  // Which library the inline "new group" form is creating into, or null when
  // it is closed. Platform groups are superadmin-only, gated at the button.
  const [newGroupIn, setNewGroupIn] = React.useState<'personal' | 'platform' | null>(null)
  const [newGroupName, setNewGroupName] = React.useState('')
  // The Main group a new group is being created under, or null for a
  // top-level one (§45). Set by a group's own "New sub-group" action, so the
  // parent is never something the user has to pick out of a list.
  const [newGroupParent, setNewGroupParent] = React.useState<string | null>(null)

  const refreshAll = React.useCallback(async () => {
    await Promise.all([mutate(), mutatePlatform(), mutateGroups(), mutatePlatformGroups()])
  }, [mutate, mutatePlatform, mutateGroups, mutatePlatformGroups])

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // let the same files be re-picked after a failure
    await uploadFiles(files)
  }

  /** The folder picker and a folder drop both land here. `webkitRelativePath`
   *  is what the directory input gives instead of a folder handle. */
  async function handleFolderInput(e: React.ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.target.files ?? [])
    const folderName = all[0]?.webkitRelativePath?.split('/')[0] ?? null
    e.target.value = ''
    await uploadFiles(all.filter((f) => isCube(f.name)), folderName)
  }

  async function uploadFiles(files: File[], folderName: string | null = null) {
    if (files.length === 0) return

    // The dialog closes as soon as there is something to upload. Radix's
    // modal makes the rest of the page inert, so leaving it open would put
    // the per-file results and the group prompt behind an overlay the user
    // has to dismiss before they can see them. Progress is on the header
    // button meanwhile.
    setUploadOpen(false)
    setUploadErrors([])
    setActionError(null)
    setGroupPrompt(null)

    // Size is checked before anything is streamed. The server checks too;
    // this just avoids sending a gigabyte to be told no.
    const oversized = files.filter((f) => f.size > MAX_CUBE_BYTES)
    const sendable = files.filter((f) => f.size <= MAX_CUBE_BYTES)
    const failures: { file: string; detail: string; kind: 'duplicate' | 'error' }[] =
      oversized.map((f) => ({
        file: f.name,
        detail: 'Larger than the 1GB limit.',
        kind: 'error' as const,
      }))

    if (sendable.length === 0) {
      setUploadErrors(failures)
      return
    }

    setUploading({ done: 0, total: sendable.length })

    // Sequential on purpose. /me/luts is one small text upload per call, the
    // count is a user-picked handful, and a failure has to be attributable to
    // its own file -- none of which a parallel burst buys anything for.
    const uploaded: Lut[] = []
    let succeeded = 0
    for (const file of sendable) {
      try {
        const form = new FormData()
        form.append('file', file)
        const created = await api.upload<Lut>('/me/luts', form)
        if (created) uploaded.push(created)
        succeeded += 1
      } catch (err: unknown) {
        const detail = err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : 'Upload failed'
        const status = err && typeof err === 'object' && 'status' in err
          ? Number((err as { status: unknown }).status)
          : 0
        failures.push({ file: file.name, detail, kind: status === 409 ? 'duplicate' : 'error' })
      }
      setUploading((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
    }

    setUploading(null)
    setUploadErrors(failures)
    // One refresh for the batch. Nothing to refresh if every file failed.
    if (succeeded > 0) await refreshAll()

    // Asked once for the batch, after the uploads, and non-blocking: a modal
    // in front of a running upload would be the worst of both.
    if (folderName && uploaded.length > 0) {
      setGroupPrompt({ folderName, lutIds: uploaded.map((l) => l.id) })
    }
  }

  /** Accepts a folder as well as loose files; a folder is only visible
   *  through webkitGetAsEntry, since dataTransfer.files flattens it. */
  async function handleDrop(e: React.DragEvent) {
    // Not our own LUT drags — those are handled by the section drop zones.
    if (e.dataTransfer.types.some((t) => t.startsWith('application/x-freeframe'))) return
    e.preventDefault()
    setDropActive(false)

    const dropped = await readDroppedEntries(e.dataTransfer)
    if (dropped === null) {
      // This browser did not populate `items`; the flat list is all there is.
      await uploadFiles(Array.from(e.dataTransfer.files ?? []).filter((f) => isCube(f.name)))
      return
    }

    // A single dropped folder names the group; several at once has no one
    // name to offer, so the prompt is skipped rather than guessing.
    const roots = new Set(dropped.map((d) => d.path[0]).filter(Boolean))
    await uploadFiles(
      dropped.map((d) => d.file).filter((f) => isCube(f.name)),
      roots.size === 1 ? Array.from(roots)[0]! : null,
    )
  }

  async function createGroupFromFolder() {
    if (!groupPrompt) return
    const prompt = groupPrompt
    setGroupPrompt(null)
    const group = await api.post<LutGroup>('/me/lut-groups', {
      name: prompt.folderName,
      parent_group_id: null,
    })
    // Sequentially, for the same reason the uploads are: one refusal has to
    // be attributable, and this is a handful of rows.
    for (const lutId of prompt.lutIds) {
      await api.patch(`/me/luts/${lutId}`, { group_id: group.id })
    }
    await refreshAll()
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
    await api.delete(
      target.is_platform
        ? `/luts/platform-groups/${target.id}`
        : `/me/lut-groups/${target.id}`,
    )
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

  /** Dropping onto a platform group. A LUT dragged up from the personal
   *  library is promoted and filed in one PATCH — the server checks the pair
   *  against what the request leaves behind, so both fields together are
   *  valid where either alone would not be. */
  const moveLutToPlatformGroup = React.useCallback(
    async (lutId: string, groupId: string | null) => {
      const current = (luts ?? []).find((l) => l.id === lutId)
      if (!current) return
      const alreadyThere =
        current.is_platform_wide && (current.group_id ?? null) === groupId
      if (alreadyThere) return
      try {
        await api.patch(`/me/luts/${lutId}`, {
          group_id: groupId,
          ...(current.is_platform_wide ? {} : { is_platform_wide: true }),
        })
        setActionError(null)
      } catch (err: unknown) {
        setActionError(
          err && typeof err === 'object' && 'detail' in err
            ? String((err as { detail: unknown }).detail)
            : 'That LUT could not be moved.',
        )
        return
      }
      await refreshAll()
    },
    [luts, refreshAll],
  )

  /** Dropping onto the pinned section promotes, matching the row's own
   *  Platform button. Demoting by dragging back out isn't offered: a promoted
   *  LUT is still someone's own row underneath, so "out" has no one target. */
  /** One call, not N (§41): a partial failure halfway through would leave a
   *  group platform-wide with some of its LUTs still personal — a state
   *  nothing in the UI can explain. Duplicates inside it are skipped and
   *  reported rather than failing the whole drag. */
  const promoteGroupToPlatform = React.useCallback(
    async (groupId: string) => {
      try {
        const result = await api.post<{ promoted: number; skipped: string[] }>(
          `/luts/platform-groups/promote/${groupId}`,
          {},
        )
        setActionError(
          result?.skipped?.length
            ? `Promoted ${result.promoted}. Left behind: ${result.skipped.join('; ')}`
            : null,
        )
      } catch (err: unknown) {
        setActionError(
          err && typeof err === 'object' && 'detail' in err
            ? String((err as { detail: unknown }).detail)
            : 'That group could not be promoted.',
        )
        return
      }
      await refreshAll()
    },
    [refreshAll],
  )

  const promoteLutToPlatform = React.useCallback(
    async (lutId: string) => {
      const current = (luts ?? []).find((l) => l.id === lutId)
      if (!current || current.is_platform_wide) return
      try {
        // No group_id sent: the server drops a personal group the LUT no
        // longer belongs in rather than leaving an invalid pair behind.
        await api.patch(`/me/luts/${lutId}`, { is_platform_wide: true })
        setActionError(null)
      } catch (err: unknown) {
        setActionError(
          err && typeof err === 'object' && 'detail' in err
            ? String((err as { detail: unknown }).detail)
            : 'That LUT could not be promoted.',
        )
        return
      }
      await refreshAll()
    },
    [luts, refreshAll],
  )

  async function handleCreateGroup() {
    const name = newGroupName.trim()
    if (!name || !newGroupIn) return
    await api.post(
      newGroupIn === 'platform' ? '/luts/platform-groups' : '/me/lut-groups',
      { name, parent_group_id: newGroupParent },
    )
    setNewGroupName('')
    setNewGroupIn(null)
    setNewGroupParent(null)
    await refreshAll()
  }

  const ownLuts = luts ?? []
  const platform = platformLuts ?? []
  // Own LUTs already promoted into the pinned section aren't repeated below.
  const platformIds = new Set(platform.map((l) => l.id))
  const ownNotPlatform = ownLuts.filter((l) => !platformIds.has(l.id))

  const allGroups = React.useMemo(
    () => [...(groups ?? []), ...(platformGroups ?? [])],
    [groups, platformGroups],
  )
  const memberCount = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const lut of [...(luts ?? []), ...(platformLuts ?? [])]) {
      if (lut.group_id) counts.set(lut.group_id, (counts.get(lut.group_id) ?? 0) + 1)
    }
    return counts
  }, [luts, platformLuts])

  // Two independent sorts, as asked: one orders the groups, the other orders
  // the LUTs inside every group and section. They share no state, so changing
  // one never reorders the other.
  const { sorted: sortedGroups, sort: groupSort } = useSort(
    allGroups,
    {
      name: (g: LutGroup) => g.name,
      size: (g: LutGroup) => memberCount.get(g.id) ?? 0,
    },
    { key: 'name' },
  )
  const lutSortAccessors = React.useMemo(
    () => ({
      name: (l: Lut) => l.name,
      size: (l: Lut) => l.lut_size ?? null,
      added: (l: Lut) => l.created_at,
    }),
    [],
  )
  // One sort applied to every list of LUTs on the page. Per-group sort state
  // was considered and rejected: eight groups in eight different orders is
  // harder to read than one, and the ask was "sort inside LUT groups", not
  // "sort each group differently".
  const lutSort = useSortState<'name' | 'size' | 'added'>('name')
  const sortLuts = React.useCallback(
    (rows: Lut[]) => sortRows(rows, lutSortAccessors, lutSort),
    [lutSortAccessors, lutSort],
  )

  const orderedGroups = (platformSide: boolean) =>
    sortedGroups.filter((g) => Boolean(g.is_platform) === platformSide)

  // Every group of that kind, flat — what the ⋯ menu's "Move to group" list
  // and the sub-group parent picker read.
  const groupList = orderedGroups(false)
  const platformGroupList = orderedGroups(true)
  // ...and just the Main ones, which is what the tree iterates (§45).
  const mainGroups = groupList.filter((g) => !g.parent_group_id)
  const platformMainGroups = platformGroupList.filter((g) => !g.parent_group_id)
  /** How many of a side's nested sections are currently collapsed.
   *
   *  The count badge on a frame box is the true total (§41's "8 vs 4" report
   *  was a collapsed nested group, not a missing row). Rather than making the
   *  badge mean "visible right now" — which would then disagree with the
   *  server and change meaning as you click around — the frame box says how
   *  many groups are folded up, so "8" and four visible rows stops reading as
   *  four rows lost. Read from localStorage directly because that is where
   *  CollapsibleSection keeps it; re-read on every render, which is cheap and
   *  keeps it honest as sections are toggled.
   */
  const noteCollapsed = React.useCallback((key: string, collapsed: boolean) => {
    setCollapsedKeys((prev) => {
      if (prev.has(key) === collapsed) return prev
      const next = new Set(prev)
      if (collapsed) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const collapsedCount = (keys: string[]) => keys.filter((k) => collapsedKeys.has(k)).length

  const privateHidden = collapsedCount([
    ...groupList.map((g) => `luts-group-${g.id}`),
    'luts-ungrouped',
  ])
  const platformHidden = collapsedCount([
    ...platformGroupList.map((g) => `luts-group-${g.id}`),
    'luts-platform-ungrouped',
  ])

  const parentName = newGroupParent
    ? allGroups.find((g) => g.id === newGroupParent)?.name
    : undefined
  const subGroupsOf = (parentId: string, platformSide: boolean) =>
    (platformSide ? platformGroupList : groupList).filter(
      (g) => g.parent_group_id === parentId,
    )
  const ungrouped = sortLuts(ownNotPlatform.filter((l) => !l.group_id))
  const platformUngrouped = sortLuts(platform.filter((l) => !l.group_id))

  /**
   * One group and, beneath it, its sub-groups (§45). Recursive in shape but
   * capped at one level by the server, so a sub-group is rendered with
   * `nested` and never asks for children of its own.
   *
   * The same function draws both sides: they differ only in which drop
   * mutation runs and who may manage them, which is what the arguments are.
   */
  const renderGroupTree = (
    group: LutGroup,
    opts: {
      platformSide: boolean
      canManage: boolean
      renderRow: (lut: Lut) => React.ReactNode
      luts: Lut[]
      nested?: boolean
    },
  ): React.ReactNode => {
    const { platformSide, canManage, renderRow, luts: pool, nested } = opts
    const members = sortLuts(pool.filter((l) => l.group_id === group.id))
    const children = nested ? [] : subGroupsOf(group.id, platformSide)

    return (
      <LutDropZone
        key={group.id}
        // A whole personal Main group can be dragged onto Platform (§41).
        // Sub-groups cannot: they would land platform-side with a personal
        // parent, which §45's pairing rule forbids and the server refuses.
        dragType={!platformSide && !nested && isSuperAdmin ? GROUP_DRAG_TYPE : undefined}
        dragId={group.id}
        enabled={platformSide ? canManage : true}
        accept={platformSide ? [LUT_DRAG_TYPE, PLATFORM_LUT_DRAG_TYPE] : [LUT_DRAG_TYPE]}
        onDropLut={(lutId) =>
          void (platformSide
            ? moveLutToPlatformGroup(lutId, group.id)
            : moveLutToGroup(lutId, group.id))
        }
        className="space-y-3"
      >
        <GroupSection
          group={group}
          count={members.length}
          canManage={canManage}
          onChanged={refreshAll}
          onDelete={() => setDeletingGroup(group)}
          onCollapsedChange={noteCollapsed}
          onAddSubGroup={
            // Only a Main group may gain one; the server would refuse a
            // deeper nesting anyway, so the action is not offered.
            nested
              ? undefined
              : () => {
                  setNewGroupName('')
                  setNewGroupIn(platformSide ? 'platform' : 'personal')
                  setNewGroupParent(group.id)
                }
          }
        >
          {members.length === 0 && children.length === 0 ? (
            <p className="text-xs text-text-tertiary">
              Empty — drag a LUT here, or move it from its ⋯ menu.
            </p>
          ) : (
            <div className="space-y-3">
              {members.map((lut) => renderRow(lut))}
              {children.length > 0 && (
                // Indented, so a sub-group reads as inside its parent rather
                // than as another group that happens to follow it.
                <div className="space-y-3 border-l border-border pl-3">
                  {children.map((child) =>
                    renderGroupTree(child, { ...opts, nested: true }),
                  )}
                </div>
              )}
            </div>
          )}
        </GroupSection>
      </LutDropZone>
    )
  }

  const renderPersonalRow = (lut: Lut) => (
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
      onError={setActionError}
    />
  )

  /** One row in the Platform section. Read-only for non-superadmins even when
   *  they happen to own it: managing a published platform LUT is a superadmin
   *  action. A superadmin can only drag their OWN — PATCH /me/luts is
   *  owner-scoped server-side, so offering the drag on someone else's row
   *  would offer a 404. */
  const renderPlatformRow = (lut: Lut) => (
    <LutRow
      key={lut.id}
      lut={lut}
      groups={platformGroupList}
      projects={projects ?? []}
      canManage={isSuperAdmin && lut.is_owner}
      canTogglePlatform={isSuperAdmin}
      // Deliberate: no relative-time label on Platform LUT rows. created_at
      // is still stored and still drives sort order -- this is display-only.
      showTimestamp={false}
      onChanged={refreshAll}
      onDelete={() => setDeleting(lut)}
      onPreview={() => setPreviewing(lut)}
      // Draggable between platform groups, not out of Platform: the zones
      // that accept this drag type are all on the platform side.
      canDrag={isSuperAdmin && lut.is_owner}
      onError={setActionError}
    />
  )

  /** Declared once and rendered inside the upload dialog — the same zone,
   *  not a second copy that could drift (§48-REVISED). */
  const dropZone = (
    // Deliberately ignores this page's own LUT drags, which the section drop
    // zones own — otherwise dragging a LUT between groups would look like an
    // upload.
    <div
      data-testid="lut-drop-zone"
      data-drop-active={dropActive ? 'true' : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.some((t) => t.startsWith('application/x-freeframe'))) return
        e.preventDefault()
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropActive(false)
      }}
      onDrop={(e) => void handleDrop(e)}
      className={cn(
        'rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-text-tertiary transition-colors',
        dropActive && 'border-accent bg-accent/5 text-text-primary',
      )}
    >
      Drop .cube files or a whole folder here. Anything that isn&apos;t a
      .cube is ignored.
    </div>
  )

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
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setNewGroupName('')
            setNewGroupParent(null)
            setNewGroupIn('personal')
          }}
        >
          <FolderPlus className="h-4 w-4" />
          New Private Group
        </Button>
        {/* Beside its counterpart rather than buried at the bottom of the
            Platform section (§41). Moving it changes where it is, not who
            sees it — still superadmin-only. */}
        {isSuperAdmin && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setNewGroupName('')
              setNewGroupParent(null)
              setNewGroupIn('platform')
            }}
          >
            <Globe className="h-4 w-4" />
            New Platform Group
          </Button>
        )}
        <Button size="sm" onClick={() => setUploadOpen(true)} disabled={uploading !== null}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading && uploading.total > 1
            ? `Uploading ${uploading.done + 1}/${uploading.total}`
            : 'Upload'}
        </Button>
      </div>

      {/* Same Dialog shape as the project uploader (projects/[id]/page.tsx),
          so the two uploaders feel like one feature rather than two.

          Two browse buttons, not one: macOS Chromium's webkitdirectory
          dialog happens to allow picking loose files too, but Windows'
          genuinely blocks it — and blocks folder selection in the plain
          picker. WeTransfer ships the same split for the same reason
          (§48-REVISED, confirmed by the user testing both OSes). */}
      <Dialog.Root open={uploadOpen} onOpenChange={setUploadOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
            <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
            <Dialog.Title className="text-base font-semibold text-text-primary">
              Upload LUTs
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-text-secondary">
              Add .cube files to your library, or a whole folder of them.
            </Dialog.Description>

            <div className="mt-4 space-y-3">
              {/* Inside the dialog, with the buttons that drive them: Radix's
                  modal makes everything outside it inert, and an input the
                  user cannot reach is a trap waiting for the day someone
                  clicks it directly. */}
              <input
                ref={fileRef}
                type="file"
                accept=".cube"
                multiple
                onChange={handleFiles}
                className="hidden"
              />
              <input
                ref={folderRef}
                type="file"
                // Non-standard attributes, and the only way to offer a folder
                // in a file picker. React needs them spelled this way.
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                multiple
                onChange={handleFolderInput}
                className="hidden"
              />
              {dropZone}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading !== null}
                >
                  <Upload className="h-4 w-4" />
                  Add files
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => folderRef.current?.click()}
                  disabled={uploading !== null}
                >
                  <FolderUp className="h-4 w-4" />
                  Add folder
                </Button>
                {uploading && (
                  <span className="text-xs text-text-tertiary tabular-nums">
                    Uploading {uploading.done + 1}/{uploading.total}
                  </span>
                )}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {groupPrompt && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2">
          <p className="text-xs text-text-secondary">
            Put the {groupPrompt.lutIds.length} LUT
            {groupPrompt.lutIds.length === 1 ? '' : 's'} from{' '}
            <span className="font-medium text-text-primary">{groupPrompt.folderName}</span>{' '}
            into a group of that name?
          </p>
          <Button size="sm" onClick={() => void createGroupFromFolder()}>
            Create group
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setGroupPrompt(null)}>
            No thanks
          </Button>
        </div>
      )}

      {uploadErrors.length > 0 && (
        <div className="space-y-1 rounded-md border border-border bg-bg-secondary px-3 py-2">
          {uploadErrors.map((f) => (
            <p
              key={f.file}
              data-kind={f.kind}
              className={cn(
                'text-xs',
                f.kind === 'duplicate' ? 'text-text-tertiary' : 'text-red-400',
              )}
            >
              <span className="font-medium">{f.file}</span>
              {f.kind === 'duplicate' ? ' — already in your library. ' : ' — '}
              {f.detail}
            </p>
          ))}
        </div>
      )}

      {actionError && (
        <p className="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-400">
          {actionError}
        </p>
      )}

      {/* Two independent controls, as asked: one orders the groups, the other
          orders the LUTs inside every group and section. */}
      {(groupList.length > 0 || platformGroupList.length > 0 || ownNotPlatform.length > 0 || platform.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {(groupList.length > 0 || platformGroupList.length > 0) && (
            <SortControl
              label="Groups"
              sort={groupSort}
              options={[
                { key: 'name', label: 'Name' },
                { key: 'size', label: 'LUTs' },
              ]}
            />
          )}
          <SortControl
            label="LUTs"
            sort={lutSort}
            options={[
              { key: 'name', label: 'Name' },
              { key: 'size', label: 'Size' },
              { key: 'added', label: 'Added' },
            ]}
          />
        </div>
      )}

      {/* ── Pinned Platform LUTs ──
          Always at the very top, always expanded, shown to every user.
          Superadmins get the full controls; everyone else sees it read-only,
          since these aren't their LUTs to manage. */}
      <LutDropZone
        enabled={isSuperAdmin}
        accept={[LUT_DRAG_TYPE, GROUP_DRAG_TYPE]}
        onDropLut={(lutId) => void promoteLutToPlatform(lutId)}
        onDropGroup={(groupId) => void promoteGroupToPlatform(groupId)}
        className="space-y-3"
      >
        <CollapsibleSection
          tone="block"
          storageKey="luts-platform"
          className="p-0"
          title={
            <span className="inline-flex items-center gap-2">
              <Globe className="h-3.5 w-3.5" />
              {PLATFORM_SECTION_LABEL}
            </span>
          }
          count={platform.length}
          hiddenNote={
            platformHidden > 0
              ? `${platformHidden} group${platformHidden === 1 ? '' : 's'} collapsed`
              : undefined
          }
          actions={
            <span className="text-xs text-text-tertiary">
              Available in every project, to everyone
            </span>
          }
        >
        <div className="space-y-3 p-4">
        {platform.length === 0 && platformGroupList.length === 0 ? (
          <p className="text-xs text-text-tertiary border border-border border-dashed rounded-lg px-3 py-4">
            {isSuperAdmin
              ? 'No platform LUTs yet. Drag one here, or use the Platform button on any of your LUTs.'
              : 'No platform LUTs have been published yet.'}
          </p>
        ) : (
          <div className="space-y-6">
            {platformMainGroups.map((group) =>
              renderGroupTree(group, {
                platformSide: true,
                canManage: isSuperAdmin,
                renderRow: renderPlatformRow,
                luts: platform,
              }),
            )}

            {/* Ungrouped platform LUTs. Rendered whenever a platform group
                exists, so a LUT can be dragged back out of one. */}
            {(platformUngrouped.length > 0 || platformGroupList.length > 0) && (
              <LutDropZone
                enabled={isSuperAdmin}
                accept={[LUT_DRAG_TYPE, PLATFORM_LUT_DRAG_TYPE]}
                onDropLut={(lutId) => void moveLutToPlatformGroup(lutId, null)}
                className="space-y-3"
              >
                {platformGroupList.length > 0 ? (
                  <CollapsibleSection
                    storageKey="luts-platform-ungrouped"
                    onCollapsedChange={(c) => noteCollapsed('luts-platform-ungrouped', c)}
                    title="Ungrouped"
                    count={platformUngrouped.length}
                    className="space-y-3"
                  >
                    {platformUngrouped.length === 0 ? (
                      <p className="text-xs text-text-tertiary">
                        {isSuperAdmin ? 'Empty — drag a LUT here.' : 'Empty.'}
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {platformUngrouped.map((lut) => renderPlatformRow(lut))}
                      </div>
                    )}
                  </CollapsibleSection>
                ) : (
                  <div className="space-y-3">
                    {platformUngrouped.map((lut) => renderPlatformRow(lut))}
                  </div>
                )}
              </LutDropZone>
            )}

          </div>
        )}
        </div>
        </CollapsibleSection>
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
        <CollapsibleSection
          tone="block"
          storageKey="luts-personal"
          title={
            <span className="inline-flex items-center gap-2">
              <SwatchBook className="h-3.5 w-3.5" />
              Private
            </span>
          }
          count={ownNotPlatform.length}
          hiddenNote={
            privateHidden > 0
              ? `${privateHidden} group${privateHidden === 1 ? '' : 's'} collapsed`
              : undefined
          }
          className="p-0"
        >
        <div className="space-y-6 p-4">
          {mainGroups.map((group) =>
            renderGroupTree(group, {
              platformSide: false,
              canManage: true,
              renderRow: renderPersonalRow,
              luts: ownNotPlatform,
            }),
          )}

          {/* Rendered even when empty as soon as a group exists: it is the
              only drop target that takes a LUT back out of a group. */}
          {(ungrouped.length > 0 || groupList.length > 0) && (
            <LutDropZone
              enabled
              onDropLut={(lutId) => void moveLutToGroup(lutId, null)}
              className="space-y-3"
            >
              <CollapsibleSection
                storageKey="luts-ungrouped"
                onCollapsedChange={(c) => noteCollapsed('luts-ungrouped', c)}
                title="Ungrouped"
                count={ungrouped.length}
                className="space-y-3"
              >
              {ungrouped.length === 0 ? (
                <p className="text-xs text-text-tertiary">
                  Empty — drag a LUT here, or move it from its ⋯ menu.
                </p>
              ) : (
                <div className="space-y-3">
                  {ungrouped.map((lut) => renderPersonalRow(lut))}
                </div>
              )}
              </CollapsibleSection>
            </LutDropZone>
          )}
        </div>
        </CollapsibleSection>
      )}

      {/* New group — the same form for both libraries; which one it creates
          into is `newGroupIn`, so there is one create path rather than two. */}
      {newGroupIn && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary p-3">
          <Input
            autoFocus
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreateGroup()
              if (e.key === 'Escape') {
                setNewGroupIn(null)
                setNewGroupParent(null)
              }
            }}
            placeholder={
              newGroupParent
                ? `Sub-group of ${parentName ?? 'group'}`
                : newGroupIn === 'platform'
                  ? 'Platform group name'
                  : 'Group name'
            }
            aria-label={
              newGroupParent
                ? 'New sub-group name'
                : newGroupIn === 'platform'
                  ? 'New platform group name'
                  : 'New group name'
            }
            className="h-8 text-xs"
          />
          <Button size="sm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
            Create
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNewGroupIn(null)
              setNewGroupParent(null)
            }}
          >
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
  onError,
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
  /** Surfaces a refused PATCH where the user can see it; null clears it. */
  onError: (message: string | null) => void
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
      onError(null)
      await onChanged()
    } catch (err: unknown) {
      // Promotion can legitimately be refused now (§44: already on the
      // platform list). Swallowing it would leave the button looking like
      // it did nothing.
      onError(
        err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : 'That change could not be saved.',
      )
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
        // The type says which library the LUT came from, so a personal group
        // never lights up for a platform LUT (§39). It is the only thing a
        // drop zone can read during dragover.
        e.dataTransfer.setData(
          lut.is_platform_wide ? PLATFORM_LUT_DRAG_TYPE : LUT_DRAG_TYPE,
          lut.id,
        )
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
                  {/* `groups` is whichever library this row lives in — a
                      platform LUT is only offered platform groups, matching
                      what the server will accept. */}
                  {lut.is_platform_wide ? 'Move to platform group' : 'Move to group'}
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

// ─── Group section ───────────────────────────────────────────────────────────

/**
 * One personal LUT group: a collapsible section whose header carries the
 * group's name, count and its two actions.
 *
 * Rename is inline rather than a dialog, matching folder-tree.tsx's own
 * pattern — and PATCH /me/lut-groups/{id} already existed for it, so this was
 * only ever a missing affordance. Groups come from /me/lut-groups, which
 * returns the caller's own only, so there is no owner gate to apply here that
 * the query hasn't already applied.
 *
 * While the name is being edited it moves out of the collapse toggle and into
 * `titleOverride` — an `<input>` cannot live inside a `<button>`.
 */
function GroupSection({
  group,
  count,
  canManage = true,
  onChanged,
  onDelete,
  onAddSubGroup,
  onCollapsedChange,
  children,
}: {
  group: LutGroup
  count: number
  /** Personal groups are always the viewer's own; a platform group is only
   *  editable by a superadmin, and shows no actions to anyone else. */
  canManage?: boolean
  onChanged: () => void | Promise<void>
  onDelete: () => void
  /** Undefined on a sub-group: one level only (§45), so the action is not
   *  offered where the server would refuse it. */
  onAddSubGroup?: () => void
  /** Reports fold state up to the page, which summarises it on the frame
   *  box (§41). */
  onCollapsedChange?: (key: string, collapsed: boolean) => void
  children: React.ReactNode
}) {
  const [renaming, setRenaming] = React.useState(false)
  const [draftName, setDraftName] = React.useState(group.name)

  async function commitRename() {
    const name = draftName.trim()
    setRenaming(false)
    if (!name || name === group.name) return
    await api.patch(
      group.is_platform
        ? `/luts/platform-groups/${group.id}`
        : `/me/lut-groups/${group.id}`,
      { name },
    )
    await onChanged()
  }

  return (
    <CollapsibleSection
      storageKey={`luts-group-${group.id}`}
      onCollapsedChange={(collapsed) => onCollapsedChange?.(`luts-group-${group.id}`, collapsed)}
      className="space-y-3"
      title={group.name}
      count={count}
      titleOverride={
        renaming && canManage ? (
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
        ) : undefined
      }
      actions={
        canManage ? (
          <>
            {onAddSubGroup && (
              <button
                onClick={onAddSubGroup}
                aria-label={`New sub-group in ${group.name}`}
                className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
              >
                New sub-group
              </button>
            )}
            <button
              onClick={() => {
                setDraftName(group.name)
                setRenaming(true)
              }}
              aria-label={`Rename group ${group.name}`}
              className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              Rename
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-text-tertiary hover:text-status-error transition-colors"
            >
              Delete group
            </button>
          </>
        ) : undefined
      }
    >
      {children}
    </CollapsibleSection>
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
