/**
 * Renaming a clip in place. Clicking the title (or the pencil) starts
 * editing for those who may edit; the pencil stays and turns into a check.
 * Enter or the check saves; Escape or clicking anywhere else puts the old
 * title back. While the field is open no shortcut fires and no key reaches
 * the page. The title no longer opens or closes the card.
 */
import * as React from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnippetClip } from '@/types'
import { createPlayerGroup, shortcutFor, targetKind } from '@/lib/snippet-card'

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
import { ClipCard, type ClipCardController, type ClipCardProps } from '../clip-card'

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
  thumbnail_url: 'https://example.test/thumb.jpg',
} as SnippetClip

/** Holds the open key and wires the keyboard the way the page does. */
function Harness({
  initiallyOpen = false,
  onToggle,
  ...rest
}: { initiallyOpen?: boolean; onToggle?: (k: string) => void } & Partial<ClipCardProps>) {
  const [open, setOpen] = React.useState<string | null>(initiallyOpen ? 'k1' : null)
  const [group] = React.useState(createPlayerGroup)
  const controller = React.useRef<ClipCardController | null>(null)
  React.useEffect(() => {
    // The page's listener (snippets/page.tsx), reduced to this one card.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const action = shortcutFor(e, targetKind(e.target))
      if (action && controller.current?.run(action)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return (
    <div>
      <button type="button">Somewhere else</button>
      <ClipCard
        cardKey="k1"
        clip={base}
        projectId="p1"
        canEdit
        speakers={[]}
        activeTopics={[]}
        active={false}
        expanded={open === 'k1'}
        group={group}
        onTopic={() => {}}
        onToggleExpand={(k) => {
          onToggle?.(k)
          setOpen((cur) => (cur === k ? null : k))
        }}
        onSaved={() => {}}
        onTracksChanged={() => {}}
        register={(_k, c) => {
          controller.current = c
          return () => {
            controller.current = null
          }
        }}
        {...rest}
      />
    </div>
  )
}

const titleButton = () => within(screen.getByRole('heading', { name: 'A clip' })).getByRole('button')
const action = () => screen.getByTestId('clip-title-action')
const field = () => screen.getByRole('textbox', { name: 'Clip title' })
const saved = (title: string) => ({ ...base, title }) as SnippetClip

beforeEach(() => {
  vi.mocked(snippetApi.patchSnippet).mockReset()
  vi.mocked(snippetApi.patchSnippet).mockImplementation(async (_id, patch) => ({ ...base, ...patch }) as SnippetClip)
})

describe.each([
  ['closed', false],
  ['opened', true],
])('title on the %s card', (_state, initiallyOpen) => {
  it('clicking the title does not open or close the card; it starts editing', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<Harness initiallyOpen={initiallyOpen} onToggle={onToggle} />)
    const toggle = screen.getByTestId('clip-expand-toggle')

    await user.click(titleButton())
    expect(onToggle).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-expanded', String(initiallyOpen))
    expect(field()).toHaveValue('A clip')
    expect(field()).toHaveFocus()
  })

  it('the pencil stays, turns into a check, and also starts editing', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen={initiallyOpen} />)
    const button = action()
    expect(button).toHaveAccessibleName('Rename clip')

    await user.click(button)
    expect(field()).toHaveFocus()
    // The same element, still there, now the check.
    expect(action()).toBe(button)
    expect(button).toHaveAccessibleName('Save title')
    expect(screen.getByTestId('clip-title')).toContainElement(button)
  })

  it('Enter saves the new title', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen={initiallyOpen} />)
    await user.click(titleButton())
    await user.clear(field())
    await user.type(field(), 'Better title{Enter}')

    expect(snippetApi.patchSnippet).toHaveBeenCalledTimes(1)
    expect(snippetApi.patchSnippet).toHaveBeenCalledWith('snip-1', { title: 'Better title' })
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(within(screen.getByRole('heading', { name: 'Better title' })).getByRole('button')).toHaveFocus()
    expect(action()).toHaveAccessibleName('Rename clip')
  })

  it('the check saves, and clicking it does not count as clicking away', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen={initiallyOpen} />)
    await user.click(titleButton())
    await user.clear(field())
    await user.type(field(), 'Checked title')
    await user.click(action())

    expect(snippetApi.patchSnippet).toHaveBeenCalledWith('snip-1', { title: 'Checked title' })
    expect(screen.getByRole('heading', { name: 'Checked title' })).toBeInTheDocument()
  })

  it('Escape puts the old title back without saving', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen={initiallyOpen} />)
    await user.click(titleButton())
    await user.type(field(), ' changed{Escape}')

    expect(snippetApi.patchSnippet).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'A clip' })).toBeInTheDocument()
    // Escape only cancelled: the card is still as it was.
    expect(screen.getByTestId('clip-expand-toggle')).toHaveAttribute('aria-expanded', String(initiallyOpen))
  })

  it('clicking anywhere else puts the old title back without saving', async () => {
    const user = userEvent.setup()
    render(<Harness initiallyOpen={initiallyOpen} />)
    await user.click(titleButton())
    await user.type(field(), ' changed')
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' })
    await user.click(elsewhere)

    expect(snippetApi.patchSnippet).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'A clip' })).toBeInTheDocument()
    // Focus stays where the click put it.
    expect(elsewhere).toHaveFocus()
  })
})

