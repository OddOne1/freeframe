/**
 * The closed clip card's compact layout: two columns (the portrait frame
 * alone on the left, everything else on the right) that stack when the card
 * is narrow, topics on one row with the rest behind "+N", and Reset at the
 * end of the timeline. jsdom has no layout, so the columns are read from the
 * classes that place each part; the real sizes were measured in a browser.
 * The opened card keeps its own layout.
 */
import * as React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetClip } from '@/types'
import { createPlayerGroup } from '@/lib/snippet-card'

vi.mock('@/lib/snippet-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/snippet-api')>()
  return {
    ...actual,
    // The opened card asks for its transcript; it never needs to arrive here.
    snippetFetcher: () => new Promise(() => {}),
    snippetApi: { ...actual.snippetApi, patchSnippet: vi.fn(), transcript: vi.fn(), createExport: vi.fn() },
  }
})

import { snippetApi } from '@/lib/snippet-api'
import { COLLAPSED_TOPICS, ClipCard, type ClipCardProps } from '../clip-card'

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
  viral_score: null,
  source: 'import',
  generator: null,
  status: 'suggested',
  user_edited: true,
  stream_url: 'https://example.test/master.m3u8',
  thumbnail_url: 'https://example.test/thumb.jpg',
} as SnippetClip

const FIVE_TOPICS = ['climate', 'expedition', 'glacier', 'science', 'funding']

