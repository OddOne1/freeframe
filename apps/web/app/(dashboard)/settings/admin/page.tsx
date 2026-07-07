"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Users,
  X,
  Shield,
  Link2,
  Check,
  FolderKanban,
  Pencil,
  Trash2,
  ArrowRightLeft,
  Search,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { useRouter } from "next/navigation";
import type {
  User,
  UserStatus,
  AdminUser,
  AdminUserProjectSummary,
  AdminProject,
  ProjectRole,
} from "@/types";

// Above this many projects, a user's project list collapses into a hover
// popover instead of inline chips, so the table stays readable.
const PROJECT_HOVER_THRESHOLD = 3;

function BulkInviteDialog() {
  const [open, setOpen] = React.useState(false);
  const [emails, setEmails] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const emailList = emails
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (emailList.length === 0) return;
    setLoading(true);
    setError("");
    setSuccess("");
    let sent = 0;
    const skipped: string[] = [];
    const failed: string[] = [];
    try {
      for (const email of emailList) {
        try {
          const name = email.split("@")[0];
          await api.post("/users/invite", { email, name });
          sent++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.toLowerCase().includes("already registered")) {
            skipped.push(email);
          } else {
            failed.push(email);
          }
        }
      }
      const parts: string[] = [];
      if (sent > 0) parts.push(`${sent} invite(s) sent`);
      if (skipped.length > 0)
        parts.push(`${skipped.length} already registered`);
      if (failed.length > 0) parts.push(`${failed.length} failed`);
      if (sent > 0 || skipped.length > 0) {
        setSuccess(parts.join(", "));
        if (failed.length === 0) {
          setEmails("");
          setTimeout(() => setOpen(false), 1500);
        }
      }
      if (failed.length > 0) {
        setError(`Failed to invite: ${failed.join(", ")}`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send invites");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="secondary" size="sm">
          <Users className="h-4 w-4" />
          Bulk Invite
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="text-base font-semibold text-text-primary">
            Bulk Invite Users
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Enter email addresses separated by commas or newlines.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">
                Email addresses
              </label>
              <textarea
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="user1@example.com&#10;user2@example.com"
                rows={5}
                className="flex w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary transition-colors focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-none"
              />
            </div>
            {error && <p className="text-xs text-status-error">{error}</p>}
            {success && (
              <p className="text-xs text-status-success">{success}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
              <Button type="submit" size="sm" loading={loading}>
                Send Invites
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function userStatusBadge(status: UserStatus) {
  const map: Record<UserStatus, { label: string; className: string }> = {
    active: {
      label: "Active",
      className: "bg-status-success/15 text-status-success",
    },
    deactivated: {
      label: "Deactivated",
      className: "bg-status-error/15 text-status-error",
    },
    pending_invite: {
      label: "Pending",
      className: "bg-status-warning/15 text-status-warning",
    },
    pending_verification: {
      label: "Unverified",
      className: "bg-bg-tertiary text-text-secondary",
    },
  };
  const cfg = map[status] ?? map.active;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

function roleBadgeClass(role: ProjectRole): string {
  switch (role) {
    case "owner":
      return "bg-accent/10 text-accent";
    case "editor":
      return "bg-status-success/10 text-status-success";
    case "reviewer":
      return "bg-status-warning/10 text-status-warning";
    default:
      return "bg-bg-tertiary text-text-tertiary";
  }
}

// ─── Per-user project list: inline chips, or a hover popover once there ─────
// are more than PROJECT_HOVER_THRESHOLD projects to keep rows readable. ─────

function UserProjects({ projects }: { projects: AdminUserProjectSummary[] }) {
  const [open, setOpen] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  if (projects.length === 0) {
    return <span className="text-xs text-text-tertiary">No projects</span>;
  }

  if (projects.length <= PROJECT_HOVER_THRESHOLD) {
    return (
      <div className="flex flex-wrap gap-1 max-w-[260px]">
        {projects.map((p) => (
          <span
            key={p.project_id}
            className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary"
          >
            <span className="truncate max-w-[120px]">{p.project_name}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0 text-[10px] font-medium capitalize",
                roleBadgeClass(p.role),
              )}
            >
              {p.role}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
        >
          <FolderKanban className="h-3 w-3" />
          {projects.length} projects
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          className="z-50 w-64 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-[#1a1a1f] shadow-2xl p-2 space-y-1
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {projects.map((p) => (
            <div
              key={p.project_id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-white/5"
            >
              <span className="truncate text-text-primary">
                {p.project_name}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0 text-[10px] font-medium capitalize",
                  roleBadgeClass(p.role),
                )}
              >
                {p.role}
              </span>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ─── Users tab ────────────────────────────────────────────────────────────

function UsersTab() {
  const { user } = useAuthStore();

  const { data: usersResp, isLoading: loadingUsers } = useSWR<AdminUser[]>(
    "/admin/users",
    () => api.get<AdminUser[]>("/admin/users"),
  );

  const handleDeactivate = async (userId: string) => {
    try {
      await api.patch(`/admin/users/${userId}/deactivate`);
      mutate("/admin/users");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to deactivate user";
      alert(message);
    }
  };

  const handleReactivate = async (userId: string) => {
    try {
      await api.patch(`/admin/users/${userId}/reactivate`);
      mutate("/admin/users");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to reactivate user";
      alert(message);
    }
  };

  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  const handleCopyInviteLink = (u: AdminUser) => {
    if (!u.invite_token) return;
    const link = `${window.location.origin}/invite/${u.invite_token}`;
    navigator.clipboard.writeText(link);
    setCopiedId(u.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleToggleAdmin = async (
    userId: string,
    isCurrentlyAdmin: boolean,
  ) => {
    try {
      await api.patch(`/admin/users/${userId}/role`, {
        is_admin: !isCurrentlyAdmin,
      });
      mutate("/admin/users");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to update user role";
      alert(message);
    }
  };

  const admins = React.useMemo(
    () =>
      (usersResp ?? [])
        .filter((u) => u.is_superadmin)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [usersResp],
  );
  const members = React.useMemo(
    () =>
      (usersResp ?? [])
        .filter((u) => !u.is_superadmin)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [usersResp],
  );

  const renderRow = (u: AdminUser) => (
    <tr
      key={u.id}
      className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors"
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar src={u.avatar_url} name={u.name} size="sm" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {u.name}
            </p>
            <p className="text-xs text-text-tertiary truncate">{u.email}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <UserProjects projects={u.projects} />
      </td>
      <td className="px-4 py-3">
        {u.is_superadmin ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
            <Shield className="h-3 w-3" />
            Admin
          </span>
        ) : (
          <span className="text-xs text-text-tertiary">User</span>
        )}
      </td>
      <td className="px-4 py-3">{userStatusBadge(u.status)}</td>
      <td className="px-4 py-3 text-xs text-text-tertiary">
        {u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          {u.status === "pending_invite" && u.invite_token && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCopyInviteLink(u)}
              className="gap-1"
            >
              {copiedId === u.id ? (
                <>
                  <Check className="h-3.5 w-3.5 text-status-success" />{" "}
                  Copied
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5" /> Copy Invite Link
                </>
              )}
            </Button>
          )}
          {u.id !== user?.id && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleToggleAdmin(u.id, u.is_superadmin)}
            >
              {u.is_superadmin ? "Remove Admin" : "Make Admin"}
            </Button>
          )}
          {u.id !== user?.id && u.status === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDeactivate(u.id)}
              className="text-status-error hover:text-status-error"
            >
              Deactivate
            </Button>
          ) : u.id !== user?.id && u.status === "deactivated" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleReactivate(u.id)}
            >
              Reactivate
            </Button>
          ) : u.id === user?.id ? (
            <span className="text-xs text-text-tertiary italic">You</span>
          ) : null}
        </div>
      </td>
    </tr>
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">
          Platform Users
        </h2>
        <BulkInviteDialog />
      </div>

      {loadingUsers ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg bg-bg-tertiary"
            />
          ))}
        </div>
      ) : !usersResp || usersResp.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Users}
            title="No users"
            description="Users will appear here once they register or are invited."
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  User
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Projects
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Role
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Status
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Joined
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {admins.length > 0 && (
                <tr className="bg-bg-tertiary/60">
                  <td
                    colSpan={6}
                    className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary"
                  >
                    Admins ({admins.length})
                  </td>
                </tr>
              )}
              {admins.map(renderRow)}
              {members.length > 0 && (
                <tr className="bg-bg-tertiary/60">
                  <td
                    colSpan={6}
                    className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary"
                  >
                    Members ({members.length})
                  </td>
                </tr>
              )}
              {members.map(renderRow)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Projects tab ─────────────────────────────────────────────────────────

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

function TransferOwnershipDialog({
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
            Move &quot;{project.name}&quot; to a different owner. The current
            owner keeps editor access on the project.
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

function ProjectsTab() {
  const { data: projectsResp, isLoading } = useSWR<AdminProject[]>(
    "/admin/projects",
    () => api.get<AdminProject[]>("/admin/projects"),
  );

  const [renameTarget, setRenameTarget] = React.useState<AdminProject | null>(
    null,
  );
  const [transferTarget, setTransferTarget] =
    React.useState<AdminProject | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminProject | null>(
    null,
  );

  const refresh = () => mutate("/admin/projects");

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await api.delete(`/admin/projects/${deleteTarget.id}`);
    refresh();
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">
          All Projects
        </h2>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg bg-bg-tertiary"
            />
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
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Project
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Owner
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Members
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Assets
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Storage
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">
                  Created
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {projectsResp.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      {p.poster_url ? (
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
                      )}
                      <p className="text-sm font-medium text-text-primary truncate max-w-[200px]">
                        {p.name}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-text-primary truncate max-w-[160px]">
                      {p.owner_name ?? "—"}
                    </p>
                    <p className="text-xs text-text-tertiary truncate max-w-[160px]">
                      {p.owner_email ?? ""}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {p.member_count}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {p.asset_count}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {formatBytes(p.storage_bytes ?? 0)}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">
                    {p.created_at
                      ? new Date(p.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenameTarget(p)}
                        className="gap-1"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setTransferTarget(p)}
                        className="gap-1"
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" /> Transfer
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(p)}
                        className="gap-1 text-status-error hover:text-status-error"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <TransferOwnershipDialog
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
        description="This soft-deletes the project and all its assets. Only a database restore can undo it."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, isSuperAdmin } = useAuthStore();
  const router = useRouter();

  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace("/");
    }
  }, [user, isSuperAdmin, router]);

  if (!isSuperAdmin) {
    return null;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Shield className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            Admin Dashboard
          </h1>
          <p className="text-sm text-text-secondary">
            Manage platform users and projects
          </p>
        </div>
      </div>

      <Tabs.Root defaultValue="users">
        <Tabs.List className="flex items-center gap-1 border-b border-border -mb-px">
          {[
            { value: "users", label: "Users", icon: Users },
            { value: "projects", label: "Projects", icon: FolderKanban },
          ].map(({ value, label, icon: Icon }) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
                "border-transparent text-text-secondary hover:text-text-primary",
                "data-[state=active]:border-accent data-[state=active]:text-accent",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <div className="pt-6">
          <Tabs.Content value="users">
            <UsersTab />
          </Tabs.Content>
          <Tabs.Content value="projects">
            <ProjectsTab />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}
