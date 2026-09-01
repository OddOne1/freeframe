import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CompareScrubber } from '../compare-scrubber'

const base = {
  t: 10, total: 63, isPlaying: false, fps: 25,
  onToggle: vi.fn(), onSeek: vi.fn(), onMarkerClick: vi.fn(), onOffsetChange: vi.fn(),
  labelA: 'v1', labelB: 'v2', onResetOffsets: vi.fn(),
  markersA: [{ id: 'c1', tc: 10, authorName: 'Maya Chen', body: 'Looks great, nice color grade here', hasAnnotation: false }],
  markersB: [{ id: 'c2', tc: 4, authorName: 'Sam', body: 'Audio is a bit low', hasAnnotation: false }],
  timingA: { offset: 2, duration: 60 }, timingB: { offset: 0, duration: 61 },
}

describe('CompareScrubber', () => {
  it('shows SMPTE timecode for the transport time, signed as elapsed', () => {
    // The readout carries a +/- so the number is never ambiguous about which
    // direction it counts — see the elapsed/remaining tests below.
    render(<CompareScrubber {...base} />)
    expect(screen.getByTestId('timecode-readout').textContent).toContain('+00:00:10:00')
  })

  it('click on the track seeks by ratio', () => {
    render(<CompareScrubber {...base} />)
    const track = screen.getByTestId('compare-track')
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 630, top: 0, height: 8, right: 630, bottom: 8, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    fireEvent.click(track, { clientX: 63 })
    expect(base.onSeek).toHaveBeenCalledWith((63 / 630) * 63)
  })

  it('positions markers at (tc + offset) / total and reports clicks per side', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(a.style.left).toBe(`${((10 + 2) / 63) * 100}%`)
    fireEvent.click(a)
    expect(base.onMarkerClick).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'c1', tc: 10 }))
  })

  it('offset steppers nudge by one frame and one second, never below 0', () => {
    render(<CompareScrubber {...base} />)
    fireEvent.click(screen.getByTestId('offA-plus-frame'))
    expect(base.onOffsetChange).toHaveBeenCalledWith('a', 2.04)
    fireEvent.click(screen.getByTestId('offB-minus-second'))
    expect(base.onOffsetChange).toHaveBeenCalledWith('b', 0)
  })

  it('labels the offset rows with the version numbers, not A/B', () => {
    render(<CompareScrubber {...base} />)
    // Scoped to the offset rows: these labels now also appear in the
    // timecode readout, which renders one line PER SIDE whenever the two
    // versions have different runtimes (this fixture's do: 62s vs 61s).
    const offsets = screen.getByTestId('offset-reset').parentElement as HTMLElement
    expect(offsets.textContent).toContain('v1')
    expect(offsets.textContent).toContain('v2')
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  it('reset button re-syncs offsets and disables when both are already 0', () => {
    const onResetOffsets = vi.fn()
    const { rerender } = render(<CompareScrubber {...base} onResetOffsets={onResetOffsets} />)
    const reset = screen.getByTestId('offset-reset')
    expect(reset).not.toBeDisabled() // base has side A offset = 2
    fireEvent.click(reset)
    expect(onResetOffsets).toHaveBeenCalledTimes(1)

    rerender(
      <CompareScrubber
        {...base}
        onResetOffsets={onResetOffsets}
        timingA={{ offset: 0, duration: 60 }}
        timingB={{ offset: 0, duration: 61 }}
      />,
    )
    expect(screen.getByTestId('offset-reset')).toBeDisabled()
  })

  it('shows author initials inside the marker dot', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(a.textContent).toContain('MC')
  })

  it('shows a hover tooltip with author name and body, hidden on mouse leave', () => {
    render(<CompareScrubber {...base} />)
    const a = screen.getByTestId('marker-a-c1')
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument()

    fireEvent.mouseEnter(a)
    expect(screen.getByText('Maya Chen')).toBeInTheDocument()
    expect(screen.getByText(/Looks great/)).toBeInTheDocument()

    fireEvent.mouseLeave(a)
    expect(screen.queryByText('Maya Chen')).not.toBeInTheDocument()
  })
})

describe('elapsed / remaining timecode', () => {
  // Equal runtimes: one number describes both sides.
  const equal = {
    ...base,
    timingA: { offset: 0, duration: 60 },
    timingB: { offset: 0, duration: 60 },
    total: 60,
  }

  it('shows one timecode when both versions run the same length', () => {
    render(<CompareScrubber {...equal} />)
    expect(screen.getByTestId('timecode-single')).toBeInTheDocument()
    expect(screen.queryByTestId('timecode-a')).toBeNull()
  })

  it('toggles elapsed -> remaining on click, and the sign says which', () => {
    // A bare number that silently means something else after a click is what
    // the sign exists to prevent.
    render(<CompareScrubber {...equal} />)
    const readout = screen.getByTestId('timecode-readout')
    expect(readout.textContent).toContain('+00:00:10:00')

    fireEvent.click(readout)
    // 60s total, 10s elapsed -> 50s remaining, counting down.
    expect(readout.textContent).toContain('-00:00:50:00')

    fireEvent.click(readout)
    expect(readout.textContent).toContain('+00:00:10:00')
  })

  it('stacks one timecode per side when the runtimes differ', () => {
    // Remaining is a DIFFERENT amount on each side once the runtimes differ,
    // so a single number cannot describe both.
    render(<CompareScrubber {...base} />)
    expect(screen.getByTestId('timecode-a')).toBeInTheDocument()
    expect(screen.getByTestId('timecode-b')).toBeInTheDocument()
    expect(screen.queryByTestId('timecode-single')).toBeNull()
  })

  it('both stacked lines flip together — the toggle picks the mode, not a side', () => {
    render(<CompareScrubber {...base} />)
    fireEvent.click(screen.getByTestId('timecode-readout'))
    // A ends at 2+60=62 (52 remaining), B at 0+61=61 (51 remaining).
    expect(screen.getByTestId('timecode-a').textContent).toContain('-00:00:52:00')
    expect(screen.getByTestId('timecode-b').textContent).toContain('-00:00:51:00')
  })

  it('never shows negative remaining past a shorter side’s end', () => {
    // The transport runs to the LONGER side's end, so the shorter one is
    // already finished — "-00:00:03:00 remaining" on a finished clip would be
    // wrong.
    render(<CompareScrubber {...base} t={62} />)
    fireEvent.click(screen.getByTestId('timecode-readout'))
    expect(screen.getByTestId('timecode-b').textContent).toContain('-00:00:00:00')
  })

  it('treats a sub-frame runtime difference as equal', () => {
    // Two exports of one cut can differ by far less than a frame; that is not
    // a runtime difference worth a second readout.
    render(<CompareScrubber {...base}
      timingA={{ offset: 0, duration: 60 }}
      timingB={{ offset: 0, duration: 60.001 }} />)
    expect(screen.getByTestId('timecode-single')).toBeInTheDocument()
  })
})