function Harness({
  clip = base,
  initiallyOpen = false,
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
const topicNames = () =>
  within(screen.getByTestId('clip-topics'))
    .getAllByRole('button', { pressed: false })
    .map((b) => b.textContent)

beforeEach(() => {
  vi.mocked(snippetApi.patchSnippet).mockReset()
})

describe('closed card layout', () => {
  it('is a container of its own, so its layout follows the card’s width', () => {
    render(<Harness />)
    const card = screen.getByRole('article', { name: 'A clip' })
    expect(classes(card)).toEqual(expect.arrayContaining(['[container-name:clip-card]', '[container-type:inline-size]']))
  })

  it('puts the portrait frame alone in the left column and everything else in the right one', () => {
    render(<Harness />)
    const layout = screen.getByTestId('clip-layout')
    expect(classes(layout)).toContain('clip-wide:grid-cols-[12.5rem_minmax(0,1fr)]')

    // Left column: the 9:16 frame, across all three rows.
    const thumb = screen.getByTestId('clip-thumb')
    expect(classes(thumb)).toEqual(
      expect.arrayContaining(['aspect-[9/16]', 'max-w-[12.5rem]', 'clip-wide:col-start-1', 'clip-wide:row-span-3']),
    )
    expect(within(thumb).getByRole('button', { name: 'Play A clip from interview.mov' })).toBeInTheDocument()

    // Right column: title row, details, controls, top to bottom.
    const header = screen.getByTestId('clip-header')
    const details = screen.getByTestId('clip-details')
    const controls = screen.getByTestId('clip-controls')
    const timeline = screen.getByTestId('clip-timeline')
    expect(classes(header)).toEqual(expect.arrayContaining(['clip-wide:col-start-2', 'clip-wide:row-start-1']))
    expect(classes(details)).toEqual(expect.arrayContaining(['clip-wide:col-start-2', 'clip-wide:row-start-2']))
    expect(classes(controls)).toEqual(
      expect.arrayContaining(['clip-wide:col-start-2', 'clip-wide:row-start-3', 'clip-wide:self-end']),
    )
    // Everything but the frame and the timeline is in the right column.
    for (const part of Array.from(layout.children)) {
      if (part === thumb || part === timeline) continue
      expect(classes(part)).toContain('clip-wide:col-start-2')
    }
    // The timeline: a row of its own under both columns, the full width of the card.
    expect(classes(layout)).toContain('clip-wide:grid-rows-[auto_auto_1fr_auto]')
    expect(classes(timeline)).toEqual(expect.arrayContaining(['row-start-4', 'clip-wide:col-span-2']))
    expect(timeline.className).not.toMatch(/col-start/)
    expect(within(timeline).getByRole('slider', { name: 'In point' })).toBeInTheDocument()
    expect(within(timeline).getByRole('slider', { name: 'Out point' })).toBeInTheDocument()

    // What the right column holds.
    expect(within(header).getByRole('button', { name: 'A clip' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Rename clip' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Expand clip' })).toBeInTheDocument()
    expect(within(details).getByText(/Something said\./)).toBeInTheDocument()
    expect(within(controls).getByRole('textbox', { name: /^In point/ })).toBeInTheDocument()
    expect(within(controls).getByRole('button', { name: 'Export 9:16' })).toBeInTheDocument()
    expect(within(controls).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('stacks below the container width: the frame on top, centred, then the title, details, timeline and controls', () => {
    render(<Harness />)
    // Without `clip-wide:`, one column in this row order.
    expect(classes(screen.getByTestId('clip-layout'))).toContain('grid-cols-1')
    expect(classes(screen.getByTestId('clip-thumb'))).toEqual(expect.arrayContaining(['row-start-1', 'mx-auto']))
    expect(classes(screen.getByTestId('clip-header'))).toContain('row-start-2')
    expect(classes(screen.getByTestId('clip-details'))).toContain('row-start-3')
    expect(classes(screen.getByTestId('clip-timeline'))).toContain('row-start-4')
    expect(classes(screen.getByTestId('clip-controls'))).toContain('row-start-5')
  })

  it('clamps the title to two lines and the quote to three, in small type', () => {
    render(<Harness />)
    expect(classes(screen.getByRole('button', { name: 'A clip' }))).toContain('line-clamp-2')
    expect(classes(screen.getByRole('heading', { name: 'A clip' }))).not.toContain('sm:text-base')
    const quote = screen.getByText(/Something said\./)
    expect(classes(quote)).toEqual(expect.arrayContaining(['line-clamp-3', 'text-xs']))
  })

  it('keeps the badges on one row', () => {
    render(<Harness />)
    const badges = screen.getByTestId('clip-badges')
    expect(classes(badges)).toContain('flex-nowrap')
    expect(badges).toHaveTextContent('imported')
    expect(badges).toHaveTextContent('Q80')
    expect(badges).toHaveTextContent('edited')
  })

  it('gives the header and review buttons 32 px targets', () => {
    render(<Harness />)
    for (const name of ['Rename clip', 'Expand clip', 'Approve', 'Reject', 'Reset in and out']) {
      expect(classes(screen.getByRole('button', { name }))).toEqual(expect.arrayContaining(['h-8', 'w-8']))
    }
  })

  it('puts Reset at the end of the full-width timeline and In and Out on one row in the text column', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const reset = screen.getByRole('button', { name: 'Reset in and out' })
    const slider = screen.getByRole('slider', { name: 'In point' })
    // Same row as the timeline: the timeline's wrapper and Reset are siblings.
    expect(reset.parentElement).toBe(slider.closest('[data-testid=clip-timeline] > div'))
    const inout = screen.getByTestId('clip-inout')
    expect(within(inout).getByRole('textbox', { name: /^In point/ })).toBeInTheDocument()
    expect(within(inout).getByRole('textbox', { name: /^Out point/ })).toBeInTheDocument()
    expect(within(inout).queryByRole('button', { name: /Reset/ })).toBeNull()

    // It still resets.
    expect(reset).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'In plus 0.1 seconds' }))
    expect(screen.getByRole('textbox', { name: /^In point/ })).toHaveValue('0:01.1')
    expect(reset).toBeEnabled()
    await user.click(reset)
    expect(screen.getByRole('textbox', { name: /^In point/ })).toHaveValue('0:01.0')
    expect(reset).toBeDisabled()
  })
})

describe('closed card topics', () => {
  it(`shows the first ${COLLAPSED_TOPICS} on one row and the rest behind "+N"`, () => {
    render(<Harness clip={{ ...base, topics: FIVE_TOPICS }} />)
    const list = screen.getByTestId('clip-topics')
    expect(classes(list)).toContain('flex-nowrap')
    expect(topicNames()).toEqual(FIVE_TOPICS.slice(0, COLLAPSED_TOPICS))
    const more = screen.getByRole('button', { name: '+2 more topics' })
    expect(more).toHaveTextContent('+2')
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('"+N" shows all of them, and the same button folds them again', async () => {
    const user = userEvent.setup()
    render(<Harness clip={{ ...base, topics: FIVE_TOPICS }} />)
    const more = screen.getByRole('button', { name: '+2 more topics' })

    await user.click(more)
    expect(topicNames()).toEqual(FIVE_TOPICS)
    expect(more).toHaveTextContent('Fewer')
    expect(more).toHaveAccessibleName('Show fewer topics')
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(more).toHaveFocus()

    await user.click(more)
    expect(topicNames()).toEqual(FIVE_TOPICS.slice(0, COLLAPSED_TOPICS))
    expect(more).toHaveFocus()
  })

  it('the shown chips still filter and remove', async () => {
    const user = userEvent.setup()
    const onTopic = vi.fn()
    render(<Harness clip={{ ...base, topics: FIVE_TOPICS }} onTopic={onTopic} />)
    await user.click(screen.getByRole('button', { name: 'climate' }))
    expect(onTopic).toHaveBeenCalledWith('climate')

    await user.click(screen.getByRole('button', { name: 'Remove topic climate' }))
    // One fewer: the next one moves up and "+N" counts one less.
    expect(topicNames()).toEqual(['expedition', 'glacier', 'science'])
    expect(screen.getByRole('button', { name: '+1 more topics' })).toBeInTheDocument()
  })

  it('has no "+N" when every topic fits', () => {
    render(<Harness clip={{ ...base, topics: FIVE_TOPICS.slice(0, COLLAPSED_TOPICS) }} />)
    expect(topicNames()).toEqual(FIVE_TOPICS.slice(0, COLLAPSED_TOPICS))
    expect(screen.queryByTestId('clip-topics-more')).toBeNull()
  })

  it('the opened card lists every topic and has no "+N"', () => {
    render(<Harness initiallyOpen clip={{ ...base, topics: FIVE_TOPICS }} />)
    expect(topicNames()).toEqual(FIVE_TOPICS)
    expect(screen.queryByTestId('clip-topics-more')).toBeNull()
  })
})

describe('opened card', () => {
  it('keeps its own layout: none of the closed card’s columns', () => {
    render(<Harness initiallyOpen />)
    const layout = screen.getByTestId('clip-layout')
    expect(classes(layout)).toEqual(expect.arrayContaining(['lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]', 'sm:p-4']))
    expect(classes(screen.getByTestId('clip-thumb'))).toContain('aspect-video')
    expect(classes(screen.getByTestId('clip-header'))).toContain('col-span-full')
    for (const id of ['clip-layout', 'clip-thumb', 'clip-header', 'clip-details', 'clip-timeline', 'clip-controls']) {
      expect(screen.getByTestId(id).className).not.toMatch(/clip-wide:/)
    }
    // Reset is in the play row there, with its word, not at the end of the timeline.
    expect(screen.queryByRole('button', { name: 'Reset in and out' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument()
  })
})
