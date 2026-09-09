'use client'

import * as React from 'react'
import { Loader2, FileText, AlertCircle } from 'lucide-react'
import * as Switch from '@radix-ui/react-switch'
import { cn, formatTime, languageLabel } from '@/lib/utils'
import type { TranscriptResponse } from '@/types'

interface TranscriptPanelProps {
  transcript: TranscriptResponse | undefined
  isLoading: boolean
  /** Current playhead position, used to highlight the active line. */
  currentTime: number
  /** Seek the player. Same seekTo the comment deep-link already uses. */
  onSeek: (seconds: number) => void
  /** §127 — flip the per-file toggle. Omitted where the viewer cannot edit. */
  onToggle?: (enabled: boolean) => void
  toggleBusy?: boolean
}

/**
 * The per-file switch (§127).
 *
 * Deliberately reads as "should this file be transcribed", not "transcribe
 * now": turning it on for something already transcribed does nothing, and
 * turning it off mid-run stops that run. The label says which of those is
 * about to happen, because "off" means two quite different things depending
 * on whether work is in flight.
 */
function TranscriptionToggle({
  enabled,
  running,
  busy,
  onToggle,
}: {
  enabled: boolean
  running: boolean
  busy?: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-primary">Transcription</p>
        <p className="text-2xs text-text-tertiary">
          {enabled
            ? running
              ? 'Running — turning this off stops it'
              : 'On for this file'
            : 'Off for this file'}
        </p>
      </div>
      {/*
        Radix, like every other toggle here (appearance-popover's ToggleRow
        is the same markup). The hand-rolled version this replaces put the
        thumb at translate-x-4 when on — 16px, against the 18px a 20x36
        track needs to mirror its own 2px off-state inset — so the thumb sat
        2px short of the right edge and the two states looked unequal.
        Radix also supplies role/aria-checked, so only the label is ours.
      */}
      <Switch.Root
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={busy}
        aria-label="Transcribe this file"
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none disabled:opacity-50',
          enabled ? 'bg-accent' : 'bg-bg-tertiary',
        )}
      >
        <Switch.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white transition-transform',
            enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </Switch.Root>
    </div>
  )
}

export function TranscriptPanel({
  transcript,
  isLoading,
  currentTime,
  onSeek,
  onToggle,
  toggleBusy,
}: TranscriptPanelProps) {
  const status = transcript?.transcription_status
  const enabled = transcript?.transcription_enabled ?? true
  const running = status === 'processing'
  const header =
    onToggle && transcript ? (
      <TranscriptionToggle
        enabled={enabled}
        running={running}
        busy={toggleBusy}
        onToggle={onToggle}
      />
    ) : null

  if (isLoading && !transcript) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
      </div>
    )
  }

  // §127 — off, and nothing to show. Previously this fell into the
  // "Transcribing…" branch below via not_started, which claimed work was
  // happening when none was and none would be.
  if (!enabled && status !== 'ready') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <FileText className="h-5 w-5 text-text-tertiary" />
          <p className="text-sm font-medium text-text-primary">
            Transcription is off
          </p>
          <p className="text-xs text-text-tertiary max-w-[240px]">
            Turn it on to transcribe this file.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'processing' || status === 'not_started') {
    const pct = transcript?.transcription_progress ?? 0
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          <p className="text-sm font-medium text-text-primary">Transcribing…</p>
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Transcription progress"
            className="h-1 w-[200px] overflow-hidden rounded-full bg-bg-tertiary"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-text-tertiary max-w-[240px]">
            {/* The flat start is real and expected: the model load and the
                VAD pre-filter both finish before the first segment exists,
                so 0% here is "not there yet", not "stuck". Saying so is
                cheaper than someone reloading to check. */}
            {pct > 0
              ? `${pct}% — this runs in the background and appears here on its own.`
              : 'Preparing the audio. This can sit at 0% for a while before it starts moving.'}
          </p>
        </div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="h-5 w-5 text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">
          Transcription failed
        </p>
        <p className="text-xs text-text-tertiary max-w-[240px]">
          The asset itself is unaffected and still plays normally.
        </p>
        </div>
      </div>
    )
  }

  const segments = transcript?.segments ?? []

  if (segments.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText className="h-5 w-5 text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">No speech found</p>
        <p className="text-xs text-text-tertiary max-w-[240px]">
          Nothing recognizable was detected in this file&apos;s audio.
        </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {header}
      {transcript?.language && (
        <div className="px-4 py-2 border-b border-border/60 shrink-0">
          <span className="text-xs text-text-tertiary">
            Detected: {languageLabel(transcript.language)}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {segments.map((seg) => {
          const isActive = currentTime >= seg.start && currentTime < seg.end
          return (
            <button
              key={seg.id}
              onClick={() => onSeek(seg.start)}
              className={cn(
                'flex w-full gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                isActive
                  ? 'bg-bg-hover'
                  : 'hover:bg-bg-hover/60',
              )}
            >
              <span
                className={cn(
                  'shrink-0 pt-px font-mono text-[11px] tabular-nums',
                  isActive ? 'text-accent' : 'text-text-tertiary',
                )}
              >
                {formatTime(seg.start)}
              </span>
              <span
                className={cn(
                  'text-[13px] leading-snug',
                  isActive ? 'text-text-primary' : 'text-text-secondary',
                )}
              >
                {seg.text}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
