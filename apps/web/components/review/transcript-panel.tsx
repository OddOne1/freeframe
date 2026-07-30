'use client'

import * as React from 'react'
import { Loader2, FileText, AlertCircle } from 'lucide-react'
import { cn, formatTime, languageLabel } from '@/lib/utils'
import type { TranscriptResponse } from '@/types'

interface TranscriptPanelProps {
  transcript: TranscriptResponse | undefined
  isLoading: boolean
  /** Current playhead position, used to highlight the active line. */
  currentTime: number
  /** Seek the player. Same seekTo the comment deep-link already uses. */
  onSeek: (seconds: number) => void
}

export function TranscriptPanel({
  transcript,
  isLoading,
  currentTime,
  onSeek,
}: TranscriptPanelProps) {
  const status = transcript?.transcription_status

  if (isLoading && !transcript) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
      </div>
    )
  }

  if (status === 'processing' || status === 'not_started') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">Transcribing…</p>
        <p className="text-xs text-text-tertiary max-w-[240px]">
          This runs in the background and can take a while. The transcript
          appears here on its own when it&apos;s done.
        </p>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="h-5 w-5 text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">
          Transcription failed
        </p>
        <p className="text-xs text-text-tertiary max-w-[240px]">
          The asset itself is unaffected and still plays normally.
        </p>
      </div>
    )
  }

  const segments = transcript?.segments ?? []

  if (segments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <FileText className="h-5 w-5 text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">No speech found</p>
        <p className="text-xs text-text-tertiary max-w-[240px]">
          Nothing recognizable was detected in this file&apos;s audio.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
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
