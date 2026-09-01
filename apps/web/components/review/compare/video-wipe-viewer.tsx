'use client'

import * as React from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { VideoFrameConstraint } from '@/components/review/video-player'
import { WipeStage } from './wipe-stage'

interface VideoWipeViewerProps {
  /**
   * The SAME refs useSyncedTransport already drives. Deliberately passed in
   * rather than created here: the transport owns playback, and a second pair
   * of <video> elements would be two more players nothing is slaving.
   */
  videoRefA: React.RefObject<HTMLVideoElement>
  videoRefB: React.RefObject<HTMLVideoElement>
  badgeA: string
  badgeB: string
  /** Exclusive unmute — at most one side is ever audible (it is the clock master). */
  audioSide: 'a' | 'b' | 'none'
  onAudioSideChange(side: 'a' | 'b' | 'none'): void
  errA?: boolean
  errB?: boolean
  overlay?: React.ReactNode
  overlaySide?: 'a' | 'b' | null
}

/**
 * Video wipe stage: the two transport-driven <video> elements in the shared
 * WipeStage's clip layers.
 *
 * Rendering only. `clip-path` does not care whether it clips an <img> or a
 * <video>, and useSyncedTransport touches its refs solely through
 * currentTime/play/pause — it has no idea where either element is painted. So
 * wipe and side-by-side are the same two players in different boxes, and the
 * sync guarantees (audible-side-as-master, per-side offsets, per-side drift
 * tolerance) carry over untouched.
 */
export function VideoWipeViewer({
  videoRefA, videoRefB, badgeA, badgeB,
  audioSide, onAudioSideChange, errA, errB, overlay, overlaySide,
}: VideoWipeViewerProps) {
  const audioButton = (side: 'a' | 'b', badge: string) => (
    <button
      type="button"
      aria-label={audioSide === side ? `Mute ${badge}` : `Unmute ${badge}`}
      onClick={(e) => {
        // The stage's own pointer handlers sit on the container; without this
        // the click also reaches them.
        e.stopPropagation()
        onAudioSideChange(audioSide === side ? 'none' : side)
      }}
      className="flex h-7 w-7 items-center justify-center rounded bg-black/40 text-white/80 transition-colors hover:text-white"
    >
      {audioSide === side ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
    </button>
  )

  return (
    <WipeStage
      badgeA={badgeA}
      badgeB={badgeB}
      cornerA={audioButton('a', badgeA)}
      cornerB={audioButton('b', badgeB)}
      overlay={overlay}
      overlaySide={overlaySide}
      layerA={
        <>
          <video ref={videoRefA} data-testid="wipe-video-a" className="max-h-full max-w-full" playsInline muted={audioSide !== 'a'} />
          {errA && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeA}</span>}
        </>
      }
      layerB={
        <>
          <video ref={videoRefB} data-testid="wipe-video-b" className="max-h-full max-w-full" playsInline muted={audioSide !== 'b'} />
          {errB && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeB}</span>}
        </>
      }
      constrainOverlay={(side, children) => (
        // Drawings are authored inside VideoFrameConstraint on the normal
        // player (video-frame coordinates, letterbox excluded) — displayed in
        // the same space here. Keyed by side so switching owner remeasures
        // against that version's element.
        <VideoFrameConstraint key={side} videoRef={side === 'b' ? videoRefB : videoRefA}>
          {children}
        </VideoFrameConstraint>
      )}
    />
  )
}
