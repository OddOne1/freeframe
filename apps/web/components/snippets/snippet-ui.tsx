'use client'

/**
 * Small pieces the SocialSnippet screens share: a Radix select styled like
 * asset-metadata's, badges, the status pill, a labelled switch and the
 * "coming soon" tooltip. Class strings follow the existing components so the
 * page reads as part of the app, not as a new design system.
 */
import * as React from 'react'
import * as Select from '@radix-ui/react-select'
import * as Switch from '@radix-ui/react-switch'
import * as Tooltip from '@radix-ui/react-tooltip'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SnippetSource, SnippetStatus } from '@/types'

// ─── Select ──────────────────────────────────────────────────────────────────

export interface SelectOption<V extends string> {
  value: V
  label: string
}

export function SnippetSelect<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V
  onChange: (v: V) => void
  options: SelectOption<V>[]
  /** The accessible name; shown as a prefix inside the trigger. */
  label: string
  className?: string
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as V)}>
      <Select.Trigger
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-8 hover-none:h-11 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus',
          className,
        )}
      >
        <span className="truncate">
          <span className="text-text-tertiary">{label}: </span>
          <Select.Value>{current?.label}</Select.Value>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[60] min-w-[160px] max-h-[60vh] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl"
        >
          <Select.Viewport className="p-1">
            {options.map((opt) => (
              <Select.Item
                key={opt.value}
                value={opt.value}
                className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 hover-none:py-2.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </Select.ItemIndicator>
                <Select.ItemText>{opt.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

// ─── Labelled switch (share-link-detail's pattern) ───────────────────────────

export function LabelledSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        {description && <p className="text-xs text-text-tertiary mt-0.5">{description}</p>}
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          checked ? 'bg-accent' : 'bg-bg-hover',
        )}
      >
        <Switch.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </Switch.Root>
    </div>
  )
}

// ─── Badges ──────────────────────────────────────────────────────────────────

/** The contract's four sources, as the three words the UI uses. */
export function sourceLabel(source: SnippetSource): 'auto' | 'imported' | 'manual' {
  if (source === 'import') return 'imported'
  if (source === 'manual') return 'manual'
  return 'auto'
}

export function SourceBadge({ source, generator }: { source: SnippetSource; generator?: string | null }) {
  return (
    <span
      title={generator ? `${source} · ${generator}` : source}
      className="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide bg-bg-tertiary text-text-tertiary border border-border"
    >
      {sourceLabel(source)}
    </span>
  )
}

/** A 0..1 score as a whole number out of 100. Renders NOTHING for null:
 *  "not scored" is shown as no badge at all, never as zero. */
export function ScoreBadge({ label, title, score }: { label: string; title: string; score: number | null }) {
  if (score == null) return null
  const pct = Math.round(score <= 1 ? score * 100 : score)
  return (
    <span
      title={`${title}: ${pct} / 100`}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums bg-accent/10 text-accent"
    >
      <span className="opacity-70">{label}</span>
      {pct}
    </span>
  )
}

const STATUS_STYLE: Record<SnippetStatus, { label: string; dot: string; bg: string; text: string }> = {
  suggested: { label: 'Suggested', dot: 'bg-status-info', bg: 'bg-status-info/10', text: 'text-status-info' },
  approved: { label: 'Approved', dot: 'bg-status-success', bg: 'bg-status-success/10', text: 'text-status-success' },
  rejected: { label: 'Rejected', dot: 'bg-status-error', bg: 'bg-status-error/10', text: 'text-status-error' },
}

export function StatusPill({ status }: { status: SnippetStatus }) {
  const s = STATUS_STYLE[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium', s.bg, s.text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

/** A person changed this clip's title, topics or in/out points, so clip
 *  detection will not replace it. Rendered only when that is true. */
export function EditedPill() {
  return (
    <span
      title="Edited by a person: re-detecting clips will not replace it"
      className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-text-secondary"
    >
      edited
    </span>
  )
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

/**
 * A tooltip that also works on a disabled button: disabled buttons fire no
 * pointer events, so the trigger is a focusable wrapper span, which keeps the
 * hint reachable by keyboard too.
 */
export function HintTooltip({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            tabIndex={0}
            aria-label={hint}
            className="inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {children}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-[70] rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-primary shadow-lg"
          >
            {hint}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

// ─── Chips ───────────────────────────────────────────────────────────────────

const chipClass = (active?: boolean) =>
  cn(
    'inline-flex items-center gap-1 rounded-full border px-2.5 h-7 hover-none:h-9 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
    active
      ? 'border-accent/40 bg-accent/10 text-accent'
      : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  )

/** A toggle chip (a topic on a card, a source filter). */
export function Chip({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  title?: string
}) {
  return (
    <button type="button" className={chipClass(active)} onClick={onClick} aria-pressed={active} title={title}>
      {children}
    </button>
  )
}

/** An applied filter, with its own remove button. */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className={chipClass(true)}>
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
