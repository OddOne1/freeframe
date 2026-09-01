'use client'

import * as React from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { VideoFrameConstraint } from '@/components/review/video-player'
import { useWipeSplit, WipeDivider } from './use-wipe-split'
import { COMPARE_MEDIA_CLASS, ComparePane } from './compare-pane'

interface CompareVideoStageProps {
  mode: 'wipe' | 'sbs'
  /** Shared zoom/pan — ONE transform for both panes (see useSharedTransform). */
  transform?: {
    styleFor(): React.CSSProperties
    onWheel(e: { deltaY: number; preventDefault(): void }): void
    onPointerDown(e: React.PointerEvent): void
  }
  videoRefA: React.RefObject<HTMLVideoElement>
  videoRefB: React.RefObject<HTMLVideoElement>
  badgeA: string
  badgeB: string
  audioSide: 'a' | 'b' | 'none'
  onAudioSideChange(side: 'a' | 'b' | 'none'): void
  errA?: boolean
  errB?: boolean
  /** Per-pane annotation display + authoring layer. */
  paneOverlayA?: React.ReactNode
  paneOverlayB?: React.ReactNode
}

/**
 * Both compare videos, mounted ONCE, in either layout.
 *
 * THIS IS THE FIX, and the whole point of the component existing. Wipe and
 * side-by-side used to be two mutually-exclusive JSX subtrees at the same
 * position in the tree, each rendering its own <video>. Passing the same ref
 * object to both does nothing to stop React unmounting one DOM node and
 * mounting another when the branch flips — and use-video-player's
 * source-attaching effect is keyed on `src`, not on the element's identity,
 * so the freshly-mounted element got no HLS and no src and sat dead until a
 * version switch happened to change `src`. Native currentTime lives on the
 * DOM node too, so playback position went with it.
 *
 * So the two <video> elements are mounted unconditionally here and `mode`
 * changes nothing but CSS. Switching modes now moves no DOM nodes at all.
 *
 * The two layouts really are the same shape once you stop treating them as
 * different components — two panes over one container:
 *
 *   sbs   each pane is a flex half; the panes sit beside each other.
 *   wipe  each pane is `absolute inset-0` over the whole stage, and each is
 *         CLIPPED to its own side of the divider.
 *
 * Clipping pane A as well as pane B is a small change from the old wipe
 * stage (which left A unclipped underneath and clipped only B). It costs
 * nothing visually — A is only ever visible left of the divider either way —
 * and it means each pane's annotation overlay is clipped by its own pane, so
 * a drawing cannot bleed across the divider without a second, separate clip
 * layer to arrange it.
 */
/**
 * Sizing and pane containment now live in compare-pane.tsx, shared with the
 * image stage — see that file for why (§116: the same bug had to be fixed
 * twice because these two kept private copies of the same markup).
 *
 * The rule itself is unchanged from §110: `w-full h-full object-contain`
 * rather than `max-*`, which only scales down and left the video stuck at
 * intrinsic size in a larger pane. It also keeps VideoFrameConstraint honest,
 * since that computes the contain-box assuming the element fills its parent.
 */

export function CompareVideoStage({
  mode, videoRefA, videoRefB, badgeA, badgeB, transform,
  audioSide, onAudioSideChange, errA, errB, paneOverlayA, paneOverlayB,
}: CompareVideoStageProps) {
  // Lives here, so it survives a mode switch: going sbs -> wipe -> sbs keeps
  // the divider where the user put it.
  const { split, stageRef, onDividerDown } = useWipeSplit()
  const isWipe = mode === 'wipe'

  // No measuring effect any more: percentages are relative to the fitted
  // picture, and object-contain already does the fitting per pane and per
  // mode. Converting a percentage into a scale needed the media's size and
  // its pane's; nothing does now.

  // Screen-space clips, one per pane, so everything inside a pane (video,
  // annotation overlay, drawing canvas) is clipped together.
  const clipA = isWipe ? { clipPath: `inset(0 ${100 - split}% 0 0)` } : undefined
  const clipB = isWipe ? { clipPath: `inset(0 0 0 ${split}%)` } : undefined

  const audioButton = (side: 'a' | 'b', badge: string) => (
    <button
      type="button"
      aria-label={audioSide === side ? `Mute ${badge}` : `Unmute ${badge}`}
      onClick={(e) => {
        e.stopPropagation()
        onAudioSideChange(audioSide === side ? 'none' : side)
      }}
      className="flex h-7 w-7 items-center justify-center rounded bg-black/40 text-white/80 transition-colors hover:text-white"
    >
      {audioSide === side ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
    </button>
  )

  return (
    <div
      ref={stageRef}
      data-testid={isWipe ? 'wipe-stage' : 'sbs-stage'}
      className={
        isWipe
          ? 'relative min-h-0 flex-1 overflow-hidden bg-black select-none'
          // `relative` in BOTH layouts: the corner chrome below is absolutely
          // positioned against this element, and without it sbs would anchor
          // the badges to whatever ancestor happened to be positioned.
          : 'relative flex min-h-0 flex-1 bg-black'
      }
    >
      <ComparePane
        isWipe={isWipe}
        clip={clipA}
        transform={transform}
        chrome={errA ? <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeA}</span> : null}
      >
        {/* Exclusive unmute: audioSide names the (at most one) audible side. */}
        <video ref={videoRefA} data-testid="wipe-video-a" className={COMPARE_MEDIA_CLASS} playsInline preload="metadata" muted={audioSide !== 'a'} />
        {/* Drawings are AUTHORED inside VideoFrameConstraint on the normal
            player (video-frame coordinates, letterbox excluded) — displayed
            in the same space here. */}
        <VideoFrameConstraint videoRef={videoRefA}>{paneOverlayA}</VideoFrameConstraint>
      </ComparePane>

      {/* The static seam between the two halves. sbs only — in wipe the
          draggable divider below is the boundary. */}
      {!isWipe && <div className="w-px bg-border" />}

      <ComparePane
        isWipe={isWipe}
        clip={clipB}
        transform={transform}
        chrome={errB ? <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeB}</span> : null}
      >
        <video ref={videoRefB} data-testid="wipe-video-b" className={COMPARE_MEDIA_CLASS} playsInline preload="metadata" muted={audioSide !== 'b'} />
        <VideoFrameConstraint videoRef={videoRefB}>{paneOverlayB}</VideoFrameConstraint>
      </ComparePane>

      {isWipe && <WipeDivider split={split} onPointerDown={onDividerDown} />}

      {/* Corner chrome. Pinned to the STAGE in both layouts: in sbs the panes
          are exact halves, so the stage's corners are also the outer corners
          of pane A and pane B — the same place the per-pane version of this
          used to sit. */}
      <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
        <span className="rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeA}</span>
        {audioButton('a', badgeA)}
      </div>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
        {audioButton('b', badgeB)}
        <span className="rounded bg-emerald-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeB}</span>
      </div>
    </div>
  )
}
