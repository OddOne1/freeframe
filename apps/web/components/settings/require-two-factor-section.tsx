"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { useSiteSettings } from "@/hooks/use-site-settings";
import { Button } from "@/components/ui/button";

/**
 * The instance-wide "require 2FA" switch, for admin settings (§197).
 *
 * Its own file rather than another section inside admin/page.tsx, for a
 * reason worth writing down: a Next page module may only export the keys
 * Next knows about, so exporting this from there to test it in isolation
 * fails the build's own type check ("not assignable to type 'never'").
 * Rendering the whole admin page to exercise one toggle would drag in SWR,
 * the user table and the email settings panel, and break for reasons that
 * have nothing to do with this switch.
 *
 * Shaped after TimezoneSection, the section it sits beside: same card, same
 * save/saved/error handling.
 */
export function RequireTwoFactorSection() {
  const { requireTwoFactor, updateRequireTwoFactor } = useSiteSettings();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  const handleToggle = async (next: boolean) => {
    setError("");
    setSaving(true);
    try {
      await updateRequireTwoFactor(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update the 2FA requirement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">
          Require two-factor authentication
        </h2>
      </div>
      <p className="text-xs text-text-secondary">
        Nobody is locked out when you turn this on: users who have not set up a second
        factor are walked through it at their next sign-in, rather than refused. Users who
        already chose 2FA for themselves keep it if you turn this back off. While it is on,
        magic-code sign-in is unavailable and everyone signs in with an email and password.
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => handleToggle(!requireTwoFactor)}
          loading={saving}
          className="h-8 px-3 text-xs"
        >
          {requireTwoFactor ? "Turn off" : "Turn on"}
        </Button>
        <span className="text-xs text-text-tertiary">
          Currently <strong>{requireTwoFactor ? "required" : "optional"}</strong> for every user.
        </span>
        {saved && <span className="text-xs text-status-success">Saved</span>}
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </section>
  );
}
