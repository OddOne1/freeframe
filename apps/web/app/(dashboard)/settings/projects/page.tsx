"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  X,
  FolderKanban,
  Pencil,
  Trash2,
  ArrowRightLeft,
  Search,
  Archive,
  ArchiveRestore,
  LogIn,
  LogOut,
  Users,
  MoreHorizontal,
  Settings,
  Crown,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { useAuthStore } from "@/stores/auth-store";
import { useHasProjectPrivilege } from "@/hooks/use-project-privilege";
import { ProjectSettingsDialog } from "@/components/projects/project-settings-dialog";
import { ProjectMembersDialog } from "@/components/projects/project-members-dialog";
import { TransferOwnershipDialog } from "@/components/projects/transfer-ownership-dialog";
import type { AdminProject, Project, ProjectRole, User } from "@/types";

/**
 * Who actually owns each of these projects.
 *
 * The table previously showed only the *viewer's own* role, so a Manager
 * looking at a project they don't own had no way to see whose it was
 * without opening an unlabelled member-count badge — and nothing on the
 * page said that badge contained the answer.
 *
 * Two-step fetch — `/projects/{id}/members`, then `/users?ids=` to
 * hydrate names — rather than a new endpoint. Members have to be fetched per project — there is no bulk
 * members route — but the user lookup is batched into a single request
 * for every owner at once, so this costs N+1 rather than 2N.
 *
 * Failure is silent by design: not knowing the owner should leave a dash
 * in one column, not break the projects table.
 */
