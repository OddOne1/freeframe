'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { X, ChevronDown, ArrowLeft, Users, Crown, Loader2, Check, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { ProjectRole, User } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectMembersDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
  /** Supplied by whichever parent renders both dialogs, so this one never
   *  has to import and render the other. Absent = no cross-nav offered. */
  onOpenSettings?: () => void
}

interface BulkResult {
  userId: string
  name: string
  ok: boolean
  error?: string
}

interface MemberWithUser {
  id: string
  user_id: string
  role: ProjectRole
  user: User
}

// 'owner' is deliberately excluded -- it's unique per project (the crown)
// and can only move via the Transfer Ownership flow, never this dropdown.
const ROLES: { value: ProjectRole; label: string; description: string }[] = [
  { value: 'admin', label: 'Manager', description: 'Can manage all resources within the project' },
  { value: 'editor', label: 'Edit & Share', description: 'Can manage resources, download, and share' },
  { value: 'reviewer', label: 'Comment Only', description: 'Can view and comment on the relevant resources' },
  { value: 'viewer', label: 'View Only', description: 'Can view the relevant resources' },
]

const OWNER_LABEL = 'Full Access'

function roleLabelFor(role: ProjectRole) {
  if (role === 'owner') return OWNER_LABEL
  return ROLES.find((r) => r.value === role)?.label ?? role
}

// ─── Role Dropdown ──────────────────────────────────────────────────────────

