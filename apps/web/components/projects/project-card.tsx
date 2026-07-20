'use client'

import * as React from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreHorizontal, ImagePlus, Settings, Trash2, Globe, Lock, Users, ArrowRightLeft, Archive, ArchiveRestore, ChevronDown } from 'lucide-react'
import { cn, formatRelativeTime, formatBytes, resolveApiMediaUrl } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { Avatar } from '@/components/shared/avatar'
import { ProjectSettingsDialog } from './project-settings-dialog'
import { ProjectMembersDialog } from './project-members-dialog'
import { TransferOwnershipDialog } from './transfer-ownership-dialog'
import type { Project, ProjectRole, User } from '@/types'

interface MemberWithUser {
  id: string
  user_id: string
  role: ProjectRole
  user: User
}

interface ProjectCardProps {
  project: Project
  showRole?: boolean
  className?: string
  onMutate?: () => void
}

export function ProjectCard({
  project,
  showRole,
  className,
  onMutate,
}: ProjectCardProps) {
  const { isSuperAdmin } = useAuthStore()
  const gradient = getGradientForProject(project.id)
  const assetCount = project.asset_count ?? 0
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [membersOpen, setMembersOpen] = React.useState(false)
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [archiving, setArchiving] = React.useState(false)
  const [membersExpanded, setMembersExpanded] = React.useState(false)
  const [expandedMembers, setExpandedMembers] = React.useState<MemberWithUser[]>([])
  const [expandedMembersLoading, setExpandedMembersLoading] = React.useState(false)

  // "Project Admin" = anyone with role=owner or role=admin membership on
  // this project. "Owner" (singular, the crown) = role=owner specifically,
  // unique per project -- project.created_by is a frozen creation-time
  // snapshot now, not the current owner, so it can't be used here. Every
  // Project Admin can manage settings/members/archive; only the Owner (or
  // a superadmin) can delete outright or transfer the crown away.
  const isProjectAdmin = project.role === 'owner' || project.role === 'admin'
  const isTrueOwner = project.role === 'owner'
  const canDelete = isTrueOwner || isSuperAdmin
  const isArchived = !!project.archived_at
  // Same population as the "..." menu (isProjectAdmin), plus superadmins --
  // who can see this card without necessarily being a member of it (e.g. a
  // public project they haven't joined), so isProjectAdmin alone would miss
  // them.
  const canViewMembers = isSuperAdmin || isProjectAdmin

  const fetchExpandedMembers = React.useCallback(async () => {
    setExpandedMembersLoading(true)
    try {
      const rawMembers = await api.get<{ id: string; user_id: string; role: ProjectRole }[]>(
        `/projects/${project.id}/members`,
      )
      if (rawMembers.length === 0) {
        setExpandedMembers([])
        return
      }
      const userIds = rawMembers.map((m) => m.user_id)
      const users = await api.get<User[]>(`/users?ids=${userIds.join(',')}`)
      const userMap = new Map(users.map((u) => [u.id, u]))
      setExpandedMembers(
        rawMembers
          .filter((m) => userMap.has(m.user_id))
          .map((m) => ({ ...m, user: userMap.get(m.user_id)! })),
      )
    } catch {
      setExpandedMembers([])
    } finally {
      setExpandedMembersLoading(false)
    }
  }, [project.id])

  React.useEffect(() => {
    if (membersExpanded) fetchExpandedMembers()
  }, [membersExpanded, fetchExpandedMembers])

  const handleDelete = async () => {
    if (!confirm(`Delete "${project.name}"? This action cannot be undone.`)) return
    setDeleting(true)
    try {
      await api.delete(`/projects/${project.id}`)
      onMutate?.()
    } catch {
      // silently fail
    } finally {
      setDeleting(false)
    }
  }

  const handleArchiveToggle = async () => {
    setArchiving(true)
    try {
      await api.post(`/projects/${project.id}/${isArchived ? 'reactivate' : 'archive'}`)
      onMutate?.()
    } catch {
      // silently fail
    } finally {
      setArchiving(false)
    }
  }

  return (
    <>
      <div className={className}>
      <div className="group relative">
        <Link
          href={`/projects/${project.id}`}
          className={cn(
            'block overflow-hidden bg-bg-secondary border border-border hover:border-accent/40 transition-all duration-200 hover:shadow-lg hover:shadow-black/10',
            canViewMembers ? 'rounded-t-xl' : 'rounded-xl',
          )}
        >
          {/* Square poster area */}
          <div className="relative aspect-square w-full overflow-hidden">
            {project.poster_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolveApiMediaUrl(project.poster_url) ?? undefined}
                alt={project.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className={cn('h-full w-full bg-gradient-to-br', gradient)}>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.1),transparent_60%)]" />
              </div>
            )}

            {/* Bottom gradient overlay for text */}
            <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />

            {/* Project name overlay */}
            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="text-sm font-semibold text-white line-clamp-2 drop-shadow-sm">
                {project.name}
              </p>
              {project.description && (
                <p className="text-[11px] text-white/70 line-clamp-1 mt-0.5">
                  {project.description}
                </p>
              )}
            </div>

            {/* Public/role badges */}
            <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
              {project.is_public && (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/30 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/90">
                  <Globe className="h-2.5 w-2.5" />
                  Public
                </span>
              )}
              {isArchived && (
                <span className="inline-flex items-center gap-1 rounded-full bg-black/30 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/90">
                  <Archive className="h-2.5 w-2.5" />
                  Archived
                </span>
              )}
              {showRole && project.role && project.role !== 'owner' && (
                <span className="inline-flex items-center rounded-full bg-black/30 backdrop-blur-sm px-2 py-0.5 text-[10px] font-medium text-white/90 capitalize">
                  {project.role === 'admin' ? 'Manager' : project.role}
                </span>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-2xs text-text-tertiary">
              {assetCount > 0
                ? `${assetCount} item${assetCount !== 1 ? 's' : ''} · ${formatBytes(project.storage_bytes ?? 0)}`
                : `Updated ${formatRelativeTime(project.created_at)}`}
            </span>
          </div>
        </Link>

        {/* Context menu trigger */}
        {isProjectAdmin && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="absolute bottom-2 right-2.5 flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-all opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="z-50 min-w-[180px] rounded-xl border border-border bg-bg-secondary p-1 shadow-xl"
                sideOffset={4}
                align="end"
              >
                <DropdownMenu.Label className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">
                  Project
                </DropdownMenu.Label>

                <DropdownMenu.Item
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                  onSelect={() => setSettingsOpen(true)}
                >
                  <Settings className="h-4 w-4 text-text-tertiary" />
                  Project Settings
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                  onSelect={() => setMembersOpen(true)}
                >
                  <Users className="h-4 w-4 text-text-tertiary" />
                  Manage Members
                </DropdownMenu.Item>

                {isTrueOwner && (
                  <DropdownMenu.Item
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                    onSelect={() => setTransferOpen(true)}
                  >
                    <ArrowRightLeft className="h-4 w-4 text-text-tertiary" />
                    Transfer Ownership
                  </DropdownMenu.Item>
                )}

                {(!isArchived || isTrueOwner || isSuperAdmin) && (
                  <DropdownMenu.Item
                    className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                    onSelect={handleArchiveToggle}
                    disabled={archiving}
                  >
                    {isArchived ? (
                      <ArchiveRestore className="h-4 w-4 text-text-tertiary" />
                    ) : (
                      <Archive className="h-4 w-4 text-text-tertiary" />
                    )}
                    {isArchived ? 'Reactivate' : 'Archive'}
                  </DropdownMenu.Item>
                )}

                {canDelete && (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                      onSelect={handleDelete}
                      disabled={deleting}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>

      {canViewMembers && (
        <div className="rounded-b-xl border border-t-0 border-border bg-bg-secondary overflow-hidden">
          <button
            type="button"
            onClick={() => setMembersExpanded((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <Users className="h-3 w-3" />
              Members
              {typeof project.member_count === 'number' ? ` (${project.member_count})` : ''}
            </span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', membersExpanded && 'rotate-180')}
            />
          </button>

          {membersExpanded && (
            <div className="border-t border-border px-3 pb-2.5 pt-2 space-y-1.5 max-h-40 overflow-y-auto">
              {expandedMembersLoading ? (
                <p className="py-1 text-xs text-text-tertiary">Loading…</p>
              ) : expandedMembers.length === 0 ? (
                <p className="py-1 text-xs text-text-tertiary">No members</p>
              ) : (
                expandedMembers.map((m) => (
                  <div key={m.id} className="flex items-center gap-2">
                    <Avatar src={m.user.avatar_url} name={m.user.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                      {m.user.name}
                    </span>
                    <span className="shrink-0 text-[10px] capitalize text-text-tertiary">
                      {m.role === 'admin' ? 'Manager' : m.role}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
      </div>

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        project={project}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdated={() => onMutate?.()}
      />

      <ProjectMembersDialog
        open={membersOpen}
        onOpenChange={setMembersOpen}
        projectId={project.id}
        projectName={project.name}
      />

      {isTrueOwner && (
        <TransferOwnershipDialog
          projectId={project.id}
          projectName={project.name}
          open={transferOpen}
          onOpenChange={setTransferOpen}
          onTransferred={() => onMutate?.()}
        />
      )}
    </>
  )
}
