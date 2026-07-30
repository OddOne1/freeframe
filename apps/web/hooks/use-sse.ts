'use client'

import * as React from 'react'
import { getAccessToken } from '@/lib/auth'

// ─── Event payload types ──────────────────────────────────────────────────────

export interface TranscodeProgressEvent {
  asset_id: string
  percent: number
}

export interface TranscodeCompleteEvent {
  asset_id: string
  version_id: string
}

export interface TranscodeFailedEvent {
  asset_id: string
  error: string
}

/** Speech-to-text runs after the asset is already playable, so these are
 *  separate from the transcode_* events above -- an asset can be `ready`
 *  and mid-transcription at the same time. */
export interface TranscriptionProcessingEvent {
  asset_id: string
  version_id: string
}

export interface TranscriptionCompleteEvent {
  asset_id: string
  version_id: string
  language: string | null
  segment_count: number
}

export interface TranscriptionFailedEvent {
  asset_id: string
  version_id: string
  error: string
}

export interface NewCommentEvent {
  asset_id: string
  comment_id: string
  author: string
}

export interface CommentResolvedEvent {
  comment_id: string
}

export interface ApprovalUpdatedEvent {
  asset_id: string
  user_id: string
  status: string
}

export type SSEEventType =
  | 'transcode_progress'
  | 'transcode_complete'
  | 'transcode_failed'
  | 'transcription_processing'
  | 'transcription_complete'
  | 'transcription_failed'
  | 'new_comment'
  | 'comment_resolved'
  | 'approval_updated'

export interface SSEEvent {
  type: SSEEventType
  data:
    | TranscodeProgressEvent
    | TranscodeCompleteEvent
    | TranscodeFailedEvent
    | TranscriptionProcessingEvent
    | TranscriptionCompleteEvent
    | TranscriptionFailedEvent
    | NewCommentEvent
    | CommentResolvedEvent
    | ApprovalUpdatedEvent
}

// ─── Hook options ─────────────────────────────────────────────────────────────

export interface UseSSEOptions {
  onTranscodeProgress?: (data: TranscodeProgressEvent) => void
  onTranscodeComplete?: (data: TranscodeCompleteEvent) => void
  onTranscodeFailed?: (data: TranscodeFailedEvent) => void
  onTranscriptionProcessing?: (data: TranscriptionProcessingEvent) => void
  onTranscriptionComplete?: (data: TranscriptionCompleteEvent) => void
  onTranscriptionFailed?: (data: TranscriptionFailedEvent) => void
  onNewComment?: (data: NewCommentEvent) => void
  onCommentResolved?: (data: CommentResolvedEvent) => void
  onApprovalUpdated?: (data: ApprovalUpdatedEvent) => void
  enabled?: boolean
}

export interface UseSSEReturn {
  isConnected: boolean
  lastEvent: SSEEvent | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000]

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSSE(projectId: string | null | undefined, options: UseSSEOptions = {}): UseSSEReturn {
  const {
    onTranscodeProgress,
    onTranscodeComplete,
    onTranscodeFailed,
    onTranscriptionProcessing,
    onTranscriptionComplete,
    onTranscriptionFailed,
    onNewComment,
    onCommentResolved,
    onApprovalUpdated,
    enabled = true,
  } = options

  const [isConnected, setIsConnected] = React.useState(false)
  const [lastEvent, setLastEvent] = React.useState<SSEEvent | null>(null)

  // Stable callback refs so reconnects don't need to re-register handlers
  const callbackRefs = React.useRef({
    onTranscodeProgress,
    onTranscodeComplete,
    onTranscodeFailed,
    onTranscriptionProcessing,
    onTranscriptionComplete,
    onTranscriptionFailed,
    onNewComment,
    onCommentResolved,
    onApprovalUpdated,
  })

  React.useEffect(() => {
    callbackRefs.current = {
      onTranscodeProgress,
      onTranscodeComplete,
      onTranscodeFailed,
      onTranscriptionProcessing,
      onTranscriptionComplete,
      onTranscriptionFailed,
      onNewComment,
      onCommentResolved,
      onApprovalUpdated,
    }
  })

  React.useEffect(() => {
    if (!enabled || !projectId) return

    let es: EventSource | null = null
    let retryIndex = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false

    function connect() {
      if (destroyed) return

      const token = getAccessToken()
      // Use window.location.origin as a base so deployments behind a reverse
      // proxy can set NEXT_PUBLIC_API_URL to a relative path like "/api"
      // without crashing the URL constructor.
      const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
      const url = new URL(`${API_URL}/events/${projectId}`, base)
      if (token) {
        url.searchParams.set('token', token)
      }

      es = new EventSource(url.toString())

      es.onopen = () => {
        if (destroyed) return
        setIsConnected(true)
        retryIndex = 0 // reset backoff on successful connection
      }

      es.onerror = () => {
        if (destroyed) return
        setIsConnected(false)
        es?.close()
        es = null

        // Exponential backoff reconnect
        const delay = BACKOFF_STEPS[Math.min(retryIndex, BACKOFF_STEPS.length - 1)]
        retryIndex++
        retryTimer = setTimeout(connect, delay)
      }

      // ── transcode_progress ──
      es.addEventListener('transcode_progress', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeProgressEvent
          const event: SSEEvent = { type: 'transcode_progress', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeProgress?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcode_complete ──
      es.addEventListener('transcode_complete', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeCompleteEvent
          const event: SSEEvent = { type: 'transcode_complete', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeComplete?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcode_failed ──
      es.addEventListener('transcode_failed', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeFailedEvent
          const event: SSEEvent = { type: 'transcode_failed', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeFailed?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcription_processing ──
      es.addEventListener('transcription_processing', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscriptionProcessingEvent
          const event: SSEEvent = { type: 'transcription_processing', data }
          setLastEvent(event)
          callbackRefs.current.onTranscriptionProcessing?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcription_complete ──
      es.addEventListener('transcription_complete', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscriptionCompleteEvent
          const event: SSEEvent = { type: 'transcription_complete', data }
          setLastEvent(event)
          callbackRefs.current.onTranscriptionComplete?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcription_failed ──
      es.addEventListener('transcription_failed', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscriptionFailedEvent
          const event: SSEEvent = { type: 'transcription_failed', data }
          setLastEvent(event)
          callbackRefs.current.onTranscriptionFailed?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── new_comment ──
      es.addEventListener('new_comment', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as NewCommentEvent
          const event: SSEEvent = { type: 'new_comment', data }
          setLastEvent(event)
          callbackRefs.current.onNewComment?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── comment_resolved ──
      es.addEventListener('comment_resolved', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as CommentResolvedEvent
          const event: SSEEvent = { type: 'comment_resolved', data }
          setLastEvent(event)
          callbackRefs.current.onCommentResolved?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── approval_updated ──
      es.addEventListener('approval_updated', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as ApprovalUpdatedEvent
          const event: SSEEvent = { type: 'approval_updated', data }
          setLastEvent(event)
          callbackRefs.current.onApprovalUpdated?.(data)
        } catch {
          // ignore malformed events
        }
      })
    }

    connect()

    return () => {
      destroyed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      es?.close()
      setIsConnected(false)
    }
  }, [projectId, enabled])

  return { isConnected, lastEvent }
}
