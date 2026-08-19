"use client";

import * as React from "react";
import useSWR from "swr";
import { LifeBuoy, Loader2, Mail, Send } from "lucide-react";
import { api } from "@/lib/api";
import { Avatar } from "@/components/shared/avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";

/** Matches ContactUserResponse in apps/api/schemas/auth.py -- deliberately
 *  narrower than the full User type, since GET /users/admins is callable by
 *  any authenticated user and returns only these four fields. */
interface ContactUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

/** Matches ContactSettingsResponse in apps/api/schemas/contact.py. The two
 *  optional fields are populated only for superadmins. */
interface ContactSettings {
  configured: boolean;
  target_email: string | null;
  requests_last_30_days: number | null;
}

export default function ContactPage() {
  const { user, isSuperAdmin } = useAuthStore();
  const { data: admins, isLoading, error } = useSWR<ContactUser[]>(
    "/users/admins",
    (key: string) => api.get<ContactUser[]>(key),
  );
  const { data: settings, mutate: mutateSettings } = useSWR<ContactSettings>(
    "/contact/settings",
    (key: string) => api.get<ContactSettings>(key),
  );

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <LifeBuoy className="h-5 w-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">Contact</h1>
          <p className="text-sm text-text-secondary">
            Send a message to the team, or reach an administrator directly.
          </p>
        </div>
        {isLoading && (
          <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
        )}
      </div>

      <ContactForm settings={settings} senderEmail={user?.email ?? null} />

      {isSuperAdmin && (
        <ContactAdminSection settings={settings} onChanged={() => mutateSettings()} />
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">
          Administrators
        </h2>
        <p className="-mt-1 text-xs text-text-tertiary">
          The form above reaches whoever is on support duty. These are the
          individual administrators, if you need a specific person.
        </p>

        {error ? (
          <EmptyState
            icon={LifeBuoy}
            title="Couldn't load contacts"
            description="Something went wrong fetching the administrator list. Try reloading the page."
          />
        ) : isLoading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-[68px] rounded-lg border border-border bg-bg-secondary animate-pulse"
              />
            ))}
          </div>
        ) : !admins || admins.length === 0 ? (
          <EmptyState
            icon={LifeBuoy}
            title="No administrators listed"
            description="There are no active administrators to contact right now."
          />
        ) : (
          <div className="space-y-3">
            {admins.map((admin) => (
              <div
                key={admin.id}
                className="flex items-center gap-3 p-4 rounded-lg border border-border bg-bg-secondary"
              >
                <Avatar
                  src={admin.avatar_url}
                  name={admin.name}
                  colorSeed={admin.id}
                  size="lg"
                />
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-text-primary truncate">
                    {admin.name}
                  </h3>
                  <a
                    href={`mailto:${admin.email}`}
                    className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-accent transition-colors"
                  >
                    <Mail className="h-3 w-3 shrink-0" />
                    <span className="truncate">{admin.email}</span>
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── The form ────────────────────────────────────────────────────────────────

/**
 * Sender identity comes from the session, never re-entered: this form lives
 * inside the authenticated app, and a name box would only invite a mismatch
 * with the account actually submitting.
 */
function ContactForm({
  settings,
  senderEmail,
}: {
  settings: ContactSettings | undefined;
  senderEmail: string | null;
}) {
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  // Undefined while loading -- not treated as unconfigured, which would
  // flash a "not set up" warning on every page load.
  const configured = settings?.configured;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.post("/contact", { subject: subject.trim() || null, message });
      setSent(true);
      setSubject("");
      setMessage("");
    } catch (err: unknown) {
      const detail =
        err && typeof err === "object" && "detail" in err
          ? String((err as { detail: unknown }).detail)
          : "Could not send your message.";
      setError(detail);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Send a message</h2>
        <p className="mt-0.5 text-xs text-text-tertiary">
          {senderEmail
            ? `Sent as ${senderEmail}, so we can reply.`
            : "Sent from your account, so we can reply."}
        </p>
      </div>

      {configured === false && (
        <p className="rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning">
          No contact address is configured yet. A superadmin needs to set one
          before this form can send.
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject (optional)"
          aria-label="Subject"
          disabled={configured === false}
        />
        <textarea
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setSent(false);
          }}
          rows={5}
          placeholder="What do you need help with?"
          aria-label="Message"
          disabled={configured === false}
          className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus disabled:opacity-60"
        />

        {error && <p className="text-xs text-status-error">{error}</p>}
        {sent && !error && (
          <p className="text-xs text-status-success">Message sent. We&apos;ll be in touch.</p>
        )}

        <Button
          type="submit"
          size="sm"
          loading={sending}
          disabled={configured === false || !message.trim()}
        >
          <Send className="h-4 w-4" />
          Send
        </Button>
      </form>
    </section>
  );
}

// ─── Superadmin configuration ────────────────────────────────────────────────

function ContactAdminSection({
  settings,
  onChanged,
}: {
  settings: ContactSettings | undefined;
  onChanged: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Seeded from the server, and re-seeded when it changes underneath --
  // an admin who never touches the box must not save an empty string over
  // a configured address.
  React.useEffect(() => {
    setValue(settings?.target_email ?? "");
  }, [settings?.target_email]);

  const dirty = value.trim() !== (settings?.target_email ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch("/contact/settings", { target_email: value.trim() });
      onChanged();
    } catch (err: unknown) {
      setError(
        err && typeof err === "object" && "detail" in err
          ? String((err as { detail: unknown }).detail)
          : "Could not save.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">
          Contact settings
        </h2>
        <p className="mt-0.5 text-xs text-text-tertiary">
          Superadmins only. Messages from the form above are delivered here.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="support@example.com"
          aria-label="Contact target email"
          className="max-w-xs"
        />
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
          Save
        </Button>
        {/* Clearing it is a real action, not an accident: an empty address
            disables the form rather than delivering nowhere. */}
        <span className="text-xs text-text-tertiary">
          {settings?.target_email ? "" : "Not configured — the form is disabled."}
        </span>
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}

      <p className="text-xs text-text-tertiary">
        <span className="font-medium text-text-secondary tabular-nums">
          {settings?.requests_last_30_days ?? 0}
        </span>{" "}
        message{settings?.requests_last_30_days === 1 ? "" : "s"} in the last 30 days
      </p>
    </section>
  );
}
