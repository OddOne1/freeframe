"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Users,
  X,
  Shield,
  Link2,
  Check,
  FolderKanban,
  Search,
  MoreHorizontal,
  ShieldAlert,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useFormatBytes } from "@/hooks/use-byte-units";
import { useBelowLg } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { PlainTh, SortableTh, useSort } from "@/components/shared/sortable";
import { useAuthStore } from "@/stores/auth-store";
import type {
  UserStatus,
  AdminUser,
  AdminUserProjectSummary,
  ProjectRole,
  PurgeUserPreviewResponse,
} from "@/types";

// Above this many projects, a user's project list collapses into a hover
// popover instead of inline chips, so the table stays readable.
const PROJECT_HOVER_THRESHOLD = 3;
const GB = 1024 ** 3;

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
        <Dialog.Content
          data-settings-touch className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
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

// ─── Delete confirmation dialog (task 1, 2026-07-23) ───────────────────────
// Permanent, irreversible -- gated behind typing the literal text "DELETE".
// Loads the owned-project handoff preview on open so the picker/notices are
// visible before the superadmin can even reach the confirm field.

//: §229 — the dialog can now be driven from outside as well as from its
//: own Delete button. On a phone the user row is a card and every action
//: lives in a `⋯` menu, and a Radix menu unmounts its items as it closes,
//: which would take an unopened dialog with it. So the card renders this
//: with `controlledOpen` and no trigger, OUTSIDE the menu. The table path
//: is unchanged: no props, own trigger, own state.
function DeleteUserDialog({
  targetUser,
  currentUserName,
  onDeleted,
  controlledOpen,
  onControlledOpenChange,
}: {
  targetUser: AdminUser;
  currentUserName: string;
  onDeleted: () => void;
  /** Omit for the self-triggering form; pass both to drive it. */
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
}) {
  const controlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const open = controlled ? controlledOpen : uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlled) onControlledOpenChange?.(next);
      else setUncontrolledOpen(next);
    },
    [controlled, onControlledOpenChange],
  );
  const [preview, setPreview] = React.useState<PurgeUserPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [assignments, setAssignments] = React.useState<Record<string, string>>({});
  const [confirmText, setConfirmText] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");

  const loadPreview = React.useCallback(async () => {
    setLoadingPreview(true);
    setError("");
    try {
      const resp = await api.get<PurgeUserPreviewResponse>(
        `/admin/users/${targetUser.id}/purge-preview`,
      );
      setPreview(resp);
      // Pre-select only when there's exactly one candidate -- the Delete
      // button below still requires an explicit click, so this never
      // applies a choice silently.
      const initial: Record<string, string> = {};
      for (const p of resp.owned_projects) {
        if (p.candidates.length === 1) initial[p.project_id] = p.candidates[0].id;
      }
      setAssignments(initial);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to load project ownership info",
      );
    } finally {
      setLoadingPreview(false);
    }
  }, [targetUser.id]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
  };

  //: §229 — the reset-and-load used to live inside `handleOpenChange`,
  //: which Radix calls when the dialog opens ITSELF from its trigger.
  //: The card opens it from outside, by flipping `controlledOpen`, and
  //: that path never calls it: the dialog came up with `preview` still
  //: null, so `projectsNeedingChoice` was empty, `allChoicesMade` was
  //: vacuously true, and the Delete button was live before anyone had
  //: been asked who inherits the projects. Keyed on the state the dialog
  //: is actually in, so both ways in behave the same.
  React.useEffect(() => {
    if (!open) return;
    setConfirmText("");
    setError("");
    setPreview(null);
    setAssignments({});
    loadPreview();
  }, [open, loadPreview]);

  const projectsNeedingChoice = (preview?.owned_projects ?? []).filter(
    (p) => p.candidates.length > 0,
  );
  const allChoicesMade = projectsNeedingChoice.every((p) => assignments[p.project_id]);
  const canDelete =
    confirmText === "DELETE" && !loadingPreview && !submitting && allChoicesMade;

  const handleDelete = async () => {
    if (!canDelete) return;
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/admin/users/${targetUser.id}/purge`, {
        owner_assignments: assignments,
      });
      setOpen(false);
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      {!controlled && (
        <Dialog.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error"
          >
            Delete
          </Button>
        </Dialog.Trigger>
      )}

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        {/* §229 — `max-h`/`overflow-y-auto` and a 16px side inset: the
            owned-project handoff list makes this the tallest dialog in
            Settings, and on a 390x640 phone it ran off both ends of the
            screen with the confirm field and the Delete button below the
            fold and no way to scroll to them. */}
        <Dialog.Content
          data-settings-touch className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto overscroll-contain rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="pr-8 text-base font-semibold text-text-primary">
            Delete {targetUser.name}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            This permanently deletes the account and can&apos;t be undone.
            Content other people built on top of theirs -- comments, replies,
            approvals -- stays fully intact, re-attributed to a
            &quot;Deleted user&quot; byline.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {loadingPreview ? (
              <div className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
            ) : (
              preview &&
              preview.owned_projects.length > 0 && (
                <div className="space-y-3 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3">
                  <p className="text-xs font-medium text-text-primary">
                    {targetUser.name} owns {preview.owned_projects.length}{" "}
                    project{preview.owned_projects.length > 1 ? "s" : ""}.
                    Choose a new owner for each before deleting.
                  </p>
                  {preview.owned_projects.map((p) =>
                    p.candidates.length > 0 ? (
                      <div
                        key={p.project_id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-xs text-text-secondary truncate">
                          {p.project_name}
                        </span>
                        <select
                          value={assignments[p.project_id] ?? ""}
                          onChange={(e) =>
                            setAssignments((prev) => ({
                              ...prev,
                              [p.project_id]: e.target.value,
                            }))
                          }
                          className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary focus:outline-none focus:border-border-focus"
                        >
                          <option value="" disabled>
                            Choose new owner…
                          </option>
                          {p.candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div
                        key={p.project_id}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="text-xs text-text-secondary truncate">
                          {p.project_name}
                        </span>
                        <span className="text-xs text-text-tertiary italic">
                          No Managers -- {currentUserName} (you) becomes owner
                        </span>
                      </div>
                    ),
                  )}
                </div>
              )
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">
                Type <span className="font-mono text-text-primary">DELETE</span>{" "}
                to confirm
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
              />
            </div>

            {error && <p className="text-xs text-status-error">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={!canDelete}
                loading={submitting}
                onClick={handleDelete}
              >
                Delete
              </Button>
            </div>
          </div>
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

// ─── Per-user storage limit (§19a) ─────────────────────────────────────────
// User.storage_limit_bytes has been enforced since task 12 (it caps what a
// user can allocate across the projects they own) but until now nothing
// could write it -- none of admin.py's user endpoints and none of users.py's
// touched the field, so the only way to change someone's quota was a manual
// UPDATE against the database.
//
// EMPTY MEANS UNLIMITED, not "back to 200GB". That's what NULL already means
// to the server (_check_owner_storage_allocation returns early on it) and to
// the rest of this UI, so the input says so out loud rather than letting a
// superadmin clear the field expecting the default and hand out unlimited
// storage instead. The 200GB default applies at INSERT only -- it now lives
// on the model itself (§37), so a new account reads "Currently 200 GB" here
// on its own and the line no longer has to advertise a default the field
// was not showing.

function UserStorageLimit({ user }: { user: AdminUser }) {
  const formatBytes = useFormatBytes()
  const toField = React.useCallback(
    (bytes: number | null | undefined) =>
      bytes === null || bytes === undefined ? "" : String(Math.round(bytes / GB)),
    [],
  );
  const [value, setValue] = React.useState(() => toField(user.storage_limit_bytes));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setValue(toField(user.storage_limit_bytes));
  }, [user.storage_limit_bytes, toField]);

  const dirty = value.trim() !== toField(user.storage_limit_bytes);

  const handleSave = async () => {
    setError("");
    const trimmed = value.trim();
    if (trimmed && (Number.isNaN(parseFloat(trimmed)) || parseFloat(trimmed) < 0)) {
      setError("Enter a positive number, or leave empty for unlimited.");
      return;
    }
    const bytes = trimmed ? Math.round(parseFloat(trimmed) * GB) : null;
    setSaving(true);
    try {
      await api.patch(`/admin/users/${user.id}/storage-limit`, {
        storage_limit_bytes: bytes,
      });
      mutate("/admin/users");
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
          min="0"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          placeholder="Unlimited"
          aria-label={`Storage limit in GB for ${user.name}`}
          // §229 — `hover-none:w-28`: the field is 80px, and the global
          // 16px touch font (§228b) turns its "Unlimited" placeholder
          // into "Unlimi…". Measured, not guessed: 96px still clipped the
          // last letter. Touch-only, so the table column keeps its 80px.
          className="w-20 rounded-md border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus hover-none:w-28"
        />
        <span className="text-[10px] text-text-tertiary">GB</span>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            loading={saving}
            className="h-6 px-2 text-xs"
          >
            Save
          </Button>
        )}
      </div>
      <p className="text-[10px] text-text-tertiary">
        {user.storage_limit_bytes === null || user.storage_limit_bytes === undefined
          ? "Currently unlimited"
          : `Currently ${formatBytes(user.storage_limit_bytes)}`}
      </p>
      {error && <p className="max-w-[200px] text-[10px] text-status-error">{error}</p>}
    </div>
  );
}

// ─── Per-user project list: inline chips, or a hover popover once there ─────
// are more than PROJECT_HOVER_THRESHOLD projects to keep rows readable. ─────

function UserProjects({
  projects,
  collapsed = false,
}: {
  projects: AdminUserProjectSummary[];
  /** §229 — always show the "n projects" button, never inline chips.
   *  What the card is short of is WIDTH, and three project chips with a
   *  role badge each is the widest thing a row carries. */
  collapsed?: boolean;
}) {
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

  if (!collapsed && projects.length <= PROJECT_HOVER_THRESHOLD) {
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
          className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary hover-none:min-h-9 hover-none:px-2.5"
        >
          <FolderKanban className="h-3 w-3" />
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-settings-touch
          side="bottom"
          align="start"
          sideOffset={6}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          className="z-50 w-64 max-h-72 overflow-y-auto rounded-xl border border-border bg-bg-secondary shadow-xl p-2 space-y-1
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {projects.map((p) => (
            <div
              key={p.project_id}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-bg-hover"
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

// ─── User group block: independent bordered table per group, collapsible ──

/** Accessors, one per sortable column. Deliberately absent: **Projects**,
 *  which is a list of badges per row with no single value to order by
 *  (count would be a different column than the one shown), and **Actions**,
 *  which is controls. Both stay plain headers rather than being given a sort
 *  that would not mean what the column shows. */
const USER_SORT = {
  user: (u: AdminUser) => u.name,
  role: (u: AdminUser) => u.role ?? null,
  status: (u: AdminUser) => u.status ?? null,
  joined: (u: AdminUser) => u.created_at,
  // Unlimited is the absent value, and sorts last either way rather than
  // pretending to be zero -- which would file it below a 1GB cap.
  storage: (u: AdminUser) => u.storage_limit_bytes ?? null,
};

function UserGroupBlock({
  title,
  users,
  storageKey,
  defaultCollapsed,
  renderRow,
  renderCard,
  asCards,
}: {
  title: string;
  users: AdminUser[];
  /** Suffix of the localStorage key; collapse state now survives a reload
   *  (§38), which it did not when this held its own useState. */
  storageKey: string;
  defaultCollapsed?: boolean;
  renderRow: (u: AdminUser) => React.ReactNode;
  /** §229 — the same user as a card, for phones. */
  renderCard: (u: AdminUser) => React.ReactNode;
  /** True below `lg` (see `BELOW_LG`). A card is a different TREE, not a
   *  restyled row — seven `<td>`s become a stack with a `⋯` menu — so
   *  this is one of the two JavaScript breakpoints in §229 rather than a
   *  CSS one. Rendering both and hiding one would mount every dialog and
   *  popover twice. */
  asCards: boolean;
}) {
  // One sort per block, so sorting Admins leaves Members alone.
  const { sorted, sort } = useSort(users, USER_SORT, { key: "user" });

  if (users.length === 0) return null;

  return (
    <CollapsibleSection
      tone="block"
      title={title}
      count={users.length}
      storageKey={storageKey}
      defaultCollapsed={defaultCollapsed}
    >
      {asCards ? (
        // No column headers: there are no columns. The per-block sort
        // lives in those headers, so a card list is name-ordered — which
        // is `useSort`'s own default and what the table opens on.
        <ul data-testid="user-card-list">{sorted.map(renderCard)}</ul>
      ) : (
      <table className="w-full text-sm min-w-[760px]">
        <thead>
          <tr className="border-b border-t border-border bg-bg-tertiary">
            <SortableTh label="User" sortKey="user" sort={sort} />
            <PlainTh label="Projects" />
            <SortableTh label="Role" sortKey="role" sort={sort} />
            <SortableTh label="Status" sortKey="status" sort={sort} />
            <SortableTh label="Joined" sortKey="joined" sort={sort} />
            <SortableTh label="Storage" sortKey="storage" sort={sort} />
            <PlainTh label="Actions" align="right" />
          </tr>
        </thead>
        <tbody>{sorted.map(renderRow)}</tbody>
      </table>
      )}
    </CollapsibleSection>
  );
}

// ─── The same user, as a card — below `md` (§229) ─────────────────────────
//
// The owner's screenshot: the Platform Users table in ~134px of a 390px
// phone, names and e-mails cut off mid-word. Removing the sidebar gives
// the table 390px, which is still 370px short of the 760px it declares as
// a minimum — a seven-column table is not a phone layout however much
// room it is given.
//
// So below `md` a user is a card. Everything the row carries is still
// here and nothing is dropped:
//
//   avatar, name, e-mail        the head of the card; the e-mail wraps
//                               (`break-all`) rather than truncating, so
//                               the full address is readable without a
//                               tooltip there is no way to hover
//   role, status                chips, on their own line
//   projects                    always the collapsed "n projects" button,
//                               which opens the same popover the table's
//                               4-or-more case uses
//   joined                      beside the chips
//   storage limit               the same field and Save button
//   Copy Invite Link            ⋯ menu
//   Clear Setup Block           ⋯ menu
//   Make / Remove Admin         ⋯ menu
//   Deactivate / Reactivate     ⋯ menu
//   Delete                      ⋯ menu (deactivated, not yourself)
//   "You"                       a chip, where the row has italic text

function UserActionsMenu({
  u,
  currentUserId,
  copied,
  onCopyInviteLink,
  onClearAccountGate,
  onToggleAdmin,
  onDeactivate,
  onReactivate,
  onDelete,
}: {
  u: AdminUser;
  currentUserId?: string;
  copied: boolean;
  onCopyInviteLink: (u: AdminUser) => void;
  onClearAccountGate: (u: AdminUser) => void;
  onToggleAdmin: (userId: string, isCurrentlyAdmin: boolean) => void;
  onDeactivate: (userId: string) => void;
  onReactivate: (userId: string) => void;
  onDelete: () => void;
}) {
  const isSelf = u.id === currentUserId;
  const gated =
    u.must_set_password || (u.backup_email_state ?? "missing") !== "verified";
  const canInviteLink = u.status === "pending_invite" && !!u.invite_token;

  const item =
    "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-secondary outline-none transition-colors cursor-pointer hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

  // Everything is self-only, so there is nothing to open: a card for
  // yourself shows the "You" chip and no menu at all rather than a button
  // that opens an empty sheet.
  if (isSelf && !gated && !canInviteLink) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="user-card-menu"
          aria-label={`Actions for ${u.name}`}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          data-settings-touch
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 min-w-[200px] max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-bg-secondary p-1 shadow-xl"
        >
          {canInviteLink && (
            <DropdownMenu.Item
              className={item}
              onSelect={() => onCopyInviteLink(u)}
            >
              {copied ? (
                <Check className="h-4 w-4 text-status-success" />
              ) : (
                <Link2 className="h-4 w-4 text-text-tertiary" />
              )}
              {copied ? "Copied" : "Copy Invite Link"}
            </DropdownMenu.Item>
          )}
          {gated && (
            <DropdownMenu.Item
              className={item}
              onSelect={() => onClearAccountGate(u)}
            >
              <UserCheck className="h-4 w-4 text-text-tertiary" />
              Clear Setup Block
            </DropdownMenu.Item>
          )}
          {!isSelf && (
            <DropdownMenu.Item
              className={item}
              onSelect={() => onToggleAdmin(u.id, u.role === "superadmin")}
            >
              <Shield className="h-4 w-4 text-text-tertiary" />
              {u.role === "superadmin" ? "Remove Admin" : "Make Admin"}
            </DropdownMenu.Item>
          )}
          {!isSelf && u.status === "active" && (
            <DropdownMenu.Item
              className={cn(item, "text-status-error hover:text-status-error")}
              onSelect={() => onDeactivate(u.id)}
            >
              <UserX className="h-4 w-4" />
              Deactivate
            </DropdownMenu.Item>
          )}
          {!isSelf && u.status === "deactivated" && (
            <DropdownMenu.Item className={item} onSelect={() => onReactivate(u.id)}>
              <UserCheck className="h-4 w-4 text-text-tertiary" />
              Reactivate
            </DropdownMenu.Item>
          )}
          {!isSelf && u.status === "deactivated" && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className={cn(item, "text-status-error hover:text-status-error")}
                onSelect={onDelete}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserCard({
  u,
  currentUserId,
  currentUserName,
  copied,
  onCopyInviteLink,
  onClearAccountGate,
  onToggleAdmin,
  onDeactivate,
  onReactivate,
}: {
  u: AdminUser;
  currentUserId?: string;
  currentUserName: string;
  copied: boolean;
  onCopyInviteLink: (u: AdminUser) => void;
  onClearAccountGate: (u: AdminUser) => void;
  onToggleAdmin: (userId: string, isCurrentlyAdmin: boolean) => void;
  onDeactivate: (userId: string) => void;
  onReactivate: (userId: string) => void;
}) {
  // Driven from here rather than from inside the menu: see the note on
  // DeleteUserDialog.
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const isSelf = u.id === currentUserId;

  return (
    <li
      data-testid="user-card"
      className="border-b border-border p-3 last:border-0"
    >
      <div className="flex items-start gap-2.5">
        <Avatar src={u.avatar_url} name={u.name} colorSeed={u.id} size="md" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-text-primary">
            {u.name}
          </p>
          {/* `break-all`, not `truncate`: an address is the thing an admin
              reads a user row FOR, and there is no hover to recover a
              truncated one on a phone. */}
          <p className="break-all text-xs text-text-tertiary">{u.email}</p>
        </div>
        <UserActionsMenu
          u={u}
          currentUserId={currentUserId}
          copied={copied}
          onCopyInviteLink={onCopyInviteLink}
          onClearAccountGate={onClearAccountGate}
          onToggleAdmin={onToggleAdmin}
          onDeactivate={onDeactivate}
          onReactivate={onReactivate}
          onDelete={() => setDeleteOpen(true)}
        />
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {u.role === "superadmin" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
            <Shield className="h-3 w-3" />
            Admin
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
            User
          </span>
        )}
        {userStatusBadge(u.status)}
        {isSelf && (
          <span className="inline-flex items-center rounded-full bg-bg-tertiary px-2 py-0.5 text-xs italic text-text-tertiary">
            You
          </span>
        )}
        <UserProjects projects={u.projects} collapsed />
        <span className="text-xs text-text-tertiary">
          Joined {u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}
        </span>
      </div>

      <div className="mt-2.5">
        <UserStorageLimit user={u} />
      </div>

      <DeleteUserDialog
        targetUser={u}
        currentUserName={currentUserName}
        onDeleted={() => mutate("/admin/users")}
        controlledOpen={deleteOpen}
        onControlledOpenChange={setDeleteOpen}
      />
    </li>
  );
}

// ─── The Users tab ────────────────────────────────────────────────────────
// Project management (rename/archive/delete/transfer/all-projects) lives
// on the superadmin-only /settings/projects tab now -- every Project Admin
// already manages their own projects on /projects, and superadmins get the
// full "All Projects" table there instead. This tab is Users-only.

//: §200 — the escape hatches for a stuck account both need somebody else.
//:
//: A superadmin can clear another user's account-setup gate, and reset their
//: 2FA, from the user list below. Neither works on the LAST superadmin if
//: they are the one who is stuck: there is nobody left to press the button,
//: and the only way back is `apps/api/scripts/clear_account_gate.py` over
//: SSH — which this instance's operator may not have to hand, and which does
//: not exist at all for the 2FA case (admin_disable_two_factor deliberately
//: refuses self-use).
//:
//: So this says it once, where the person who can fix it is already standing.
//: Dismissible, and remembered per browser rather than per account, because
//: it is advice rather than state: a second superadmin either exists or does
//: not, and the banner reappears on its own if one is ever removed.
const SINGLE_SUPERADMIN_DISMISSED_KEY = "ff_single_superadmin_dismissed";

function SingleSuperadminBanner({ superadminCount }: { superadminCount: number }) {
  const [dismissed, setDismissed] = React.useState(true);

  React.useEffect(() => {
    // Read in an effect, not in the initial state: localStorage does not
    // exist during the server render, and reading it there is a hydration
    // mismatch. Defaulting to dismissed means the banner fades in rather
    // than flashing away.
    try {
      setDismissed(
        window.localStorage.getItem(SINGLE_SUPERADMIN_DISMISSED_KEY) === "1",
      );
    } catch {
      setDismissed(false);
    }
  }, []);

  if (superadminCount !== 1 || dismissed) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-status-warning/40 bg-status-warning/10 p-4">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">
          This instance has only one administrator
        </p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">
          Administrators are what unblock a locked-out account — clearing
          someone&apos;s account-setup requirement, or resetting their
          two-factor authentication. Neither of those works on yourself, so
          with one administrator there is no in-app way back if it is your own
          account that gets stuck. Make a second person an administrator
          below.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(SINGLE_SUPERADMIN_DISMISSED_KEY, "1");
          } catch {
            // A browser refusing storage should not keep the banner from
            // closing for this session.
          }
        }}
        className="shrink-0 text-text-tertiary transition-colors hover:text-text-secondary"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * The Admin area's **Users** tab (§229): the Platform Users block and the
 * single-superadmin banner, which is advice about who is in that list.
 *
 * `/admin/users` is fetched HERE rather than on the page, which is the
 * point of the split: an admin who came to change the SMTP host no longer
 * pulls down every account on the instance on the way.
 *
 * The superadmin redirect is not repeated here — the page above owns it,
 * and this never mounts for anyone else.
 */
export function UsersTab() {
  const { user } = useAuthStore();
  // Cards below `lg`, not below `md` — see the note on BELOW_LG.
  const asCards = useBelowLg();

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

  const handleClearAccountGate = async (u: AdminUser) => {
    // Confirmed first: this waives a security requirement for a named
    // person, and it is one click away from the Deactivate button.
    if (
      !window.confirm(
        `Let ${u.email} back into the app without finishing account setup?\n\n` +
          `They will still be asked to set a password and confirm a ` +
          `password-reset address in Settings → Profile. This is recorded in ` +
          `the activity log.`,
      )
    ) {
      return;
    }
    try {
      await api.patch(`/admin/users/${u.id}/clear-account-gate`);
      mutate("/admin/users");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to clear the account gate";
      alert(message);
    }
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

  const [search, setSearch] = React.useState("");

  const filteredUsers = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return usersResp ?? [];
    return (usersResp ?? []).filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [usersResp, search]);

  // Grouping (task 2) stays intact -- search filters within each group, it
  // doesn't collapse the admin/member split. Deactivated users (any role) get
  // pulled out into their own group entirely rather than just sorted to the
  // bottom within Admins/Members.
  //
  // Ordering is no longer done here: each block sorts itself from its column
  // headers (§40), which is also why the old "Sort: Name/Email/Status"
  // dropdown is gone -- it was being overridden by the table and had become a
  // control that did nothing.
  const admins = React.useMemo(
    () =>
      filteredUsers
        .filter((u) => u.role === "superadmin" && u.status !== "deactivated"),
    [filteredUsers],
  );
  const members = React.useMemo(
    () =>
      filteredUsers
        .filter((u) => u.role !== "superadmin" && u.status !== "deactivated"),
    [filteredUsers],
  );
  const deactivated = React.useMemo(
    () => filteredUsers.filter((u) => u.status === "deactivated"),
    [filteredUsers],
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
        {u.role === "superadmin" ? (
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
        <UserStorageLimit user={u} />
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
          {/* §200 — shown only for a user who is ACTUALLY gated, so it is
              not a standing button that waives a requirement nobody has.
              `must_set_password` and `backup_email_state` come from the same
              derived fields the server gates on, so this appears and
              disappears with the real state rather than with a flag. */}
          {(u.must_set_password ||
            (u.backup_email_state ?? "missing") !== "verified") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleClearAccountGate(u)}
              className="gap-1"
              title={
                u.must_set_password
                  ? "No password set, and no confirmed password-reset address"
                  : `Password-reset address: ${u.backup_email_state}`
              }
            >
              <UserCheck className="h-3.5 w-3.5" /> Clear Setup Block
            </Button>
          )}
          {u.id !== user?.id && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleToggleAdmin(u.id, u.role === "superadmin")}
            >
              {u.role === "superadmin" ? "Remove Admin" : "Make Admin"}
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
          {/* Deactivated only (CLAUDE.md 17d). Permanent deletion now
              requires an explicit deactivate step first, enforced by the
              API — this hides the shortcut rather than being the control
              itself. Hidden rather than disabled, matching the
              Deactivate/Reactivate mutual exclusivity just above. */}
          {u.id !== user?.id && u.status === "deactivated" && (
            <DeleteUserDialog
              targetUser={u}
              currentUserName={user?.name ?? "You"}
              onDeleted={() => mutate("/admin/users")}
            />
          )}
        </div>
      </td>
    </tr>
  );

  const renderCard = (u: AdminUser) => (
    <UserCard
      key={u.id}
      u={u}
      currentUserId={user?.id}
      currentUserName={user?.name ?? "You"}
      copied={copiedId === u.id}
      onCopyInviteLink={handleCopyInviteLink}
      onClearAccountGate={handleClearAccountGate}
      onToggleAdmin={handleToggleAdmin}
      onDeactivate={handleDeactivate}
      onReactivate={handleReactivate}
    />
  );

  return (
    <div className="space-y-6">
      {/* Counted off the UNFILTERED list, not `admins` — that one is
          narrowed by the search box, and a banner that appeared when
          somebody typed a name would be telling the truth about the wrong
          question. */}
      <SingleSuperadminBanner
        superadminCount={
          (usersResp ?? []).filter(
            (u) => u.role === "superadmin" && u.status !== "deactivated",
          ).length
        }
      />

      <section className="space-y-4">
        {/* §229 — search and Invite stack above the list on a phone
            (`flex-col` below `sm`) instead of being squeezed beside a
            heading into 390px. At `sm`+ this is the row it always was. */}
        {/* §229 — no "Platform Users" heading here any more: the tab
            header above says exactly that, and two of them one above the
            other is what a section that became a tab looks like when
            nobody took the old title out. Search and Invite stack on a
            phone (`flex-col` below `sm`) rather than being squeezed
            beside each other into 342px. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            icon={<Search className="h-3.5 w-3.5" />}
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full text-xs sm:w-56"
          />
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
        ) : admins.length === 0 && members.length === 0 && deactivated.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary">
            <EmptyState
              icon={Search}
              title="No matching users"
              description="Try a different name or email."
            />
          </div>
        ) : (
          <div className="space-y-4">
            <UserGroupBlock
              title="Admins"
              users={admins}
              storageKey="admin-admins"
              renderRow={renderRow}
              renderCard={renderCard}
              asCards={asCards}
            />
            <UserGroupBlock
              title="Members"
              users={members}
              storageKey="admin-members"
              renderRow={renderRow}
              renderCard={renderCard}
              asCards={asCards}
            />
            <UserGroupBlock
              title="Deactivated"
              users={deactivated}
              storageKey="admin-deactivated"
              // Unchanged: this one has always started closed.
              defaultCollapsed
              renderRow={renderRow}
              renderCard={renderCard}
              asCards={asCards}
            />
          </div>
        )}
      </section>
    </div>
  );
}
