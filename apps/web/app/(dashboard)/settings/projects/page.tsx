"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
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
} from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { useAuthStore } from "@/stores/auth-store";
import type { AdminProject, User } from "@/types";

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

export default function SettingsProjectsPage() {
  const router = useRouter();
  const { user, isSuperAdmin } = useAuthStore();
  const { data: projectsResp, isLoading } = useSWR<AdminProject[]>(
    isSuperAdmin ? "/admin/projects" : null,
    () => api.get<AdminProject[]>("/admin/projects"),
  );

  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace("/");
    }
  }, [user, isSuperAdmin, router]);

  const [renameTarget, setRenameTarget] = React.useState<AdminProject | null>(null);
  const [transferTarget, setTransferTarget] = React.useState<AdminProject | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminProject | null>(null);
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

  if (!isSuperAdmin) {
    return null;
  }

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
        <div className="rounded-lg border border-border bg-bg-secondary overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
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
            <tbody>
              {projectsResp.map((p) => {
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
                    <td className="px-4 py-3 text-text-secondary">{p.member_count}</td>
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
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {!hasAccess ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleJoinAndView(p)}
                            loading={joining === p.id}
                            className="gap-1"
                          >
                            <LogIn className="h-3.5 w-3.5" /> Join &amp; View
                          </Button>
                        ) : isPeekOnly ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleLeave(p)}
                            loading={leaving === p.id}
                            className="gap-1"
                          >
                            <LogOut className="h-3.5 w-3.5" /> Leave
                          </Button>
                        ) : (
                          <span className="px-2 text-xs italic text-text-tertiary">
                            Member
                          </span>
                        )}
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
                          onClick={() => handleArchiveToggle(p)}
                          loading={archiving === p.id}
                          className="gap-1"
                        >
                          {p.archived_at ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                          {p.archived_at ? "Reactivate" : "Archive"}
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
                );
              })}
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
