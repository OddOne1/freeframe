/**
 * The two compare videos survive a mode switch (CLAUDE.md §109).
 *
 * Wipe and side-by-side were two mutually-exclusive JSX subtrees, each with
 * its own <video>. Passing the same ref object to both does nothing to stop
 * React unmounting one DOM node and mounting another when the branch flips.
 * The consequences were all downstream of that single fact:
 *
 *   - use-video-player attaches HLS / sets src in an effect keyed on `src`,
 *     not on the element's identity, so the replacement element got neither
 *     and sat dead until a version switch happened to change `src` — the
 *     "only loads after switching versions" symptom.
 *   - currentTime lives on the DOM node, so playback position went with it.
 *
 * Node IDENTITY across the switch is therefore the thing worth asserting.
 * "A video exists in both modes" would pass against the bug.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CompareVideoStage } from '../compare-video-stage'

const refA = { current: null as HTMLVideoElement | null }
const refB = { current: null as HTMLVideoElement | null }

function stage(mode: 'wipe' | 'sbs') {
  return (
    <CompareVideoStage
      mode={mode}
      videoRefA={refA}
      videoRefB={refB}
      badgeA="v1"
      badgeB="v3"
      audioSide="b"
      onAudioSideChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  refA.current = null
  refB.current = null
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

describe('video elements persist across a mode switch', () => {
  it('keeps the SAME DOM nodes going side-by-side -> wipe', () => {
    const { rerender } = render(stage('sbs'))
    const a = screen.getByTestId('wipe-video-a')
    const b = screen.getByTestId('wipe-video-b')

    rerender(stage('wipe'))

    // Identity, not presence. This is the entire bug.
    expect(screen.getByTestId('wipe-video-a')).toBe(a)
    expect(screen.getByTestId('wipe-video-b')).toBe(b)
  })

  it('keeps them going wipe -> side-by-side', () => {
    const { rerender } = render(stage('wipe'))
    const a = screen.getByTestId('wipe-video-a')
    rerender(stage('sbs'))
    expect(screen.getByTestId('wipe-video-a')).toBe(a)
  })

  it('survives repeated toggling', () => {
    // A leak would show up as the ref pointing at a node that is no longer
    // in the document, or as extra <video>s accumulating.
    const { rerender } = render(stage('sbs'))
    const a = screen.getByTestId('wipe-video-a')
    for (let i = 0; i < 8; i++) rerender(stage(i % 2 === 0 ? 'wipe' : 'sbs'))
    expect(screen.getByTestId('wipe-video-a')).toBe(a)
    expect(document.querySelectorAll('video')).toHaveLength(2)
  })

  it('leaves the refs pointing at the live, in-document elements', () => {
    // A stale ref is how the transport ends up driving an orphan: it would
    // set currentTime on a detached node and nothing would move.
    const { rerender } = render(stage('sbs'))
    rerender(stage('wipe'))
    expect(refA.current).toBe(screen.getByTestId('wipe-video-a'))
    expect(refB.current).toBe(screen.getByTestId('wipe-video-b'))
    expect(document.body.contains(refA.current)).toBe(true)
    expect(document.body.contains(refB.current)).toBe(true)
  })

  it('changes only the layout: clip in wipe, none in side-by-side', () => {
    const { rerender } = render(stage('sbs'))
    const paneOf = (id: string) => screen.getByTestId(id).parentElement as HTMLElement
    expect(paneOf('wipe-video-b').style.clipPath).toBe('')
    expect(screen.queryByTestId('wipe-divider')).toBeNull()

    rerender(stage('wipe'))
    // Both panes are clipped, each to its own side, so an annotation inside a
    // pane is clipped by that pane rather than needing its own clip layer.
    expect(paneOf('wipe-video-a').style.clipPath).toBe('inset(0 50% 0 0)')
    expect(paneOf('wipe-video-b').style.clipPath).toBe('inset(0 0 0 50%)')
    expect(screen.getByTestId('wipe-divider')).toBeInTheDocument()
  })

  it('remembers the divider position across a round trip', () => {
    // The split lives in the stage, which no longer unmounts — so going
    // wipe -> sbs -> wipe puts the divider back where the user left it.
    const { rerender } = render(stage('wipe'))
    const divider = screen.getByTestId('wipe-divider')
    expect(divider.dataset.split).toBe('50')
    rerender(stage('sbs'))
    rerender(stage('wipe'))
    expect(screen.getByTestId('wipe-divider').dataset.split).toBe('50')
  })
})
