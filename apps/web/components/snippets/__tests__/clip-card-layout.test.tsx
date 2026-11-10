/**
 * The clip card's layout: the title row heads the card (above the player and
 * the transcript once opened), the 3-dot menu with "Hide source file" is gone,
 * renaming still works where it did, and the review buttons share the export
 * buttons' row without being remounted when the card opens or closes.
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
import { ClipCard, type ClipCardProps } from '../clip-card'

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
  quality_score: null,
  viral_score: null,
  source: null,
  generator: null,
  status: 'suggested',
  user_edited: false,
  stream_url: 'https://example.test/master.m3u8',
  // A picture, so the export buttons show.
  thumbnail_url: 'https://example.test/thumb.jpg',
} as SnippetClip

/** Holds the open key the way the page does. */
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

const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

beforeEach(() => {
  vi.mocked(snippetApi.patchSnippet).mockReset()
})

describe('ClipCard header', () => {
  it('puts the title, rename and toggle in a header above the player and the transcript once opened', () => {
    render(<Harness initiallyOpen />)
    const header = screen.getByTestId('clip-header')
    const toggle = within(header).getByRole('button', { name: 'Collapse clip' })
    expect(within(header).getByRole('button', { name: 'A clip' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Rename clip' })).toBeInTheDocument()
    // The toggle ends the row (top right).
    expect(header.lastElementChild).toBe(toggle)

    const play = screen.getByRole('button', { name: 'Play A clip from interview.mov' })
    const transcript = screen.getByRole('complementary', { name: 'Transcript' })
    expect(follows(header, play)).toBe(true)
    expect(follows(header, transcript)).toBe(true)
    // First thing in the card's grid, spanning both columns.
    expect(header.parentElement?.firstElementChild).toBe(header)
    expect(header.className).toMatch(/\bcol-span-full\b/)
  })

  it('keeps the same header element, with the toggle at its end, when the card closes', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen />)
    const header = screen.getByTestId('clip-header')
    await user.click(within(header).getByRole('button', { name: 'Collapse clip' }))
    expect(screen.getByTestId('clip-header')).toBe(header)
    expect(header.lastElementChild).toBe(screen.getByRole('button', { name: 'Expand clip' }))
    expect(screen.queryByRole('complementary', { name: 'Transcript' })).toBeNull()
  })
})

describe('ClipCard 3-dot menu', () => {
  it.each([false, true])('has no "Hide source file" and no 3-dot button (opened: %s)', (initiallyOpen) => {
    // The page still passes the owner's handler; the card no longer offers it.
    const onHideSource = vi.fn()
    render(<Harness initiallyOpen={initiallyOpen} onHideSource={onHideSource} />)
    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull()
    expect(screen.queryByText('Hide source file')).toBeNull()
    expect(onHideSource).not.toHaveBeenCalled()
  })
})

describe('ClipCard rename', () => {
  it('renames from the header of the opened card and saves the new title', async () => {
    const user = userEvent.setup()
    vi.mocked(snippetApi.patchSnippet).mockImplementation(async (_id, patch) => ({ ...base, ...patch }) as SnippetClip)
    render(<Harness initiallyOpen />)
    const header = screen.getByTestId('clip-header')

    await user.click(within(header).getByRole('button', { name: 'Rename clip' }))
    const input = within(header).getByRole('textbox', { name: 'Clip title' })
    // While editing, the field replaces the title and the rename button.
    expect(within(header).queryByRole('button', { name: 'Rename clip' })).toBeNull()
    await user.clear(input)
    await user.type(input, 'Better title{Enter}')

    expect(snippetApi.patchSnippet).toHaveBeenCalledWith('snip-1', { title: 'Better title' })
    // Focus goes back to the title, which shows the new one.
    expect(within(header).getByRole('button', { name: 'Better title' })).toHaveFocus()
  })

  it('Escape cancels without saving', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen />)
    await user.click(screen.getByRole('button', { name: 'Rename clip' }))
    await user.type(screen.getByRole('textbox', { name: 'Clip title' }), 'x{Escape}')
    expect(snippetApi.patchSnippet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'A clip' })).toBeInTheDocument()
  })

  it.each([
    ['a viewer', { canEdit: false }, base],
    ['a transcript moment', {}, { ...base, kind: 'moment', title: null, status: null } as SnippetClip],
  ])('is not offered to %s', (_who, props, clip) => {
    render(<Harness initiallyOpen clip={clip} {...props} />)
    expect(screen.queryByRole('button', { name: 'Rename clip' })).toBeNull()
  })
})

describe('ClipCard export and review row', () => {
  it('shows "EXPORT · in – out" on one line and the review buttons in the format buttons’ row, right-aligned', () => {
    render(<Harness initiallyOpen />)
    expect(screen.getByTestId('export-heading')).toHaveTextContent(/^Export·0:01\.0 – 0:09\.0$/)

    const row = screen.getByTestId('export-row')
    const r = within(row)
    for (const name of ['Export 9:16', 'Export 16:9', 'Approve', 'Reject']) {
      expect(r.getByRole('button', { name })).toBeInTheDocument()
    }
    // Exports first, the review group last and pushed right.
    const review = r.getByRole('button', { name: 'Approve' }).parentElement!
    expect(row.lastElementChild).toBe(review)
    expect(review.className).toMatch(/\bml-auto\b/)
    expect(follows(r.getByRole('button', { name: 'Export 16:9' }), review)).toBe(true)
  })

  it('keeps the same approve and reject buttons when the card opens and closes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const approve = screen.getByRole('button', { name: 'Approve' })
    const reject = screen.getByRole('button', { name: 'Reject' })
    expect(within(screen.getByTestId('export-row')).getByRole('button', { name: 'Approve' })).toBe(approve)

    await user.click(screen.getByRole('button', { name: 'Expand clip' }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBe(approve)
    expect(within(screen.getByTestId('export-row')).getByRole('button', { name: 'Reject' })).toBe(reject)
  })

  it('approve still toggles and reports its state', async () => {
    const user = userEvent.setup()
    vi.mocked(snippetApi.patchSnippet).mockImplementation(async (_id, patch) => ({ ...base, ...patch }) as SnippetClip)
    render(<Harness initiallyOpen />)
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toHaveAttribute('aria-pressed', 'false')
    await user.click(approve)
    expect(approve).toHaveAttribute('aria-pressed', 'true')
    expect(approve).toHaveAttribute('aria-label', 'Undo approve')
  })

  it('a viewer gets neither exports nor review buttons', () => {
    render(<Harness initiallyOpen canEdit={false} />)
    expect(screen.queryByTestId('export-row')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('without a picture the review buttons stay beside the audio note', () => {
    render(<Harness initiallyOpen clip={{ ...base, thumbnail_url: null }} />)
    expect(screen.getByTestId('export-audio-note')).toBeInTheDocument()
    expect(screen.queryByTestId('export-row')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })
})
