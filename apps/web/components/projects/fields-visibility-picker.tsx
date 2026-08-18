"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { FieldsVisibility } from "@/components/share/use-share-sidebar";

/**
 * How much asset metadata a share link exposes (CLAUDE.md §33).
 *
 * A three-way segmented control rather than a toggle plus a nested
 * sub-toggle: "off / some / all" is one decision, and nesting would imply
 * Full is a refinement of Basic that the viewer opts into, when it is
 * really the link owner choosing a level.
 *
 * Independent of the comments permission — a link may show fields without
 * allowing comments, or the reverse. Rendered by all three settings
 * surfaces from this one component, for the reason
 * `DownloadVariantPicker` is: two copies of one control drift.
 */

const LEVELS: { value: FieldsVisibility; label: string; hint: string }[] = [
  { value: "disabled", label: "Off", hint: "No details panel at all." },
  {
    value: "basic",
    label: "Basic",
    hint: "Name, type, description, rating, due date and keywords.",
  },
  {
    value: "full",
    label: "Full",
    hint: "Basic, plus the file's technical metadata and any camera sidecar data. Never includes your project's custom fields or who rated what.",
  },
];

export function FieldsVisibilityPicker({
  value,
  onChange,
  disabled,
}: {
  value: FieldsVisibility;
  onChange: (next: FieldsVisibility) => void;
  disabled?: boolean;
}) {
  const active = LEVELS.find((l) => l.value === value) ?? LEVELS[0];

  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label="Fields visibility"
        className="flex items-center gap-0.5 rounded-lg bg-bg-tertiary p-0.5"
      >
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={value === l.value}
            aria-label={l.label}
            disabled={disabled}
            onClick={() => onChange(l.value)}
            className={cn(
              "flex-1 rounded-md py-1.5 text-xs font-medium transition-colors",
              value === l.value
                ? "bg-bg-hover text-text-primary shadow-sm"
                : "text-text-tertiary hover:text-text-secondary",
              disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-text-tertiary">{active.hint}</p>
    </div>
  );
}