describe('keys while the title is being edited', () => {
  it('typing "e" types an e: the card does not open', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<Harness onToggle={onToggle} />)
    await user.click(titleButton())
    await user.type(field(), ' edited e')
    expect(field()).toHaveValue('A clip edited e')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('no key reaches the page, and Escape reaches nothing but the field', async () => {
    const user = userEvent.setup()
    const pageKeys = vi.fn()
    window.addEventListener('keydown', pageKeys)
    try {
      render(<Harness initiallyOpen />)
      await user.click(titleButton())
      pageKeys.mockClear()
      await user.type(field(), 'e i o {Escape}')
      expect(pageKeys).not.toHaveBeenCalled()
      // The card is still open.
      expect(screen.getByTestId('clip-expand-toggle')).toHaveAttribute('aria-expanded', 'true')
    } finally {
      window.removeEventListener('keydown', pageKeys)
    }
  })

  it('the shortcuts work again once editing ends', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<Harness onToggle={onToggle} />)
    await user.click(titleButton())
    await user.keyboard('{Escape}')
    // Focus is back on the title, inside the card: `e` opens it.
    await user.keyboard('e')
    expect(onToggle).toHaveBeenCalledWith('k1')
  })
})

describe('saving the title', () => {
  let resolve: ((c: SnippetClip) => void) | null = null
  let reject: ((e: unknown) => void) | null = null
  beforeEach(() => {
    vi.mocked(snippetApi.patchSnippet).mockImplementation(
      () =>
        new Promise<SnippetClip>((res, rej) => {
          resolve = res
          reject = rej
        }),
    )
  })
  afterEach(() => {
    resolve = null
    reject = null
  })

  it('shows that it is saving until the server answers', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(titleButton())
    await user.clear(field())
    await user.type(field(), 'Slow title{Enter}')

    expect(action()).toBeDisabled()
    expect(action()).toHaveAccessibleName('Saving title')
    expect(field()).toHaveAttribute('readonly')
    // Clicking away while it saves does not throw the new title away.
    await user.click(screen.getByRole('button', { name: 'Somewhere else' }))
    expect(field()).toHaveValue('Slow title')

    await act(async () => resolve?.(saved('Slow title')))
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Slow title' })).toBeInTheDocument()
  })

  it('a failed save shows the error and stays in the field; Escape then puts the old title back', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(titleButton())
    await user.clear(field())
    await user.type(field(), 'Refused title{Enter}')
    await act(async () => reject?.(new Error('Title too long for the server')))

    const error = within(screen.getByTestId('clip-title')).getByRole('alert')
    expect(error).toHaveTextContent(/Not saved/)
    expect(field()).toHaveValue('Refused title')
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(field()).not.toHaveAttribute('readonly')
    expect(field()).toHaveFocus()
    expect(action()).toBeEnabled()
    expect(action()).toHaveAccessibleName('Save title')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'A clip' })).toBeInTheDocument()
  })

  it('an empty title is not saved: the old one stays', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(titleButton())
    await user.clear(field())
    await user.keyboard('{Enter}')
    expect(snippetApi.patchSnippet).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'A clip' })).toBeInTheDocument()
  })
})

describe('who may rename', () => {
  it('a viewer gets the title as text: no button, no pencil, clicking does nothing', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(<Harness canEdit={false} onToggle={onToggle} />)
    const heading = screen.getByRole('heading', { name: 'A clip' })
    expect(within(heading).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('clip-title-action')).toBeNull()

    await user.click(heading)
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('a transcript moment cannot be renamed', async () => {
    const user = userEvent.setup()
    render(<Harness clip={{ ...base, kind: 'moment', title: null, status: null } as SnippetClip} />)
    const heading = screen.getByRole('heading', { name: 'Transcript moment' })
    expect(within(heading).queryByRole('button')).toBeNull()
    await user.click(heading)
    expect(screen.queryByRole('textbox', { name: 'Clip title' })).toBeNull()
  })
})