function RoleDropdown({
  value,
  onChange,
  compact,
  triggerLabel,
}: {
  value: ProjectRole
  onChange: (role: ProjectRole) => void
  compact?: boolean
  /** Overrides the trigger text. The bulk setter has no single current
   *  role to show, and rendering one would claim the selection already
   *  shares it. */
  triggerLabel?: string
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 text-accent hover:text-accent-hover font-medium transition-colors outline-none',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {triggerLabel ?? roleLabelFor(value)}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[200] w-72 rounded-xl border border-border bg-bg-secondary shadow-2xl py-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {ROLES.map((r) => (
            <DropdownMenu.Item
              key={r.value}
              onSelect={() => onChange(r.value)}
              className={cn(
                'flex items-start gap-3 px-3 py-2.5 cursor-pointer outline-none transition-colors mx-1 rounded-lg',
                value === r.value ? 'bg-bg-hover' : 'hover:bg-bg-hover',
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{r.label}</p>
                <p className="text-xs text-text-tertiary mt-0.5">{r.description}</p>
              </div>
              {value === r.value && <Check className="h-4 w-4 text-accent shrink-0 mt-0.5" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// ─── Add View ───────────────────────────────────────────────────────────────

function AddView({
  projectId,
  projectName,
  members: membersList,
  onSwitchToManage,
  onMemberAdded,
  canOpenSettings,
  onOpenSettings,
}: {
  projectId: string
  projectName: string
  members: MemberWithUser[]
  onSwitchToManage: () => void
  onMemberAdded: () => void
  canOpenSettings: boolean
  onOpenSettings?: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [role, setRole] = React.useState<ProjectRole>('editor')
  const [suggestions, setSuggestions] = React.useState<User[]>([])
  const [showSuggestions, setShowSuggestions] = React.useState(false)
  const [selectedUser, setSelectedUser] = React.useState<User | null>(null)
  const [message, setMessage] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Close suggestions on outside click
  React.useEffect(() => {
    if (!showSuggestions) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSuggestions])

  // Debounced user search
  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (query.length < 1) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    timerRef.current = setTimeout(async () => {
      try {
        const users = await api.get<User[]>(`/users/search?q=${encodeURIComponent(query)}`)
        // Filter out users already in the project
        const existingUserIds = new Set(membersList.map((m) => m.user_id))
        const filtered = users.filter((u) => !existingUserIds.has(u.id))
        setSuggestions(filtered)
        setShowSuggestions(filtered.length > 0)
      } catch {
        setSuggestions([])
      }
    }, 250)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  function handleSelectUser(user: User) {
    setSelectedUser(user)
    setQuery(user.name || user.email)
    setShowSuggestions(false)
    setSuggestions([])
  }

  async function handleAdd() {
    if (!selectedUser) return
    setAdding(true)
    setError(null)
    try {
      await api.post(`/projects/${projectId}/members`, {
        user_id: selectedUser.id,
        role,
      })
      setSelectedUser(null)
      setQuery('')
      setMessage('')
      onMemberAdded()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add member'
      setError(msg)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <div className="h-8 w-8 rounded-lg bg-accent/20 flex items-center justify-center">
          <Users className="h-4 w-4 text-accent" />
        </div>
        <Dialog.Title className="text-base font-semibold text-text-primary">
          Add to {projectName}
        </Dialog.Title>
      </div>

      {/* Search input with role dropdown */}
      <div className="px-6" ref={containerRef}>
        <div className="flex items-center gap-2 rounded-lg border-2 border-accent bg-bg-tertiary px-3 py-2 focus-within:border-accent">
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedUser(null)
              setError(null)
            }}
            placeholder="Name or email"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          <RoleDropdown value={role} onChange={setRole} />
        </div>
        <p className="mt-1.5 text-xs text-text-tertiary">Add a new or existing Member</p>

        {/* Suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-text-tertiary mb-1.5">Suggested</p>
            <div className="space-y-0.5">
              {suggestions.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => handleSelectUser(user)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover transition-colors text-left',
                    selectedUser?.id === user.id && 'bg-bg-hover',
                  )}
                >
                  <Avatar name={user.name} src={user.avatar_url} size="md" />
                  <span className="text-sm font-medium text-text-primary truncate">{user.name}</span>
                  <span className="text-sm text-text-tertiary truncate">{user.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-status-error">{error}</p>}
      </div>

      {/* Message field */}
      <div className="px-6 mt-4">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a message (optional)"
          rows={2}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-6 py-4">
        <Dialog.Close asChild>
          <Button variant="secondary" size="sm">Cancel</Button>
        </Dialog.Close>
        <Button
          size="sm"
          disabled={!selectedUser || adding}
          loading={adding}
          onClick={handleAdd}
        >
          Add
        </Button>
      </div>

      {/* Footer: member avatars + count + manage */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-bg-tertiary/50 rounded-b-xl">
        <div className="flex items-center gap-2">
          {membersList.length > 0 && (
            <div className="flex -space-x-2">
              {membersList.slice(0, 5).map((m) => (
                <Avatar key={m.id} name={m.user.name} src={m.user.avatar_url} size="sm" className="ring-2 ring-bg-secondary" />
              ))}
            </div>
          )}
          <span className="text-sm text-text-secondary font-medium">
            {membersList.length} Member{membersList.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {/* Same isProjectAdmin gate as everywhere else Settings opens. */}
          {canOpenSettings && onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary font-medium transition-colors"
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </button>
          )}
          <button
            type="button"
            onClick={onSwitchToManage}
            className="text-sm text-text-secondary hover:text-text-primary font-medium transition-colors"
          >
            Manage
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Manage View ────────────────────────────────────────────────────────────

function ManageView({
  projectId,
  projectName,
  members,
  canManageMembers,
  currentUserId,
  onBack,
  onMembersChanged,
  canOpenSettings,
  onOpenSettings,
}: {
  projectId: string
  projectName: string
  members: MemberWithUser[]
  /** Owner or admin — see the note where this is computed. */
  canManageMembers: boolean
  currentUserId: string
  /** Undefined when the viewer can't add members, so there is no Add tab
   *  to go back to. */
  onBack?: () => void
  onMembersChanged: () => void
  canOpenSettings: boolean
  onOpenSettings?: () => void
}) {
  const [removing, setRemoving] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [confirmingRemove, setConfirmingRemove] = React.useState(false)
  const [results, setResults] = React.useState<BulkResult[] | null>(null)

  // A member removed by someone else shouldn't stay selected and then be
  // acted on again; reconcile against whatever the list now says.
  React.useEffect(() => {
    const present = new Set(members.map((m) => m.user_id))
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((id) => present.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [members])

  /** Rows a bulk action may touch: never yourself, never the owner —
   *  mirroring the per-row guards rather than restating them, so the two
   *  can't drift apart. */
  const selectableIds = members
    .filter((m) => m.user_id !== currentUserId && m.role !== 'owner')
    .map((m) => m.user_id)
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))

  function toggle(userId: string) {
    setResults(null)
    setConfirmingRemove(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const nameFor = (userId: string) =>
    members.find((m) => m.user_id === userId)?.user.name ?? 'Unknown member'

  /**
   * Run one request per selected member against the EXISTING single-member
   * endpoints.
   *
   * Deliberately not a new bulk endpoint (CLAUDE.md §15): the single
   * endpoints already enforce owner protection and the
   * superadmin-must-have-joined rule, and reimplementing those server-side
   * is exactly the one-gate-checked-in-two-places drift that produced the
   * §13 `currentRole === "owner"` bug. This is an admin table, not a hot
   * path — correctness beats round-trip count.
   *
   * allSettled, not all: a partial failure must not discard the rows that
   * did succeed, and the caller needs to know WHICH failed and why.
   */
  async function runBulk(action: (userId: string) => Promise<unknown>) {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    setBulkBusy(true)
    setResults(null)
    try {
      const settled = await Promise.allSettled(ids.map((id) => action(id)))
      const collected: BulkResult[] = settled.map((r, i) => ({
        userId: ids[i],
        name: nameFor(ids[i]),
        ok: r.status === 'fulfilled',
        // The API's own message, not a generic one -- "can't remove the
        // project owner" is the useful part.
        error:
          r.status === 'rejected'
            ? (r.reason instanceof Error ? r.reason.message : String(r.reason))
            : undefined,
      }))
      setResults(collected)
      // Keep only what failed selected, so a retry doesn't re-run the
      // successes.
      setSelected(new Set(collected.filter((c) => !c.ok).map((c) => c.userId)))
      onMembersChanged()
    } finally {
      setBulkBusy(false)
      setConfirmingRemove(false)
    }
  }

  const bulkSetRole = (role: ProjectRole) =>
    runBulk((userId) => api.patch(`/projects/${projectId}/members/${userId}`, { role }))

  const bulkRemove = () =>
    runBulk((userId) => api.delete(`/projects/${projectId}/members/${userId}`))

  async function handleRoleChange(userId: string, newRole: ProjectRole) {
    try {
      await api.patch(`/projects/${projectId}/members/${userId}`, { role: newRole })
      onMembersChanged()
    } catch {
      // silently ignore
    }
  }

  async function handleRemove(userId: string) {
    setRemoving(userId)
    try {
      await api.delete(`/projects/${projectId}/members/${userId}`)
      onMembersChanged()
    } catch {
      // silently ignore
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="h-8 w-8 rounded-lg bg-bg-tertiary hover:bg-bg-hover flex items-center justify-center transition-colors"
          >
            <ArrowLeft className="h-4 w-4 text-text-secondary" />
          </button>
        )}
        <Dialog.Title className="flex-1 text-base font-semibold text-text-primary truncate">
          Members of {projectName}
        </Dialog.Title>
        {/* Gated on isProjectAdmin — the same rule that gates opening
            Settings anywhere else. A member who can view but not manage
            shouldn't be offered a button that leads to a 403. */}
        {canOpenSettings && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mr-6 flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        )}
      </div>

      {/* Selection toolbar — only once something is selected, so the
          common single-member case is unchanged. */}
      {canManageMembers && selected.size > 0 && (
        <div className="mx-6 mb-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-text-primary">
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => { setSelected(new Set()); setResults(null); setConfirmingRemove(false) }}
              className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              Clear
            </button>
            <div className="flex-1" />
            {confirmingRemove ? (
              <>
                <span className="text-xs text-status-error">
                  Remove {selected.size} member{selected.size !== 1 ? 's' : ''}?
                </span>
                <Button size="sm" variant="secondary" onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="destructive" loading={bulkBusy} onClick={bulkRemove}>
                  Remove
                </Button>
              </>
            ) : (
              <>
                <RoleDropdown
                  // No member is "the" current role for a mixed selection,
                  // so nothing is shown as selected.
                  value={'' as ProjectRole}
                  onChange={bulkSetRole}
                  compact
                  triggerLabel="Set role"
                />
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={bulkBusy}
                  onClick={() => setConfirmingRemove(true)}
                >
                  Remove selected
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Per-member outcome. An aggregate "3 of 4 succeeded" would leave
          the user guessing which one failed and why. */}
      {results && (
        <div className="mx-6 mb-3 rounded-lg border border-border bg-bg-tertiary px-3 py-2 space-y-1">
          <p className="text-xs font-medium text-text-primary">
            {results.filter((r) => r.ok).length} of {results.length} updated
          </p>
          {results.filter((r) => !r.ok).map((r) => (
            <p key={r.userId} className="text-xs text-status-error">
              {r.name}: {r.error}
            </p>
          ))}
        </div>
      )}

      {canManageMembers && selectableIds.length > 0 && (
        <div className="px-6 pb-2">
          <button
            type="button"
            onClick={() => {
              setResults(null)
              setConfirmingRemove(false)
              setSelected(allSelected ? new Set() : new Set(selectableIds))
            }}
            className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
          >
            {allSelected ? 'Deselect all' : `Select all (${selectableIds.length})`}
          </button>
        </div>
      )}

      {/* Members list */}
      <div className="px-6 pb-4 space-y-1 max-h-[400px] overflow-y-auto">
        {members.map((m) => {
          const isCurrentUser = m.user_id === currentUserId
          const isProjectOwner = m.role === 'owner'

          return (
            <div
              key={m.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover/50 transition-colors group"
            >
              {/* Omitted entirely rather than disabled, for exactly the
                  rows the single-member actions already refuse: yourself
                  and the owner. Reuses those same two booleans so the bulk
                  and single paths cannot drift apart. */}
              {canManageMembers && (
                isCurrentUser || isProjectOwner ? (
                  // A spacer, not a hidden or disabled checkbox: there is
                  // nothing to select here, and the width keeps the rows
                  // aligned with the ones that do have one.
                  <span className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <input
                    type="checkbox"
                    aria-label={`Select ${m.user.name}`}
                    checked={selected.has(m.user_id)}
                    onChange={() => toggle(m.user_id)}
                    className="h-4 w-4 shrink-0 rounded border-border accent-accent cursor-pointer"
                  />
                )
              )}
              <Avatar name={m.user.name} src={m.user.avatar_url} size="md" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-text-primary truncate">{m.user.name}</p>
                  {isCurrentUser && (
                    <span className="text-[10px] text-text-tertiary">(you)</span>
                  )}
                </div>
                <p className="text-xs text-text-tertiary truncate">{m.user.email}</p>
              </div>

              {/* Role control */}
              <div className="flex items-center gap-2">
                {canManageMembers && !isCurrentUser ? (
                  <RoleDropdown
                    value={m.role}
                    onChange={(r) => handleRoleChange(m.user_id, r)}
                    compact
                  />
                ) : (
                  <span className={cn(
                    'text-xs font-medium',
                    isProjectOwner ? 'text-accent' : 'text-text-tertiary',
                  )}>
                    {isProjectOwner && <Crown className="h-3 w-3 inline mr-1" />}
                    {roleLabelFor(m.role)}
                  </span>
                )}

                {canManageMembers && !isCurrentUser && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m.user_id)}
                    disabled={removing === m.user_id}
                    className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-status-error hover:bg-status-error/10 transition-all"
                  >
                    {removing === m.user_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {members.length === 0 && (
          <p className="text-sm text-text-tertiary text-center py-8">No members yet</p>
        )}
      </div>
    </div>
  )
}

// ─── Main Dialog ────────────────────────────────────────────────────────────

export function ProjectMembersDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onOpenSettings,
}: ProjectMembersDialogProps) {
  const [view, setView] = React.useState<'add' | 'manage'>('add')
  const [members, setMembers] = React.useState<MemberWithUser[]>([])
  const [loading, setLoading] = React.useState(false)
  // Distinguishes the first load from a post-action refresh. Without it
  // the whole dialog swaps to a spinner every time the list is refetched,
  // which UNMOUNTS ManageView -- discarding the per-member bulk results
  // the user is meant to read, and their selection with it. Caught by the
  // partial-failure test, which could not see its own error output.
  const [hasLoaded, setHasLoaded] = React.useState(false)
  const { user } = useAuthStore()

  const fetchMembers = React.useCallback(async () => {
    setLoading(true)
    try {
      const rawMembers = await api.get<{ id: string; user_id: string; role: ProjectRole }[]>(
        `/projects/${projectId}/members`,
      )
      if (rawMembers.length === 0) {
        setMembers([])
        setLoading(false)
        return
      }
      const userIds = rawMembers.map((m) => m.user_id)
      const users = await api.get<User[]>(`/users?ids=${userIds.join(',')}`)
      const userMap = new Map(users.map((u) => [u.id, u]))
      const hydrated: MemberWithUser[] = rawMembers
        .filter((m) => userMap.has(m.user_id))
        .map((m) => ({
          ...m,
          user: userMap.get(m.user_id)!,
        }))
      setMembers(hydrated)
    } catch {
      setMembers([])
    } finally {
      setLoading(false)
      setHasLoaded(true)
    }
  }, [projectId])

  React.useEffect(() => {
    if (open) {
      setView('add')
      setHasLoaded(false)
      fetchMembers()
    }
  }, [open, fetchMembers])

  const { isSuperAdmin } = useAuthStore()

  // The viewer's own membership row on this project, which is what every
  // gate below turns on. `_require_project_member_manager`
  // (routers/projects.py:42-58) requires a row to exist at all before it
  // considers anything else, so "not joined" is the first thing to know.
  const ownMembership = members.find((m) => m.user_id === user?.id)
  const isJoined = Boolean(ownMembership)
  const isProjectAdmin = ownMembership?.role === 'owner' || ownMembership?.role === 'admin'

  // Gates the role dropdown and the remove button, both of which go
  // through `_require_project_owner` server-side (routers/projects.py) —
  // and that admits owner AND admin. Named for what it actually controls:
  // as `isOwner` it read as a fact about the viewer, which is why the
  // admin case was missed.
  //
  // KNOWN DIVERGENCE, deliberate and pre-existing (CLAUDE.md §15): the
  // server also accepts a superadmin who has merely JOINED this project at
  // any role, so a superadmin sitting at viewer level is refused here but
  // would be accepted by the API. Left stricter on purpose rather than
  // quietly loosened — §15 records it as an open decision, and resolving
  // it is not this change's call to make.
  const canManageMembers = members.some(
    (m) => m.user_id === user?.id && (m.role === 'owner' || m.role === 'admin'),
  )

  // Adding a member, mirroring `_require_project_member_manager` exactly:
  // owner/admin membership, OR a superadmin who has joined at ANY role.
  //
  // AddView previously had no check at all. That was survivable only
  // because its single entry point (project-card.tsx's 3-dot menu) was
  // itself gated upstream; opening this dialog from the superadmin
  // projects table would have exposed a live search-and-add UI that
  // 403s on submit.
  const canAddMembers = isProjectAdmin || (isSuperAdmin && isJoined)

  // Hiding the Add tab means there has to be somewhere else to land.
  const effectiveView: 'add' | 'manage' = canAddMembers ? view : 'manage'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors z-10">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Description className="sr-only">
            Add or manage project members
          </Dialog.Description>

          {loading && !hasLoaded ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
            </div>
          ) : effectiveView === 'add' ? (
            <AddView
              projectId={projectId}
              projectName={projectName}
              members={members}
              onSwitchToManage={() => setView('manage')}
              onMemberAdded={fetchMembers}
              canOpenSettings={isProjectAdmin}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <ManageView
              projectId={projectId}
              projectName={projectName}
              members={members}
              canManageMembers={canManageMembers}
              currentUserId={user?.id ?? ''}
              // No way back to a tab that isn't there.
              onBack={canAddMembers ? () => setView('add') : undefined}
              onMembersChanged={fetchMembers}
              canOpenSettings={isProjectAdmin}
              onOpenSettings={onOpenSettings}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
