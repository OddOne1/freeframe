/**
 * The expand button at the end of a card's title row: the same toggle as the
 * title, for viewers too. It swaps its icon and label with the state, stays
 * the focused element, and neither plays nor saves anything.
 */
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SnippetClip } from '@/types'
import { createPlayerGroup } from '@/lib/snippet-card'

vi.mock('@/lib/snippet-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/snippet-api')>()
  return {
    ...actual,
    // The opened card asks for its transcript; it never needs to arrive here.
    snippetFetcher: () => new Promise(() => {}),
    snippetApi: { ...actual.snippetApi, patchSnippet: vi.fn(), transcript: vi.fn() },
  }
})

import { snippetApi } from '@/lib/snippet-api'
import { ClipCard } from '../clip-card'

const clip: SnippetClip = {
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
  // Audio-only keeps the exports out of this test.
  thumbnail_url: null,
} as SnippetClip

/** Holds the open key the way the page does. */
function Harness({ canEdit, group }: { canEdit: boolean; group: ReturnType<typeof createPlayerGroup> }) {
  const [open, setOpen] = React.useState<string | null>(null)
  return (
    <ClipCard
      cardKey="k1"
      clip={clip}
      projectId="p1"
      canEdit={canEdit}
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
    />
  )
}

describe('ClipCard expand toggle', () => {
  it.each([
    ['viewer', false],
    ['editor', true],
  ])('opens and closes the card for a %s without playing or saving', async (_who, canEdit) => {
    const user = userEvent.setup()
    const group = createPlayerGroup()
    const activate = vi.spyOn(group, 'activate')
    render(<Harness canEdit={canEdit} group={group} />)

    const toggle = screen.getByRole('button', { name: 'Expand clip' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('title', 'Expand with the transcript')
    expect(screen.queryByRole('complementary', { name: 'Transcript' })).toBeNull()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-label', 'Collapse clip')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('title', 'Collapse')
    expect(screen.getByRole('complementary', { name: 'Transcript' })).toBeInTheDocument()
    // The title says the same thing.
    expect(screen.getByRole('button', { name: 'A clip' })).toHaveAttribute('aria-expanded', 'true')
    // One element in both states: focus did not go anywhere.
    expect(toggle).toHaveFocus()

    // Enter on the focused button closes it again.
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-label', 'Expand clip')
    expect(screen.queryByRole('complementary', { name: 'Transcript' })).toBeNull()

    expect(activate).not.toHaveBeenCalled()
    expect(snippetApi.patchSnippet).not.toHaveBeenCalled()
    expect(screen.queryByText('Saving…')).toBeNull()
  })

  it('has no separate Close button any more', async () => {
    const user = userEvent.setup()
    render(<Harness canEdit group={createPlayerGroup()} />)
    await user.click(screen.getByRole('button', { name: 'Expand clip' }))
    expect(screen.queryByRole('button', { name: 'Close clip' })).toBeNull()
  })
})
