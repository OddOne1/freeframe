/**
 * The opened clip card's layout: the status line ends the speaker row,
 * right-aligned; the Out trim group is the mirror image of the In group; and
 * the labels under the timeline show the selected In and Out, follow the
 * handles and the nudges, and never overlap.
 */
import * as React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetClip } from '@/types'
import { createPlayerGroup } from '@/lib/snippet-card'

vi.mock('@/lib/snippet-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/snippet-api')>()
  return {
    ...actual,
    snippetFetcher: () => new Promise(() => {}),
    snippetApi: { ...actual.snippetApi, patchSnippet: vi.fn(), transcript: vi.fn(), createExport: vi.fn() },
  }
})

import { snippetApi } from '@/lib/snippet-api'
import { ClipCard, type ClipCardProps } from '../clip-card'
import { EDGE_LABEL_GAP, placeEdgeLabels } from '../clip-player'

const base: SnippetClip = {
  id: 'snip-1',
  kind: 'snippet',
  asset_id: 'asset-1',
  asset_name: 'interview.mov',
  media_file_id: 'mf-1',
  speaker: null,
  start_ms: 1000,
  end_ms: 9000,
  duration_ms: 8000,
  title: 'A clip',
  quote: 'Something said.',
  topics: [],
  quality_score: 0.8,
  viral_score: 0.6,
  source: 'import',
  generator: null,
  status: 'suggested',
  user_edited: true,
  stream_url: 'https://example.test/master.m3u8',
  thumbnail_url: 'https://example.test/thumb.jpg',
} as SnippetClip

function Harness({
  clip = base,
  initiallyOpen = true,
  ...rest
}: { clip?: SnippetClip; initiallyOpen?: boolean } & Partial<ClipCardProps>) {
  const [open, setOpen] = React.useState<string | null>(initiallyOpen ? 'k1' : null)
  const [group] = React.useState(createPlayerGroup)
  return (
    <ClipCard
      cardKey="k1"
      clip={clip}
      projectId="p1"
      canEdit
      speakers={[]}
      activeTopics={[]}
      active={false}
      expanded={open === 'k1'}
      group={group}
      onTopic={() => {}}
      onToggleExpand={(k) => setOpen((cur) => (cur === k ? null : k))}
      onSaved={() => {}}
      onTracksChanged={() => {}}
      register={() => () => {}}
      {...rest}
    />
  )
}

const classes = (el: Element) => el.className.split(/\s+/)
const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

/** The parts of a trim group in document order: label, field, then each nudge by its text. */
function parts(group: HTMLElement): string[] {
  return Array.from(group.querySelectorAll<HTMLElement>('[data-edge-label], input, button')).map((el) =>
    el.hasAttribute('data-edge-label') ? 'label' : el.tagName === 'INPUT' ? 'field' : (el.textContent ?? ''),
  )
}

const inLabel = () => screen.getByTestId('timeline-in-label')
const outLabel = () => screen.getByTestId('timeline-out-label')
const leftPx = (el: HTMLElement) => {
  const m = /^(-?[\d.]+)px$/.exec(el.style.left)
  if (!m) throw new Error(`label not placed in px: "${el.style.left}"`)
  return Number(m[1])
}

beforeEach(() => {
  vi.mocked(snippetApi.patchSnippet).mockReset().mockImplementation(async (_id, patch) => ({ ...base, ...patch }) as SnippetClip)
})

