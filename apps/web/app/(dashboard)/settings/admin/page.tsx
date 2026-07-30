"use client";

import * as React from "react";
import useSWR, { mutate } from "swr";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  Users,
  X,
  Shield,
  Link2,
  Check,
  FolderKanban,
  Search,
  ChevronDown,
  HardDrive,
  Mail,
  Send,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/shared/avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { useAuthStore } from "@/stores/auth-store";
import { useSiteSettings } from "@/hooks/use-site-settings";
import { useEmailSettings } from "@/hooks/use-email-settings";
import { useRouter } from "next/navigation";
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

// ─── Platform-wide storage limit (task added 2026-07-23) ──────────────────
// Separate from per-user/per-project limits (task 12) -- a single top-level
// cap enforced purely at upload time against real bytes used platform-wide.
// total_storage_used_bytes only comes back populated for a superadmin
// caller (see SiteSettingsResponse), which this page always is.

function PlatformStorageSection() {
  const { totalStorageLimitBytes, totalStorageUsedBytes, updateTotalStorageLimit } =
    useSiteSettings();
  const [value, setValue] = React.useState<string>(
    totalStorageLimitBytes ? String(Math.round(totalStorageLimitBytes / GB)) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setValue(totalStorageLimitBytes ? String(Math.round(totalStorageLimitBytes / GB)) : "");
  }, [totalStorageLimitBytes]);

  const usedBytes = totalStorageUsedBytes ?? 0;
  const percent =
    totalStorageLimitBytes && totalStorageLimitBytes > 0
      ? (usedBytes / totalStorageLimitBytes) * 100
      : null;

  const handleSave = async () => {
    setError("");
    const trimmed = value.trim();
    if (trimmed && (Number.isNaN(parseFloat(trimmed)) || parseFloat(trimmed) <= 0)) {
      setError("Enter a positive number, or leave empty for no cap.");
      return;
    }
    const bytes = trimmed ? Math.round(parseFloat(trimmed) * GB) : null;
    if (bytes !== null && bytes < usedBytes) {
      setError(
        `Heads up: this is below the ${formatBytes(usedBytes)} already used -- new uploads will be blocked until usage drops below the cap.`,
      );
    }
    setSaving(true);
    try {
      await updateTotalStorageLimit(bytes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update platform storage limit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">Platform Storage</h2>
      </div>
      <p className="text-xs text-text-secondary">
        {formatBytes(usedBytes)} used
        {totalStorageLimitBytes !== null && ` of ${formatBytes(totalStorageLimitBytes)} limit`}
        {percent !== null && ` (${Math.round(percent)}%)`}
        {totalStorageLimitBytes === null && " -- no cap set"}
      </p>
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-text-tertiary whitespace-nowrap">
          Platform Storage Limit (GB)
        </label>
        <input
          type="number"
          min="1"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          placeholder="No cap"
          className="h-8 w-28 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSave}
          loading={saving}
          className="h-8 px-3 text-xs"
        >
          Save
        </Button>
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </section>
  );
}


// ─── Email / SMTP settings (2026-07-30) ─────────────────────────────────────
// Deliberately backed by its own superadmin-only endpoint, NOT /site-settings
// -- that one is public (it serves login-page branding) and must never carry
// mail credentials. See apps/api/routers/email_settings.py.

function EmailSettingsSection() {
  const { settings, isLoading, update, sendTest } = useEmailSettings();

  const [provider, setProvider] = React.useState("smtp");
  const [fromAddress, setFromAddress] = React.useState("");
  const [fromName, setFromName] = React.useState("");
  const [smtpHost, setSmtpHost] = React.useState("");
  const [smtpPort, setSmtpPort] = React.useState("");
  const [smtpUser, setSmtpUser] = React.useState("");
  const [smtpUseTls, setSmtpUseTls] = React.useState(true);
  const [awsKeyId, setAwsKeyId] = React.useState("");
  const [awsRegion, setAwsRegion] = React.useState("");

  // Secrets are write-only: always blank on load, never pre-filled from the
  // server (which never sends them), and only transmitted when the admin
  // actually types something. Same convention as the profile page's own
  // password field.
  const [smtpPassword, setSmtpPassword] = React.useState("");
  const [awsSecret, setAwsSecret] = React.useState("");

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  const [testTo, setTestTo] = React.useState("");
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; detail: string } | null>(null);

  React.useEffect(() => {
    if (!settings) return;
    setProvider(settings.mail_provider ?? settings.effective_provider ?? "smtp");
    setFromAddress(settings.mail_from_address ?? "");
    setFromName(settings.mail_from_name ?? "");
    setSmtpHost(settings.smtp_host ?? "");
    setSmtpPort(settings.smtp_port ? String(settings.smtp_port) : "");
    setSmtpUser(settings.smtp_user ?? "");
    setSmtpUseTls(settings.smtp_use_tls ?? true);
    setAwsKeyId(settings.aws_mail_access_key_id ?? "");
    setAwsRegion(settings.aws_mail_region ?? "");
    // Secret boxes intentionally not repopulated.
  }, [settings]);

  const handleSave = async () => {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await update({
        mail_provider: provider,
        mail_from_address: fromAddress,
        mail_from_name: fromName,
        smtp_host: smtpHost,
        smtp_port: smtpPort.trim() ? parseInt(smtpPort, 10) : null,
        smtp_user: smtpUser,
        smtp_use_tls: smtpUseTls,
        aws_mail_access_key_id: awsKeyId,
        aws_mail_region: awsRegion,
        // Only sent when non-empty -- an untouched box leaves the stored
        // credential alone rather than wiping it.
        ...(smtpPassword ? { smtp_password: smtpPassword } : {}),
        ...(awsSecret ? { aws_mail_secret_access_key: awsSecret } : {}),
      });
      setSmtpPassword("");
      setAwsSecret("");
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save email settings");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      const res = await sendTest(testTo.trim());
      setTestResult({ ok: res.success, detail: res.detail });
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        detail: err instanceof Error ? err.message : "Could not send test email",
      });
    } finally {
      setTesting(false);
    }
  };

  const inputClass =
    "h-8 w-full rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus";

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">Email &amp; SMTP</h2>
      </div>

      <p className="text-xs text-text-secondary">
        {isLoading
          ? "Loading…"
          : settings?.using_env_fallback
            ? `Currently using the server environment configuration${
                settings?.effective_smtp_host ? ` (${settings.effective_smtp_host})` : ""
              }. Anything you set here overrides it.`
            : "Using the settings saved here. Any field you leave empty falls back to the server environment."}
      </p>

      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-text-tertiary w-28 shrink-0">Provider</label>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary focus:outline-none focus:border-border-focus"
        >
          <option value="smtp">SMTP</option>
          <option value="ses">AWS SES</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-tertiary">From address</label>
          <input className={inputClass} value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="noreply@example.com" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-text-tertiary">From name</label>
          <input className={inputClass} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="FreeFrame" />
        </div>
      </div>

      {provider === "smtp" ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">SMTP host</label>
            <input className={inputClass} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.office365.com" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">Port</label>
            <input className={inputClass} type="number" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">Username</label>
            <input className={inputClass} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">
              Password {settings?.smtp_password_set && <span className="text-text-tertiary">(saved)</span>}
            </label>
            <input
              className={inputClass}
              type="password"
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              placeholder={settings?.smtp_password_set ? "Leave blank to keep current" : "Not set"}
              autoComplete="new-password"
            />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={smtpUseTls} onChange={(e) => setSmtpUseTls(e.target.checked)} />
            Use STARTTLS
          </label>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">Access key ID</label>
            <input className={inputClass} value={awsKeyId} onChange={(e) => setAwsKeyId(e.target.value)} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">
              Secret access key {settings?.aws_mail_secret_access_key_set && <span className="text-text-tertiary">(saved)</span>}
            </label>
            <input
              className={inputClass}
              type="password"
              value={awsSecret}
              onChange={(e) => setAwsSecret(e.target.value)}
              placeholder={settings?.aws_mail_secret_access_key_set ? "Leave blank to keep current" : "Not set"}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-text-tertiary">Region</label>
            <input className={inputClass} value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder="ap-south-1" />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={handleSave} loading={saving} className="h-8 px-3 text-xs">
          Save
        </Button>
        {saved && <span className="text-xs text-status-success">Saved.</span>}
        {error && <span className="text-xs text-status-error">{error}</span>}
      </div>

      <div className="border-t border-border pt-3 space-y-2">
        <label className="text-xs font-medium text-text-tertiary">
          Send a test email using the saved settings
        </label>
        <div className="flex items-center gap-2">
          <input
            className={inputClass + " max-w-xs"}
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            loading={testing}
            disabled={!testTo.trim()}
            className="h-8 px-3 text-xs"
          >
            <Send className="h-3.5 w-3.5" />
            Send test
          </Button>
        </div>
        {testResult && (
          <p className={cn("text-xs", testResult.ok ? "text-status-success" : "text-status-error")}>
            {testResult.detail}
          </p>
        )}
      </div>
    </section>
  );
}

