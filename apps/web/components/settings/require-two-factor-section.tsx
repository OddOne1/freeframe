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
 *
 * §207 — turning it ON now signs people out, so it is no longer a one-click
 * switch. Turning it OFF still is: that direction ends no sessions and takes
 * nothing away from anybody.
 */
export function RequireTwoFactorSection() {
  const { requireTwoFactor, updateRequireTwoFactor, previewRequireTwoFactorImpact } =
    useSiteSettings();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState("");
  /** §207 — null means no confirmation is open. A number means "this many
   *  people will be signed out", read from the server before the admin
   *  decides. Counting the preview and the open/closed state as one piece of
   *  state rather than two keeps them from contradicting each other: there
   *  is no way to be showing the dialog without a figure in it. */
  const [pendingCount, setPendingCount] = React.useState<number | null>(null);
  const [counting, setCounting] = React.useState(false);

  /** Turning it ON: ask the server who that would sign out, then confirm. */
  const handleRequestTurnOn = async () => {
    setError("");
    setSaved("");
    setCounting(true);
    try {
      setPendingCount(await previewRequireTwoFactorImpact());
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not work out how many users this would sign out",
      );
    } finally {
      setCounting(false);
    }
  };

  const applyChange = async (next: boolean) => {
    setError("");
    setSaving(true);
    try {
      const signedOut = await updateRequireTwoFactor(next);
      setPendingCount(null);
      // The number reported back is the write's own row count, not the
      // preview above — see useSiteSettings.updateRequireTwoFactor.
      setSaved(
        next && signedOut
          ? `Saved — ${signedOut} ${signedOut === 1 ? "user was" : "users were"} signed out`
          : "Saved",
      );
      setTimeout(() => setSaved(""), 6000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update the 2FA requirement");
    } finally {
      setSaving(false);
    }
  };

  const confirming = pendingCount !== null;

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">
          Require two-factor authentication
        </h2>
      </div>
      <p className="text-xs text-text-secondary">
        Turning this on signs out everyone who has not set up a second factor yet, so
        they set one up before they get back in. Users who already have 2FA are not
        signed out. Users who chose 2FA for themselves keep it if you turn this back
        off. While it is on, magic-code sign-in is unavailable and everyone signs in
        with an email and password.
      </p>

      {confirming ? (
        /* §207 — the count is shown BEFORE the write, which is the whole
           point of this step: "turn on" used to be a single click whose
           blast radius was invisible. */
        <div className="space-y-3 rounded-md border border-status-warning/30 bg-status-warning/10 p-3">
          <p className="text-xs text-text-primary">
            {pendingCount === 0 ? (
              <>
                Everyone already has a second factor, so <strong>nobody will be signed
                out</strong>. Two-factor becomes mandatory for new accounts.
              </>
            ) : (
              <>
                <strong>
                  {pendingCount} {pendingCount === 1 ? "user" : "users"} will be signed out
                </strong>{" "}
                and must set up 2FA before they can sign in again. This includes you if
                you have not set up a second factor yourself.
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => applyChange(true)}
              loading={saving}
              className="h-8 px-3 text-xs"
            >
              Turn on and sign them out
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPendingCount(null)}
              disabled={saving}
              className="h-8 px-3 text-xs"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              requireTwoFactor ? applyChange(false) : handleRequestTurnOn()
            }
            loading={saving || counting}
            className="h-8 px-3 text-xs"
          >
            {requireTwoFactor ? "Turn off" : "Turn on"}
          </Button>
          <span className="text-xs text-text-tertiary">
            Currently <strong>{requireTwoFactor ? "required" : "optional"}</strong> for every user.
          </span>
          {saved && <span className="text-xs text-status-success">{saved}</span>}
        </div>
      )}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </section>
  );
}