describe('status line on the speaker row', () => {
  it('ends the speaker row, right-aligned, after the speaker, the file and the in-time', () => {
    render(<Harness />)
    const row = screen.getByTestId('clip-speaker-row')
    const who = within(row).getByTestId('clip-who')
    const status = within(row).getByTestId('clip-badges')
    // One status line on the opened card, the last thing on the row.
    expect(screen.getAllByTestId('clip-badges')).toHaveLength(1)
    expect(row.lastElementChild).toBe(status)
    expect(follows(who, status)).toBe(true)
    expect(who).toHaveTextContent('interview.mov')
    expect(who).toHaveTextContent('0:01.0')
    expect(within(who).getByRole('combobox', { name: /Speaker of A clip/ })).toBeInTheDocument()
    // Everything the status line held before.
    expect(status).toHaveTextContent('Suggested')
    expect(status).toHaveTextContent('imported')
    expect(status).toHaveTextContent('Q80')
    expect(status).toHaveTextContent('V60')
    expect(status).toHaveTextContent('edited')
    // Right-aligned on the row.
    expect(classes(status)).toEqual(expect.arrayContaining(['ml-auto', 'justify-end']))
  })

  it('wraps below the speaker instead of overlapping it when the row is narrow', () => {
    render(<Harness />)
    const row = screen.getByTestId('clip-speaker-row')
    // A wrapping row whose speaker part keeps a real width: when both do not
    // fit, the status line moves to the next line rather than shrinking over it.
    expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']))
    expect(classes(screen.getByTestId('clip-who'))).toContain('flex-[1_1_16rem]')
    expect(classes(screen.getByTestId('clip-badges'))).toContain('max-w-full')
  })

  it('leaves the closed card as it was: badges on their own row, not on the speaker row', async () => {
    render(<Harness initiallyOpen={false} />)
    const row = screen.getByTestId('clip-speaker-row')
    const badges = screen.getByTestId('clip-badges')
    expect(row).not.toContainElement(badges)
    expect(classes(row)).not.toContain('flex')
    expect(badges).not.toHaveTextContent('imported')
    expect(badges).toHaveTextContent('V60')
    // Opening moves the line onto the row; closing moves it back.
    await userEvent.click(screen.getByRole('button', { name: 'Expand clip' }))
    expect(screen.getByTestId('clip-speaker-row')).toContainElement(screen.getByTestId('clip-badges'))
    await userEvent.click(screen.getByRole('button', { name: 'Collapse clip' }))
    expect(screen.getByTestId('clip-speaker-row')).not.toContainElement(screen.getByTestId('clip-badges'))
  })
})

describe('In and Out trim groups', () => {
  it('lays Out out as the mirror image of In', () => {
    render(<Harness />)
    const inParts = parts(screen.getByTestId('edge-editor-in'))
    const outParts = parts(screen.getByTestId('edge-editor-out'))
    expect(inParts).toEqual(['label', 'field', '−1s', '−.1', '+.1', '+1s'])
    expect(outParts).toEqual([...inParts].reverse())
    expect(within(screen.getByTestId('edge-editor-out')).getByText('Out')).toBeInTheDocument()
  })

  it('puts In at the left and Out flush at the right of the row under the timeline', () => {
    render(<Harness />)
    const trim = screen.getByTestId('clip-trim')
    expect(classes(trim)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'justify-between']))
    const inGroup = screen.getByTestId('edge-editor-in')
    const outGroup = screen.getByTestId('edge-editor-out')
    expect(trim.firstElementChild).toBe(inGroup)
    expect(trim.lastElementChild).toContainElement(outGroup)
    expect(classes(trim.lastElementChild!)).toContain('ml-auto')
    expect(classes(outGroup)).toContain('justify-end')
  })

  it('keeps what each button does', async () => {
    render(<Harness />)
    const out = within(screen.getByTestId('edge-editor-out'))
    const field = out.getByRole('textbox', { name: /Out point/ })
    await userEvent.click(out.getByRole('button', { name: 'Out plus 1 seconds' }))
    expect(field).toHaveValue('0:10.0')
    await userEvent.click(out.getByRole('button', { name: 'Out minus 0.1 seconds' }))
    expect(field).toHaveValue('0:09.9')
    await userEvent.click(out.getByRole('button', { name: 'Out minus 1 seconds' }))
    expect(field).toHaveValue('0:08.9')
    await userEvent.click(out.getByRole('button', { name: 'Out plus 0.1 seconds' }))
    expect(field).toHaveValue('0:09.0')
  })

  it('leaves the closed card’s inline In/Out row as it was', () => {
    render(<Harness initiallyOpen={false} />)
    expect(screen.queryByTestId('clip-trim')).not.toBeInTheDocument()
    expect(screen.getByTestId('clip-inout')).toBeInTheDocument()
  })
})