// ─── Delete confirmation dialog (task 1, 2026-07-23) ───────────────────────
// Permanent, irreversible -- gated behind typing the literal text "DELETE".
// Loads the owned-project handoff preview on open so the picker/notices are
// visible before the superadmin can even reach the confirm field.

function DeleteUserDialog({
  targetUser,
  currentUserName,
  onDeleted,
}: {
  targetUser: AdminUser;
  currentUserName: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
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
    if (next) {
      setConfirmText("");
      setError("");
      setPreview(null);
      setAssignments({});
      loadPreview();
    }
  };

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
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-status-error hover:text-status-error"
        >
          Delete
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="text-base font-semibold text-text-primary">
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

// ─── User group block: independent bordered table per group, collapsible ──

const USER_TABLE_COLUMNS = [
  { key: "user", label: "User", align: "left" as const },
  { key: "projects", label: "Projects", align: "left" as const },
  { key: "role", label: "Role", align: "left" as const },
  { key: "status", label: "Status", align: "left" as const },
  { key: "joined", label: "Joined", align: "left" as const },
  { key: "actions", label: "Actions", align: "right" as const },
];

function UserGroupBlock({
  title,
  users,
  collapsed,
  onToggle,
  renderRow,
}: {
  title: string;
  users: AdminUser[];
  collapsed: boolean;
  onToggle: () => void;
  renderRow: (u: AdminUser) => React.ReactNode;
}) {
  if (users.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-x-auto">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 bg-bg-tertiary/60 px-4 py-2 text-left transition-colors hover:bg-bg-tertiary"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
          {title} ({users.length})
        </span>
      </button>

      {!collapsed && (
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="border-b border-t border-border bg-bg-tertiary">
              {USER_TABLE_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-2.5 text-xs font-medium text-text-tertiary",
                    col.align === "right" ? "text-right" : "text-left",
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{users.map(renderRow)}</tbody>
        </table>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
// Project management (rename/archive/delete/transfer/all-projects) lives
// on the superadmin-only /settings/projects tab now -- every Project Admin
// already manages their own projects on /projects, and superadmins get the
// full "All Projects" table there instead. This page is Users-only.

export default function AdminPage() {
  const { user, isSuperAdmin } = useAuthStore();
  const router = useRouter();

  const { data: usersResp, isLoading: loadingUsers } = useSWR<AdminUser[]>(
    "/admin/users",
    () => api.get<AdminUser[]>("/admin/users"),
  );

  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace("/");
    }
  }, [user, isSuperAdmin, router]);

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

  const [search, setSearch] = React.useState("");
  const [sortBy, setSortBy] = React.useState<"name" | "email" | "status">(
    "name",
  );
  const [adminsCollapsed, setAdminsCollapsed] = React.useState(false);
  const [membersCollapsed, setMembersCollapsed] = React.useState(false);
  const [deactivatedCollapsed, setDeactivatedCollapsed] = React.useState(true);

  const filteredUsers = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return usersResp ?? [];
    return (usersResp ?? []).filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [usersResp, search]);

  const compareUsers = React.useCallback(
    (a: AdminUser, b: AdminUser) => {
      switch (sortBy) {
        case "email":
          return a.email.localeCompare(b.email);
        case "status": {
          // Active first, everything else (deactivated/pending/unverified)
          // after -- ties broken by name so the order stays stable.
          const rank = (u: AdminUser) => (u.status === "active" ? 0 : 1);
          const diff = rank(a) - rank(b);
          return diff !== 0 ? diff : a.name.localeCompare(b.name);
        }
        case "name":
        default:
          return a.name.localeCompare(b.name);
      }
    },
    [sortBy],
  );

  // Grouping (task 2) stays intact -- search/sort (task 3) filter and order
  // within each group, they don't collapse the admin/member split.
  // Deactivated users (any role) get pulled out into their own group
  // entirely rather than just sorted to the bottom within Admins/Members.
  const admins = React.useMemo(
    () =>
      filteredUsers
        .filter((u) => u.role === "superadmin" && u.status !== "deactivated")
        .sort(compareUsers),
    [filteredUsers, compareUsers],
  );
  const members = React.useMemo(
    () =>
      filteredUsers
        .filter((u) => u.role !== "superadmin" && u.status !== "deactivated")
        .sort(compareUsers),
    [filteredUsers, compareUsers],
  );
  const deactivated = React.useMemo(
    () => filteredUsers.filter((u) => u.status === "deactivated").sort(compareUsers),
    [filteredUsers, compareUsers],
  );

  if (!isSuperAdmin) {
    return null;
  }

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
          {u.id !== user?.id && (
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
            Manage platform users.
          </p>
        </div>
      </div>

      <PlatformStorageSection />

      <EmailSettingsSection />

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-text-primary">
            Platform Users
          </h2>
          <div className="flex items-center gap-2">
            <Input
              icon={<Search className="h-3.5 w-3.5" />}
              placeholder="Search by name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-56 text-xs"
            />
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(e.target.value as "name" | "email" | "status")
              }
              className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary focus:outline-none focus:border-border-focus"
              aria-label="Sort users by"
            >
              <option value="name">Sort: Name</option>
              <option value="email">Sort: Email</option>
              <option value="status">Sort: Status</option>
            </select>
            <BulkInviteDialog />
          </div>
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
              collapsed={adminsCollapsed}
              onToggle={() => setAdminsCollapsed((c) => !c)}
              renderRow={renderRow}
            />
            <UserGroupBlock
              title="Members"
              users={members}
              collapsed={membersCollapsed}
              onToggle={() => setMembersCollapsed((c) => !c)}
              renderRow={renderRow}
            />
            <UserGroupBlock
              title="Deactivated"
              users={deactivated}
              collapsed={deactivatedCollapsed}
              onToggle={() => setDeactivatedCollapsed((c) => !c)}
              renderRow={renderRow}
            />
          </div>
        )}
      </section>
    </div>
  );
}