function useProjectOwners(projectIds: string[]) {
  const key = projectIds.length ? `owners:${[...projectIds].sort().join(",")}` : null;

  const { data } = useSWR(key, async () => {
    const perProject = await Promise.all(
      projectIds.map(async (id) => {
        try {
          const members = await api.get<{ user_id: string; role: ProjectRole }[]>(
            `/projects/${id}/members`,
          );
          return [id, members.find((m) => m.role === "owner")?.user_id ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    const ownerIds = Array.from(
      new Set(perProject.map(([, uid]) => uid).filter((uid): uid is string => Boolean(uid))),
    );
    if (ownerIds.length === 0) return {} as Record<string, User>;

    let users: User[] = [];
    try {
      users = await api.get<User[]>(`/users?ids=${ownerIds.join(",")}`);
    } catch {
      return {} as Record<string, User>;
    }
    const byId = new Map(users.map((u) => [u.id, u]));

    const out: Record<string, User> = {};
    for (const [projectId, ownerId] of perProject) {
      const u = ownerId ? byId.get(ownerId) : undefined;
      if (u) out[projectId] = u;
    }
    return out;
  });

  return data ?? {};
}

/** Owner cell — crown + name, matching `OWNER_LABEL`'s visual language in
 *  project-members-dialog.tsx rather than inventing a second one. */
function OwnerCell({ owner, isSelf }: { owner?: User; isSelf: boolean }) {
  if (!owner) return <span className="text-xs text-text-tertiary">—</span>;
  return (
    <div className="flex items-center gap-1.5 min-w-0" title={owner.email}>
      <Crown className="h-3 w-3 shrink-0 text-accent" />
      <span className="truncate text-xs text-text-secondary">
        {owner.name}
        {isSelf && <span className="text-text-tertiary"> (you)</span>}
      </span>
    </div>
  );
}

// Superadmins see every project ever created, including ones they don't
// belong to, with owner identity and stats. They can rename/archive/
// delete/transfer any project from here without joining it — but to
// actually browse a project's assets they still have to join it first
// (Join & View), same membership check as everyone else. That's the
// deliberate privacy boundary: admin powers over a project's management
// don't imply access to its contents.
//
// Once a superadmin HAS joined (current_user_role is set), the project
// name/icon becomes a direct link and the action toggles to "Leave".
// "Leave" only applies to the viewer-role peek created by Join & View —
// if the superadmin happens to be a real owner/editor/reviewer on a
// project (legitimate collaboration, not a peek), that's shown as
// "Member" instead and isn't one-click removable from this table.

function RenameProjectDialog({
  project,
  open,
  onOpenChange,
  onRenamed,
}: {
  project: AdminProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => void;
}) {
  const [name, setName] = React.useState(project.name);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setName(project.name);
      setError("");
    }
  }, [open, project.name]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError("");
    try {
      await api.patch(`/admin/projects/${project.id}`, { name: name.trim() });
      onRenamed();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rename project");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">
            Rename Project
          </Dialog.Title>
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <Input
              label="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            {error && <p className="text-xs text-status-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={loading}>
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AdminTransferOwnershipDialog({
  project,
  open,
  onOpenChange,
  onTransferred,
}: {
  project: AdminProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<User[]>([]);
  const [selected, setSelected] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSelected(null);
      setError("");
    }
  }, [open]);

  React.useEffect(() => {
    if (selected || !query.trim()) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      api
        .get<User[]>(`/users/search?q=${encodeURIComponent(query.trim())}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, selected]);

  const handleSubmit = async () => {
    if (!selected) return;
    setLoading(true);
    setError("");
    try {
      await api.post(`/admin/projects/${project.id}/transfer-ownership`, {
        new_owner_id: selected.id,
      });
      onTransferred();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to transfer ownership",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">
            Transfer Ownership
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Move &quot;{project.name}&quot; to a different owner. Unlike the
            self-service version, admins can hand it to anyone, not just
            existing Project Admins.
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <Input
              label="Search users"
              placeholder="Name or email"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(null);
              }}
              icon={<Search className="h-4 w-4" />}
            />
            {results.length > 0 && !selected && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {results.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setSelected(u);
                      setQuery(u.name);
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-tertiary transition-colors"
                  >
                    <Avatar src={u.avatar_url} name={u.name} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-text-primary">{u.name}</p>
                      <p className="truncate text-xs text-text-tertiary">
                        {u.email}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {selected && (
              <p className="text-xs text-status-success">
                Selected: {selected.name} ({selected.email})
              </p>
            )}
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              loading={loading}
              disabled={!selected}
              onClick={handleSubmit}
            >
              Transfer
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Non-superadmin view: "your" projects only ─────────────────────────────
// Superuser/admin/owner-tier viewers get a scoped-down version of this tab --
// only projects they own or manage, plus their personal storage allocation.
// No org-wide table, no rename/delete/transfer-to-anyone -- those stay
// exclusive to the superadmin branch above.

const GB = 1024 ** 3;

function StorageUsageCircle({ percent }: { percent: number | null }) {
  const size = 72;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  // Status color only, reserved for this exact meaning -- never reused as a
  // generic accent. Paired with the numeric label below, not color alone.
  const colorClass =
    percent === null
      ? "text-text-tertiary"
      : percent >= 90
        ? "text-status-error"
        : percent >= 70
          ? "text-status-warning"
          : "text-status-success";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-border"
        />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={cn("transition-all duration-300", colorClass)}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-semibold text-text-primary">
          {percent === null ? "∞" : `${Math.round(percent)}%`}
        </span>
      </div>
    </div>
  );
}

function EditableStorageLimit({
  project,
  otherAllocatedBytes,
  personalTotalBytes,
  onSaved,
}: {
  project: Project;
  otherAllocatedBytes: number;
  personalTotalBytes: number | null;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState(
    project.storage_limit_bytes ? String(Math.round(project.storage_limit_bytes / GB)) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const handleSave = async () => {
    setError("");
    const trimmed = value.trim();
    if (trimmed && (Number.isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0)) {
      setError("Enter a positive number, or leave empty for unlimited.");
      return;
    }
    const bytes = trimmed ? Math.round(parseFloat(trimmed) * GB) : null;
    // Mirrors _check_owner_storage_allocation server-side (routers/projects.py)
    // so the UI can reject before the round-trip -- the server still
    // re-validates, this is purely a faster/clearer error for the common case.
    if (bytes !== null && personalTotalBytes !== null) {
      const projected = otherAllocatedBytes + bytes;
      if (projected > personalTotalBytes) {
        setError(
          `Exceeds your ${formatBytes(personalTotalBytes)} total by ${formatBytes(projected - personalTotalBytes)}.`,
        );
        return;
      }
    }
    setSaving(true);
    try {
      await api.patch(`/projects/${project.id}`, { storage_limit_bytes: bytes });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update storage limit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Unlimited"
          className="w-20 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
        />
        <span className="text-[10px] text-text-tertiary">GB</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSave}
          loading={saving}
          className="h-6 px-2 text-xs"
        >
          Save
        </Button>
      </div>
      {error && <p className="max-w-[220px] text-[10px] text-status-error">{error}</p>}
    </div>
  );
}

function OwnedProjectsView() {
  const { user } = useAuthStore();
  const { data: projects, isLoading } = useSWR<Project[]>("/projects", () =>
    api.get<Project[]>("/projects"),
  );

  const managedProjects = React.useMemo(
    () => (projects ?? []).filter((p) => p.role === "owner" || p.role === "admin"),
    [projects],
  );
  const ownedProjects = React.useMemo(
    () => managedProjects.filter((p) => p.role === "owner"),
    [managedProjects],
  );

  const owners = useProjectOwners(React.useMemo(
    () => managedProjects.map((p) => p.id),
    [managedProjects],
  ));

  // NULL (unlimited) sibling projects contribute 0 to this sum rather than
  // being unbounded -- same simplification as the backend's SQL SUM, kept
  // consistent on purpose so the client-side check below never disagrees
  // with the server.
  const allocatedBytes = React.useMemo(
    () => ownedProjects.reduce((sum, p) => sum + (p.storage_limit_bytes ?? 0), 0),
    [ownedProjects],
  );
  const usedBytes = React.useMemo(
    () => ownedProjects.reduce((sum, p) => sum + (p.storage_bytes ?? 0), 0),
    [ownedProjects],
  );
  const personalTotalBytes = user?.storage_limit_bytes ?? null;
  const percentUsed =
    personalTotalBytes === null ? null : personalTotalBytes > 0 ? (usedBytes / personalTotalBytes) * 100 : 100;

  const refresh = () => mutate("/projects");

  const [settingsTarget, setSettingsTarget] = React.useState<Project | null>(null);
  // Same real dialog the superadmin table opens (commit 1d676bb). An owner
  // or manager looking at their OWN project had a read-only popover while a
  // superadmin got full management on the table below — one control, two
  // behaviours, decided by who was looking.
  const [membersTarget, setMembersTarget] = React.useState<Project | null>(null);
  const [transferTarget, setTransferTarget] = React.useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Project | null>(null);
  const [archiving, setArchiving] = React.useState<string | null>(null);

  // Same template as handleArchiveToggle in the superadmin branch below,
  // scoped to this view's own "/projects" SWR key instead of "/admin/projects".
  const handleArchiveToggle = async (p: Project) => {
    setArchiving(p.id);
    try {
      await api.post(`/projects/${p.id}/${p.archived_at ? "reactivate" : "archive"}`);
      refresh();
    } catch {
      // silently fail
    } finally {
      setArchiving(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await api.delete(`/projects/${deleteTarget.id}`);
    refresh();
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Your Projects</h1>
        <p className="mt-0.5 text-sm text-text-tertiary">
          Projects you own or manage. Storage limits only apply to projects
          you own -- contact a superadmin to raise your total.
        </p>
      </div>

      <div className="flex items-center gap-5 rounded-lg border border-border bg-bg-secondary p-4">
        <StorageUsageCircle percent={percentUsed} />
        <div className="space-y-1 text-sm">
          <p className="text-text-primary">
            <span className="font-semibold">{formatBytes(usedBytes)}</span> used of{" "}
            {personalTotalBytes !== null ? formatBytes(personalTotalBytes) : "an unlimited"} total
          </p>
          <p className="text-text-tertiary">
            {formatBytes(allocatedBytes)} allocated across {ownedProjects.length} owned project
            {ownedProjects.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      ) : managedProjects.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={FolderKanban}
            title="No projects"
            description="Projects you own or manage will appear here."
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Project</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Owner</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Your Role</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Members</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Used</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Storage Limit</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary">Actions</th>
              </tr>
            </thead>
            <tbody>
              {managedProjects.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${p.id}`}
                      className="block max-w-[220px] truncate text-sm font-medium text-text-primary hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-[180px]">
                    <OwnerCell owner={owners[p.id]} isSelf={owners[p.id]?.id === user?.id} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-text-secondary">
                      {p.role === "admin" ? "Manager" : "Owner"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setMembersTarget(p)}
                      className="flex items-center gap-1.5 rounded-md border border-border h-7 px-2 text-2xs text-text-primary hover:bg-bg-hover transition-colors"
                    >
                      <Users className="h-3 w-3 text-text-tertiary" />
                      {typeof p.member_count === "number" ? p.member_count : "—"}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{formatBytes(p.storage_bytes ?? 0)}</td>
                  <td className="px-4 py-3">
                    {p.role === "owner" ? (
                      <EditableStorageLimit
                        project={p}
                        otherAllocatedBytes={allocatedBytes - (p.storage_limit_bytes ?? 0)}
                        personalTotalBytes={personalTotalBytes}
                        onSaved={refresh}
                      />
                    ) : (
                      <span className="text-xs italic text-text-tertiary">
                        {p.storage_limit_bytes ? formatBytes(p.storage_limit_bytes) : "Unlimited"} (owner-managed)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
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
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                            onSelect={() => setSettingsTarget(p)}
                          >
                            <Settings className="h-4 w-4 text-text-tertiary" />
                            Project Settings
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                            onSelect={() => handleArchiveToggle(p)}
                            disabled={archiving === p.id}
                          >
                            {p.archived_at ? (
                              <ArchiveRestore className="h-4 w-4 text-text-tertiary" />
                            ) : (
                              <Archive className="h-4 w-4 text-text-tertiary" />
                            )}
                            {p.archived_at ? "Reactivate" : "Archive"}
                          </DropdownMenu.Item>
                          {p.role === "owner" && (
                            <>
                              <DropdownMenu.Item
                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                                onSelect={() => setTransferTarget(p)}
                              >
                                <ArrowRightLeft className="h-4 w-4 text-text-tertiary" />
                                Transfer Ownership
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator className="my-1 h-px bg-border" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                                onSelect={() => setDeleteTarget(p)}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </DropdownMenu.Item>
                            </>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {membersTarget && (
        <ProjectMembersDialog
          open={!!membersTarget}
          onOpenChange={(o) => !o && setMembersTarget(null)}
          projectId={membersTarget.id}
          projectName={membersTarget.name}
          // Both open-states live here, so cross-navigation is a state
          // swap rather than one dialog rendering the other (§16).
          onOpenSettings={() => {
            const target = membersTarget;
            setMembersTarget(null);
            setSettingsTarget(target);
          }}
        />
      )}

      {settingsTarget && (
        <ProjectSettingsDialog
          project={settingsTarget}
          open={!!settingsTarget}
          onOpenChange={(o) => !o && setSettingsTarget(null)}
          onUpdated={refresh}
          onOpenMembers={() => {
            const target = settingsTarget;
            setSettingsTarget(null);
            setMembersTarget(target);
          }}
        />
      )}
      {transferTarget && (
        <TransferOwnershipDialog
          projectId={transferTarget.id}
          projectName={transferTarget.name}
          open={!!transferTarget}
          onOpenChange={(o) => !o && setTransferTarget(null)}
          onTransferred={refresh}
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description="This soft-deletes the project and all its assets. Only a database restore can undo it. Consider Archive instead if you just want to disable it."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </div>
  );
}

export default function SettingsProjectsPage() {
  const router = useRouter();
  const { user, isSuperAdmin } = useAuthStore();
  const hasProjectPrivilege = useHasProjectPrivilege();
  const { data: projectsResp, isLoading } = useSWR<AdminProject[]>(
    isSuperAdmin ? "/admin/projects" : null,
    () => api.get<AdminProject[]>("/admin/projects"),
  );
  // Same "/projects" key useHasProjectPrivilege fetches internally and
  // OwnedProjectsView fetches for its table -- SWR dedupes all three into
  // one request. This is here only so this component can see isLoading:
  // useHasProjectPrivilege briefly returns false for a genuinely privileged
  // non-superadmin while that fetch is still in flight, and gating the
  // redirect below on that raw boolean would bounce them to "/" before it
  // resolves.
  const { isLoading: privilegeCheckLoading } = useSWR<Project[]>(
    user && !isSuperAdmin ? "/projects" : null,
    () => api.get<Project[]>("/projects"),
  );

  React.useEffect(() => {
    if (!user) return;
    if (isSuperAdmin || hasProjectPrivilege || privilegeCheckLoading) return;
    router.replace("/");
  }, [user, isSuperAdmin, hasProjectPrivilege, privilegeCheckLoading, router]);

  const [renameTarget, setRenameTarget] = React.useState<AdminProject | null>(null);
  const [transferTarget, setTransferTarget] = React.useState<AdminProject | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminProject | null>(null);
  // §15 -- the Members control now opens the same full dialog used
  // everywhere else, rather than a separate read-only popover. Safe to do
  // now that AddView has its own permission check (§16); before that, an
  // unjoined superadmin would have been shown a live add UI that 403s.
  const [membersTarget, setMembersTarget] = React.useState<AdminProject | null>(null);
  const [joining, setJoining] = React.useState<string | null>(null);
  const [leaving, setLeaving] = React.useState<string | null>(null);
  const [archiving, setArchiving] = React.useState<string | null>(null);

  const refresh = () => mutate("/admin/projects");

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await api.delete(`/admin/projects/${deleteTarget.id}`);
    refresh();
  };

  const handleJoinAndView = async (p: AdminProject) => {
    setJoining(p.id);
    try {
      await api.post(`/admin/projects/${p.id}/join`);
      router.push(`/projects/${p.id}`);
    } catch {
      // silently fail
    } finally {
      setJoining(null);
    }
  };

  const handleLeave = async (p: AdminProject) => {
    setLeaving(p.id);
    try {
      await api.post(`/admin/projects/${p.id}/leave`);
      refresh();
    } catch {
      // silently fail
    } finally {
      setLeaving(null);
    }
  };

  const handleArchiveToggle = async (p: AdminProject) => {
    setArchiving(p.id);
    try {
      await api.post(`/projects/${p.id}/${p.archived_at ? "reactivate" : "archive"}`);
      refresh();
    } catch {
      // silently fail
    } finally {
      setArchiving(null);
    }
  };

  if (!isSuperAdmin && hasProjectPrivilege) {
    return <OwnedProjectsView />;
  }

  if (!isSuperAdmin) {
    // Either confirmed no access (redirect effect above is on its way) or
    // the privilege check is still in flight -- either way there's nothing
    // useful to render yet.
    return null;
  }

  // §17b. Same distinction `hasAccess` already made per-row, surfaced as
  // structure instead of being buried in which menu items appear.
  const joinedProjects = (projectsResp ?? []).filter((p) => !!p.current_user_role);
  const generalProjects = (projectsResp ?? []).filter((p) => !p.current_user_role);

  /** One row, hoisted out of the map so both tables render from a single
   *  definition — splitting the table must not fork the row logic. */
  const renderRow = (p: AdminProject) => {
                const hasAccess = !!p.current_user_role;
                const isPeekOnly = p.current_user_role === "viewer";
                const projectIcon = p.poster_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.poster_url}
                    alt=""
                    className="h-8 w-8 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-tertiary">
                    <FolderKanban className="h-4 w-4 text-text-tertiary" />
                  </div>
                );

                return (
                  <tr
                    key={p.id}
                    className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors"
                  >
                    <td className="px-4 py-3">
                      {hasAccess ? (
                        <Link
                          href={`/projects/${p.id}`}
                          className="group flex items-center gap-2.5"
                        >
                          {projectIcon}
                          <p className="text-sm font-medium text-text-primary truncate max-w-[200px] group-hover:underline">
                            {p.name}
                          </p>
                        </Link>
                      ) : (
                        <div className="flex items-center gap-2.5">
                          {projectIcon}
                          <p className="text-sm font-medium text-text-primary truncate max-w-[200px]">
                            {p.name}
                          </p>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm text-text-primary truncate max-w-[160px]">
                        {p.owner_name ?? "—"}
                      </p>
                      <p className="text-xs text-text-tertiary truncate max-w-[160px]">
                        {p.owner_email ?? ""}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setMembersTarget(p)}
                        className="flex items-center gap-1.5 rounded-md border border-border h-7 px-2 text-2xs text-text-primary hover:bg-bg-hover transition-colors"
                      >
                        {/* No chevron: this opens a dialog, not a
                            dropdown, and the caret promised a menu that
                            never existed. */}
                        <Users className="h-3 w-3 text-text-tertiary" />
                        {typeof p.member_count === "number" ? p.member_count : "—"}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{p.asset_count}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {formatBytes(p.storage_bytes ?? 0)}
                    </td>
                    <td className="px-4 py-3">
                      {p.archived_at ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-status-warning/10 px-2 py-0.5 text-xs font-medium text-status-warning">
                          <Archive className="h-3 w-3" />
                          Archived
                        </span>
                      ) : (
                        <span className="text-xs text-text-tertiary">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-tertiary">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
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
                            {!hasAccess ? (
                              <DropdownMenu.Item
                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                                onSelect={() => handleJoinAndView(p)}
                                disabled={joining === p.id}
                              >
                                <LogIn className="h-4 w-4 text-text-tertiary" />
                                Join &amp; View
                              </DropdownMenu.Item>
                            ) : isPeekOnly ? (
                              <DropdownMenu.Item
                                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                                onSelect={() => handleLeave(p)}
                                disabled={leaving === p.id}
                              >
                                <LogOut className="h-4 w-4 text-text-tertiary" />
                                Leave
                              </DropdownMenu.Item>
                            ) : null}
                            <DropdownMenu.Item
                              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                              onSelect={() => setRenameTarget(p)}
                            >
                              <Pencil className="h-4 w-4 text-text-tertiary" />
                              Rename
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                              onSelect={() => handleArchiveToggle(p)}
                              disabled={archiving === p.id}
                            >
                              {p.archived_at ? (
                                <ArchiveRestore className="h-4 w-4 text-text-tertiary" />
                              ) : (
                                <Archive className="h-4 w-4 text-text-tertiary" />
                              )}
                              {p.archived_at ? "Reactivate" : "Archive"}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                              onSelect={() => setTransferTarget(p)}
                            >
                              <ArrowRightLeft className="h-4 w-4 text-text-tertiary" />
                              Transfer
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="my-1 h-px bg-border" />
                            <DropdownMenu.Item
                              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                              onSelect={() => setDeleteTarget(p)}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </td>
                  </tr>
    );
  };

  const ProjectsTable = ({ rows }: { rows: AdminProject[] }) => (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-x-auto">
      <table className="w-full text-sm min-w-[760px]">
        <thead>
          <tr className="border-b border-border bg-bg-tertiary">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Project</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Owner</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Members</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Assets</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Storage</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Status</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Created</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary">Actions</th>
          </tr>
        </thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">All Projects</h1>
        <p className="mt-0.5 text-sm text-text-tertiary">
          Every project on the platform, including ones you&apos;re not a
          member of. You can manage any of them from here, but you&apos;ll
          need to join a project to see its actual contents.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      ) : !projectsResp || projectsResp.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={FolderKanban}
            title="No projects"
            description="Projects will appear here once created."
          />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Joined first — these are the ones this superadmin can actually
              open and work in. Pure client-side grouping of data already
              fetched: `current_user_role` was on every row already, and
              `hasAccess` already split them per-row. No new API call, no
              change to AdminProject. */}
          <div>
            <h2 className="mb-2 text-sm font-medium text-text-primary">
              Joined Projects
              <span className="ml-2 text-xs font-normal text-text-tertiary">
                {joinedProjects.length}
              </span>
            </h2>
            {joinedProjects.length === 0 ? (
              // Shown, not hidden: an empty section states "you've joined
              // nothing", which an absent section cannot.
              <div className="rounded-lg border border-border bg-bg-secondary px-4 py-6 text-center text-sm text-text-tertiary">
                You haven&apos;t joined any projects yet. Use Join &amp; View
                on one below to see its contents.
              </div>
            ) : (
              <ProjectsTable rows={joinedProjects} />
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium text-text-primary">
              General Projects
              <span className="ml-2 text-xs font-normal text-text-tertiary">
                {generalProjects.length}
              </span>
            </h2>
            {generalProjects.length === 0 ? (
              <div className="rounded-lg border border-border bg-bg-secondary px-4 py-6 text-center text-sm text-text-tertiary">
                You&apos;ve joined every project on the platform.
              </div>
            ) : (
              <ProjectsTable rows={generalProjects} />
            )}
          </div>
        </div>
      )}

      {membersTarget && (
        <ProjectMembersDialog
          open={!!membersTarget}
          onOpenChange={(o) => !o && setMembersTarget(null)}
          projectId={membersTarget.id}
          projectName={membersTarget.name}
          // No Settings cross-nav from here: this table's own row menu
          // already has a Project Settings item, and the dialog's gate is
          // isProjectAdmin (a membership role), which a superadmin
          // browsing a project they haven't joined does not have.
        />
      )}

      {renameTarget && (
        <RenameProjectDialog
          project={renameTarget}
          open={!!renameTarget}
          onOpenChange={(o) => !o && setRenameTarget(null)}
          onRenamed={refresh}
        />
      )}
      {transferTarget && (
        <AdminTransferOwnershipDialog
          project={transferTarget}
          open={!!transferTarget}
          onOpenChange={(o) => !o && setTransferTarget(null)}
          onTransferred={refresh}
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name ?? ""}"?`}
        description="This soft-deletes the project and all its assets. Only a database restore can undo it. Consider Archive instead if you just want to disable it."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </div>
  );
}
