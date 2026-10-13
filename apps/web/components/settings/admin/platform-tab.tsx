"use client";

import * as React from "react";
import { HardDrive, Clock } from "lucide-react";
import { useFormatBytes } from "@/hooks/use-byte-units";
import { Button } from "@/components/ui/button";
import { useSiteSettings } from "@/hooks/use-site-settings";

const GB = 1024 ** 3;

// ─── Platform-wide storage limit (task added 2026-07-23) ──────────────────
// Separate from per-user/per-project limits (task 12) -- a single top-level
// cap enforced purely at upload time against real bytes used platform-wide.
// total_storage_used_bytes only comes back populated for a superadmin
// caller (see SiteSettingsResponse), which this page always is.

function PlatformStorageSection() {
  const formatBytes = useFormatBytes()
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
      {/* §229 — `flex-wrap`: at 390px the label, the field and Save are
          342px of row in a 294px card, and Save was the part that went
          over the edge. */}
      <div className="flex flex-wrap items-center gap-2">
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


// ─── Platform timezone (§182) ──────────────────────────────────────────────
// Decides what "03:00" means for the daily maintenance jobs (the Recently
// Deleted purge and the file-size reconciliation sweep). FreeFrame is
// self-hostable, so this belongs in settings rather than hardcoded.
//
// Celery's own timezone stays UTC and is NOT derived from this: those jobs
// tick every 15 minutes and compare the wall clock themselves, so a change
// here takes effect on the next tick — no restart, no redeploy.

/** Every zone the browser's own ICU data knows about.
 *
 *  `Intl.supportedValuesOf` rather than a hand-rolled list: a static list
 *  goes stale every time a country changes its rules, and there are ~400 of
 *  them. Guarded because it is ES2022 — an older engine falls back to the
 *  handful this deployment is most likely to want plus whatever is already
 *  saved, so the control degrades rather than disappears. */
function useTimeZones(current: string): string[] {
  return React.useMemo(() => {
    let zones: string[] = [];
    try {
      zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
        .supportedValuesOf?.("timeZone") ?? [];
    } catch {
      zones = [];
    }
    if (zones.length === 0) {
      zones = [
        "UTC", "Europe/Vienna", "Europe/London", "Europe/Berlin",
        "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Tokyo",
        "Australia/Sydney",
      ];
    }
    // The saved value always appears, even if this browser has never heard
    // of it — otherwise a <select> silently re-points at its first option
    // and the next Save would change a setting nobody touched.
    if (!zones.includes(current)) zones = [current, ...zones];
    if (!zones.includes("UTC")) zones = ["UTC", ...zones];
    return zones;
  }, [current]);
}

function TimezoneSection() {
  const { timezone, updateTimezone } = useSiteSettings();
  const [value, setValue] = React.useState(timezone);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const zones = useTimeZones(timezone);

  React.useEffect(() => {
    setValue(timezone);
  }, [timezone]);

  // The point of showing this: "03:00 in Europe/Vienna" is abstract, and
  // the current local time makes it concrete enough to catch a wrong pick.
  const nowThere = React.useMemo(() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: value, hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      }).format(new Date());
    } catch {
      return null;
    }
  }, [value]);

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      await updateTimezone(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update timezone");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">Timezone</h2>
      </div>
      <p className="text-xs text-text-secondary">
        Scheduled maintenance runs overnight in this timezone — the Recently Deleted purge at
        3:00 AM and the storage reconciliation sweep at 3:45 AM. Takes effect within 15 minutes;
        no restart needed.
        {nowThere && <> It&apos;s currently <strong>{nowThere}</strong> there.</>}
      </p>
      {/* §229 — the zone list is a 256px `<select>` beside a 110px label
          in a 294px card: at 390px it ran to x=411 against a 390px
          viewport. `flex-wrap` puts it on its own line, and `max-w-full`
          keeps it inside the card once it is there. */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="platform-timezone"
          className="text-xs font-medium text-text-tertiary whitespace-nowrap"
        >
          Platform Timezone
        </label>
        <select
          id="platform-timezone"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          className="h-8 w-64 max-w-full rounded-md border border-border bg-bg-secondary px-2 text-xs text-text-primary focus:outline-none focus:border-border-focus"
        >
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleSave}
          loading={saving}
          disabled={value === timezone}
          className="h-8 px-3 text-xs"
        >
          Save
        </Button>
        {saved && <span className="text-xs text-status-success">Saved</span>}
      </div>
      {error && <p className="text-xs text-status-error">{error}</p>}
    </section>
  );
}

/**
 * The Admin area's **Platform** tab (§229): the two instance-wide knobs
 * that are about the installation rather than about a person — how much
 * storage it may use in total, and what "03:00" means to its overnight
 * jobs.
 *
 * Both sections are lifted out of admin/page.tsx unchanged. The data they
 * read is `/site-settings`, which the dashboard shell already has in SWR's
 * cache (it is seeded server-side for the sidebar logo), so mounting this
 * tab issues no request of its own.
 */
export function PlatformTab() {
  return (
    <>
      <PlatformStorageSection />
      <TimezoneSection />
    </>
  );
}