describe('time labels under the timeline', () => {
  it('shows the selected In and Out, not the edges of the loaded window', () => {
    render(<Harness />)
    expect(inLabel()).toHaveTextContent('0:01.0')
    expect(outLabel()).toHaveTextContent('0:09.0')
    // The window around 1.0–9.0 s runs 0.0–12.0 s; neither edge is shown.
    const labels = screen.getByTestId('timeline-edge-labels')
    expect(labels).not.toHaveTextContent('0:00.0')
    expect(labels).not.toHaveTextContent('0:12.0')
    expect(labels.children).toHaveLength(2)
  })

  it('follows the nudge buttons and the time boxes', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'In minus 0.1 seconds' }))
    expect(inLabel()).toHaveTextContent('0:00.9')
    await userEvent.click(screen.getByRole('button', { name: 'Out plus 1 seconds' }))
    expect(outLabel()).toHaveTextContent('0:10.0')
    const inField = screen.getByRole('textbox', { name: /In point/ })
    await userEvent.clear(inField)
    await userEvent.type(inField, '2.5{Enter}')
    expect(inLabel()).toHaveTextContent('0:02.5')
  })

  it('follows the handles, from the keyboard and while dragging', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 40,
      width: 400,
      height: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    try {
      render(<Harness />)
      const inHandle = screen.getByRole('slider', { name: 'In point' })
      inHandle.focus()
      await userEvent.keyboard('{ArrowRight}')
      expect(inLabel()).toHaveTextContent('0:01.1')

      // The window is 0–12 s over 400 px: x = 200 is 6.0 s.
      const outHandle = screen.getByRole('slider', { name: 'Out point' })
      fireEvent.pointerDown(outHandle, { pointerId: 1, clientX: 300 })
      fireEvent.pointerMove(outHandle, { pointerId: 1, clientX: 200 })
      expect(outLabel()).toHaveTextContent('0:06.0')
      fireEvent.pointerMove(outHandle, { pointerId: 1, clientX: 250 })
      expect(outLabel()).toHaveTextContent('0:07.5')
      fireEvent.pointerUp(outHandle, { pointerId: 1, clientX: 250 })
      expect(outLabel()).toHaveTextContent('0:07.5')
    } finally {
      rect.mockRestore()
    }
  })

  describe('placed in px once measured', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const WIDTH = 400
    // Wide enough that a 1 s clip (the shortest there is, about 57 px here)
    // puts the two labels in each other's way.
    const LABEL = 60
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement) {
          const id = this.getAttribute('data-testid')
          if (id === 'timeline-edge-labels') return WIDTH
          if (id === 'timeline-in-label' || id === 'timeline-out-label') return LABEL
          return 0
        },
      })
    })
    afterEach(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original)
    })

    it('centres each label under its handle', () => {
      render(<Harness />)
      // Window 0–12 s over 400 px: In 1.0 s at 33.3 px, Out 9.0 s at 300 px.
      expect(leftPx(inLabel())).toBeCloseTo(400 / 12 - LABEL / 2, 1)
      expect(leftPx(outLabel())).toBeCloseTo(300 - LABEL / 2, 1)
    })

    it('keeps them apart and inside the timeline when the handles are close', () => {
      // A 1 s clip: window 2–9 s, the handles 57 px apart, less than a label and the gap.
      render(<Harness clip={{ ...base, start_ms: 5000, end_ms: 6000, duration_ms: 1000 }} />)
      const a = leftPx(inLabel())
      const b = leftPx(outLabel())
      expect(b).toBeGreaterThanOrEqual(a + LABEL + EDGE_LABEL_GAP)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(b + LABEL).toBeLessThanOrEqual(WIDTH)
      expect(inLabel()).toHaveTextContent('0:05.0')
      expect(outLabel()).toHaveTextContent('0:06.0')
    })

    it('keeps them apart after a nudge brings the handles together', async () => {
      // 2 s apart: 100 px, the labels sit under their handles.
      render(<Harness clip={{ ...base, start_ms: 5000, end_ms: 7000, duration_ms: 2000 }} />)
      const before = leftPx(outLabel())
      expect(before).toBeGreaterThanOrEqual(leftPx(inLabel()) + LABEL + EDGE_LABEL_GAP)
      await userEvent.click(screen.getByRole('button', { name: 'Out minus 1 seconds' }))
      expect(outLabel()).toHaveTextContent('0:06.0')
      expect(leftPx(outLabel())).toBeGreaterThanOrEqual(leftPx(inLabel()) + LABEL + EDGE_LABEL_GAP)
      expect(leftPx(outLabel()) + LABEL).toBeLessThanOrEqual(WIDTH)
    })

    it('keeps them apart while a drag pulls Out right up to In', () => {
      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        right: WIDTH,
        bottom: 40,
        width: WIDTH,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
      try {
        // A long clip, 0–60 s: the window (0–81 s) stays frozen during the
        // drag, so Out can land a few px from In.
        render(<Harness clip={{ ...base, start_ms: 0, end_ms: 60_000, duration_ms: 60_000 }} />)
        const outHandle = screen.getByRole('slider', { name: 'Out point' })
        fireEvent.pointerDown(outHandle, { pointerId: 1, clientX: 296 })
        fireEvent.pointerMove(outHandle, { pointerId: 1, clientX: 2 })
        expect(outLabel()).toHaveTextContent('0:01.0')
        const a = leftPx(inLabel())
        const b = leftPx(outLabel())
        expect(a).toBe(0)
        expect(b).toBeGreaterThanOrEqual(a + LABEL + EDGE_LABEL_GAP)
        fireEvent.pointerUp(outHandle, { pointerId: 1, clientX: 2 })
      } finally {
        rect.mockRestore()
      }
    })
  })
})

