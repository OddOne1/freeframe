'use client'

import * as React from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { VideoFrameConstraint } from '@/components/review/video-player'
import { useWipeSplit, WipeDivider } from './use-wipe-split'

interface CompareVideoStageProps {
  mode: 'wipe' | 'sbs'
  /** Shared zoom/pan — ONE transform for both panes (see useSharedTransform). */
  transform?: {
    styleFor(): React.CSSProperties
    onWheel(e: { deltaY: number; preventDefault(): void }): void
    onPointerDown(e: React.PointerEvent): void
    setMediaMetrics(m: { intrinsicWidth: number; intrinsicHeight: number; boxWidth: number; boxHeight: number } | null): void
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
 * Matches the normal player's video sizing exactly (video-player.tsx), and
 * that is the fix for the "video is small / shrinks" report — not a tweak.
 *
 * Compare used `max-h-full max-w-full`, which only ever scales DOWN: the
 * element never exceeds the media's own pixel size. Measured in a browser, a
 * 640x360 source in a 1398px-wide wipe pane rendered at 640px with the rest
 * black, and closing a comments panel widened the pane without the video
 * following — it stops growing at intrinsic size, which reads as "stuck
 * small". `w-full h-full object-contain` fills the pane and letterboxes,
 * scaling in both directions.
 *
 * It also fixes annotation alignment, which was quietly wrong:
 * VideoFrameConstraint computes the contain-box from the PARENT container's
 * size, i.e. it assumes the video fills its parent. Under `max-*` sizing the
 * video was smaller than the parent and centred, so the overlay was measured
 * against a box the video did not occupy. Filling the parent makes that
 * assumption true — the same one it has always been correct under on the
 * normal player, which is where drawings are authored.
 */
const VIDEO_CLASS = 'absolute inset-0 h-full w-full object-contain'

export function CompareVideoStage({
  mode, videoRefA, videoRefB, badgeA, badgeB, transform,
  audioSide, onAudioSideChange, errA, errB, paneOverlayA, paneOverlayB,
}: CompareVideoStageProps) {
  // Lives here, so it survives a mode switch: going sbs -> wipe -> sbs keeps
  // the divider where the user put it.
  const { split, stageRef, onDividerDown } = useWipeSplit()
  const isWipe = mode === 'wipe'

  // Feed the shared transform what it needs to turn a percentage into a
  // scale: the media's own size and the pane it is laid out in. Side A is the
  // reference — the two versions are the same asset and zoom is shared, so
  // one measurement governs both.
  const reportMetrics = transform?.setMediaMetrics
  React.useEffect(() => {
    const v = videoRefA.current
    if (!v || !reportMetrics) return
    const measure = () => {
      const parent = v.parentElement
      if (!parent) return
      reportMetrics({
        intrinsicWidth: v.videoWidth,
        intrinsicHeight: v.videoHeight,
        boxWidth: parent.clientWidth,
        boxHeight: parent.clientHeight,
      })
    }
    measure()
    v.addEventListener('loadedmetadata', measure)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (v.parentElement) ro?.observe(v.parentElement)
    return () => { v.removeEventListener('loadedmetadata', measure); ro?.disconnect() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- videoRefA is a
    // ref: stable by contract, and listing it makes this effect re-run on any
    // render where a caller hands over a fresh ref object.
  }, [reportMetrics])

  const paneClass = isWipe
    ? 'absolute inset-0 flex items-center justify-center'
    : 'relative flex min-w-0 flex-1 items-center justify-center bg-black'

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
      <div className={paneClass} style={clipA} onWheel={transform?.onWheel} onPointerDown={transform?.onPointerDown}>
        {/* The zoom transform is applied INSIDE the pane, so the pane's
            clip stays in screen space and the divider keeps matching the
            visible split however far the media is zoomed or panned. */}
        <div className="absolute inset-0" style={transform?.styleFor()}>
        {/* Exclusive unmute: audioSide names the (at most one) audible side. */}
        <video ref={videoRefA} data-testid="wipe-video-a" className={VIDEO_CLASS} playsInline preload="metadata" muted={audioSide !== 'a'} />
        {/* Drawings are AUTHORED inside VideoFrameConstraint on the normal
            player (video-frame coordinates, letterbox excluded) — displayed
            in the same space here. */}
        <VideoFrameConstraint videoRef={videoRefA}>{paneOverlayA}</VideoFrameConstraint>
        </div>
        {errA && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeA}</span>}
      </div>

      {/* The static seam between the two halves. sbs only — in wipe the
          draggable divider below is the boundary. */}
      {!isWipe && <div className="w-px bg-border" />}

      <div className={paneClass} style={clipB} onWheel={transform?.onWheel} onPointerDown={transform?.onPointerDown}>
        {/* The zoom transform is applied INSIDE the pane, so the pane's
            clip stays in screen space and the divider keeps matching the
            visible split however far the media is zoomed or panned. */}
        <div className="absolute inset-0" style={transform?.styleFor()}>
        <video ref={videoRefB} data-testid="wipe-video-b" className={VIDEO_CLASS} playsInline preload="metadata" muted={audioSide !== 'b'} />
        <VideoFrameConstraint videoRef={videoRefB}>{paneOverlayB}</VideoFrameConstraint>
        </div>
        {errB && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeB}</span>}
      </div>

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
