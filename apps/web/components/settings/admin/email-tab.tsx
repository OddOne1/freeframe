"use client";

import * as React from "react";
import { Mail, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useEmailSettings } from "@/hooks/use-email-settings";

// ─── Email / SMTP settings (2026-07-30) ─────────────────────────────────────
// Deliberately backed by its own superadmin-only endpoint, NOT /site-settings
// -- that one is public (it serves login-page branding) and must never carry
// mail credentials. See apps/api/routers/email_settings.py.

type SmtpSecurity = "starttls" | "implicit_tls" | "none";

/** The three real arrangements, named the way an admin would recognise them
 *  rather than the way the column spells them (§199). The port each one
 *  usually goes with is in the hint, because that is the thing people
 *  actually get wrong. */
const SMTP_SECURITY_OPTIONS: { value: SmtpSecurity; label: string; hint: string }[] = [
  {
    value: "starttls",
    label: "STARTTLS",
    hint: "Connects in the clear, then upgrades to TLS. Usually port 587. Correct for Microsoft 365, Gmail and most hosted relays.",
  },
  {
    value: "implicit_tls",
    label: "SSL/TLS (implicit)",
    hint: "Encrypted from the first byte. Usually port 465.",
  },
  {
    value: "none",
    label: "None",
    hint: "No encryption at all. Only for a relay on a network you trust — credentials and message bodies travel in the clear.",
  },
];

function EmailSettingsSection() {
  const { settings, isLoading, update, sendTest } = useEmailSettings();

  const [provider, setProvider] = React.useState("smtp");
  const [fromAddress, setFromAddress] = React.useState("");
  const [fromName, setFromName] = React.useState("");
  const [smtpHost, setSmtpHost] = React.useState("");
  const [smtpPort, setSmtpPort] = React.useState("");
  const [smtpUser, setSmtpUser] = React.useState("");
  // §199 — the checkbox this replaces could only say two things, and read
  // "off" as implicit TLS rather than as no encryption, so a plaintext relay
  // was unreachable. `smtpUseTls` is still sent alongside it so an older API
  // (or a .env-only install) keeps behaving the same.
  const [smtpSecurity, setSmtpSecurity] = React.useState<SmtpSecurity>("starttls");
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
    // The EFFECTIVE mode, not the stored one: a never-configured install has
    // no stored value, and showing an empty/"none" selector there would say
    // "unencrypted" about a connection that is really STARTTLS by default.
    setSmtpSecurity(
      (settings.smtp_security ?? settings.effective_smtp_security ?? "starttls") as SmtpSecurity,
    );
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
        smtp_security: smtpSecurity,
        // Kept in sync so the legacy boolean never contradicts the mode —
        // it is what .env.prod holds and what an older API would read.
        smtp_use_tls: smtpSecurity === "starttls",
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

      {/* The sentence above says WHICH config is active; this says which
          address actually results from it. Unconditional — the saved-
          settings branch never showed a From address at all, and the env
          branch only ever showed the SMTP host. */}
      {!isLoading && settings?.effective_from_address && (
        <p className="text-xs text-text-secondary">
          Currently sending as{" "}
          <span className="font-medium text-text-primary">
            {settings.effective_from_address}
          </span>
        </p>
      )}

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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-medium text-text-tertiary" htmlFor="smtp-security">
              Encryption
            </label>
            <select
              id="smtp-security"
              className={inputClass}
              value={smtpSecurity}
              onChange={(e) => setSmtpSecurity(e.target.value as SmtpSecurity)}
            >
              {SMTP_SECURITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-tertiary">
              {SMTP_SECURITY_OPTIONS.find((o) => o.value === smtpSecurity)?.hint}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={inputClass + " w-full max-w-xs"}
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

/**
 * The Admin area's **Email** tab (§229): mail configuration, nothing else.
 *
 * Unchanged from the section that used to sit between the 2FA switch and
 * the user table on one long Admin page. What IS new is that
 * `/email-settings` is now fetched only while this tab is open — it is a
 * superadmin-only endpoint carrying SMTP credentials, and the old page
 * asked for it on every visit to Admin whatever the admin had come for.
 */
export function EmailTab() {
  return <EmailSettingsSection />;
}