describe('placeEdgeLabels', () => {
  const W = 400
  const w = 40

  it('centres labels under handles that are far apart', () => {
    expect(placeEdgeLabels({ inX: 100, outX: 300, inW: w, outW: w, width: W })).toEqual({ inLeft: 80, outLeft: 280 })
  })

  it('clamps labels inside the timeline at both ends', () => {
    expect(placeEdgeLabels({ inX: 0, outX: W, inW: w, outW: w, width: W })).toEqual({ inLeft: 0, outLeft: W - w })
  })

  it('pushes close labels apart around the handles’ midpoint', () => {
    const { inLeft, outLeft } = placeEdgeLabels({ inX: 200, outX: 204, inW: w, outW: w, width: W })
    expect(outLeft - inLeft).toBe(w + EDGE_LABEL_GAP)
    expect((inLeft + outLeft + w) / 2).toBeCloseTo(202, 5)
  })

  it('never overlaps and stays inside the timeline wherever the handles are', () => {
    for (let inX = 0; inX <= W; inX += 7) {
      for (let outX = inX; outX <= W; outX += 11) {
        const { inLeft, outLeft } = placeEdgeLabels({ inX, outX, inW: w, outW: 48, width: W })
        expect(outLeft).toBeGreaterThanOrEqual(inLeft + w + EDGE_LABEL_GAP - 1e-9)
        expect(inLeft).toBeGreaterThanOrEqual(0)
        expect(outLeft + 48).toBeLessThanOrEqual(W + 1e-9)
      }
    }
  })
})
