"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ALL_DOWNLOAD_VARIANTS,
  DOWNLOAD_VARIANT_LABELS,
  type DownloadVariant,
} from "@/types";

/**
 * Which download variants a share link permits (CLAUDE.md §30/§30b).
 *
 * Presented as three quality rows with an optional "+ LUT" column rather
 * than six flat checkboxes: the six are really two independent choices,
 * and a flat list makes that read as six unrelated switches.
 *
 * Every combination remains individually selectable — the grid is a
 * presentation, not a constraint. A link may legitimately offer
 * "Proxy 720p + LUT" without offering plain "Proxy 720p".
 *
 * Both settings surfaces (the create dialog and the detail panel) render
 * this same component, so the two cannot drift the way five copies of a
 * role check did in §13.
 */

const ROWS: { quality: string; plain: DownloadVariant; lut: DownloadVariant }[] = [
  { quality: "Original", plain: "raw", lut: "raw_lut" },
  { quality: "Proxy 1080p", plain: "proxy_1080p", lut: "proxy_1080p_lut" },
  { quality: "Proxy 720p", plain: "proxy_720p", lut: "proxy_720p_lut" },
];

function Box({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded border transition-colors",
        checked
          ? "border-accent bg-accent text-white"
          : "border-border bg-bg-tertiary hover:border-text-tertiary",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      {checked && <Check className="h-3.5 w-3.5" />}
    </button>
  );
}

export function DownloadVariantPicker({
  value,
  onChange,
  disabled,
}: {
  value: DownloadVariant[];
  onChange: (next: DownloadVariant[]) => void;
  disabled?: boolean;
}) {
  const has = (v: DownloadVariant) => value.includes(v);

  const toggle = (v: DownloadVariant, next: boolean) => {
    // Rebuild from the canonical order rather than pushing/splicing, so
    // the stored list never depends on the order the boxes were clicked.
    const set = new Set(value);
    if (next) set.add(v);
    else set.delete(v);
    onChange(ALL_DOWNLOAD_VARIANTS.filter((k) => set.has(k)));
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-1">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
          Quality
        </span>
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
          Plain
        </span>
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
          + LUT
        </span>

        {ROWS.map((row) => (
          <React.Fragment key={row.quality}>
            <span className="text-xs text-text-primary">{row.quality}</span>
            <Box
              checked={has(row.plain)}
              onChange={(n) => toggle(row.plain, n)}
              label={DOWNLOAD_VARIANT_LABELS[row.plain]}
              disabled={disabled}
            />
            <Box
              checked={has(row.lut)}
              onChange={(n) => toggle(row.lut, n)}
              label={DOWNLOAD_VARIANT_LABELS[row.lut]}
              disabled={disabled}
            />
          </React.Fragment>
        ))}
      </div>

      <p className="text-[11px] leading-snug text-text-tertiary">
        {value.length === 0
          ? "Downloads are off — viewers can watch but not save anything."
          : `Viewers may download ${value.length} of 6 options. LUT versions are only offered on assets that have a LUT applied.`}
      </p>
    </div>
  );
}
