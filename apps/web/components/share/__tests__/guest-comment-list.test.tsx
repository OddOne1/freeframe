/**
 * A comment from a signed-in user has no `guest_name` — and reading
 * `comment.guest_name.charAt(0)` on one took the whole asset share page down
 * to Next's generic "Application error" screen. Confirmed live on two
 * independent share links.
 *
 * These render the real component, rather than only testing the name helper,
 * because the crash was in the JSX. A pure-function test would keep passing
 * if someone put `comment.guest_name.charAt(0)` back in the markup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GuestCommentList, commentAuthorName, type GuestComment } from '../guest-comment-list'

const base = { id: 'c1', body: 'Looks good', created_at: '2026-01-01T00:00:00Z' }

function serve(comments: Partial<GuestComment>[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => comments })))
}

async function renderList() {
  render(<GuestCommentList token="tok" refreshKey={0} />)
  await waitFor(() => expect(screen.queryByText('Looks good')).toBeTruthy())
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('who left the comment', () => {
  it('renders an anonymous guest by their guest_name', async () => {
    serve([{ ...base, guest_name: 'Dana' }])
    await renderList()
    expect(screen.getByText('Dana')).toBeTruthy()
    expect(screen.getByText('D')).toBeTruthy()
  })

  it('renders a signed-in author without throwing — the reported crash', async () => {
    serve([{ ...base, author: { id: 'u1', name: 'Mathias' } }])
    await renderList()
    expect(screen.getByText('Mathias')).toBeTruthy()
    expect(screen.getByText('M')).toBeTruthy()
  })

  it('renders a named share-link visitor from guest_author', async () => {
    serve([{ ...base, guest_author: { id: 'g1', name: 'Priya', email: 'p@x.co' } }])
    await renderList()
    expect(screen.getByText('Priya')).toBeTruthy()
    expect(screen.getByText('P')).toBeTruthy()
  })

  it('falls back to author_name', async () => {
    serve([{ ...base, author_name: 'Sam' }])
    await renderList()
    expect(screen.getByText('Sam')).toBeTruthy()
  })

  it('falls back to "User" when the comment names nobody at all', async () => {
    serve([{ ...base }])
    await renderList()
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('U')).toBeTruthy()
  })

  it('renders a mixed thread — one guest, one signed-in — in full', async () => {
    // The real repro: the crash killed the page, so the guest comment beside
    // it disappeared too. Both must survive together.
    serve([
      { id: 'a', body: 'Looks good', created_at: base.created_at, guest_name: 'Dana' },
      { id: 'b', body: 'Agreed', created_at: base.created_at, author: { id: 'u1', name: 'Mathias' } },
    ])
    await renderList()
    expect(screen.getByText('Dana')).toBeTruthy()
    expect(screen.getByText('Mathias')).toBeTruthy()
    expect(screen.getByText('Agreed')).toBeTruthy()
  })

  it('prefers the signed-in author when both are somehow present', async () => {
    serve([{ ...base, guest_name: 'Dana', author: { id: 'u1', name: 'Mathias' } }])
    await renderList()
    expect(screen.getByText('Mathias')).toBeTruthy()
    expect(screen.queryByText('Dana')).toBeNull()
  })
})

describe('commentAuthorName', () => {
  const cases: Array<[string, Partial<GuestComment>, string]> = [
    ['author wins', { author: { id: 'u', name: 'A' }, guest_author: { id: 'g', name: 'B', email: '' }, guest_name: 'C', author_name: 'D' }, 'A'],
    ['then guest_author', { guest_author: { id: 'g', name: 'B', email: '' }, guest_name: 'C', author_name: 'D' }, 'B'],
    ['then guest_name', { guest_name: 'C', author_name: 'D' }, 'C'],
    ['then author_name', { author_name: 'D' }, 'D'],
    ['then User', {}, 'User'],
    ['a null author does not win', { author: null, guest_name: 'C' }, 'C'],
    ['an empty guest_name is not a name', { guest_name: '', author_name: 'D' }, 'D'],
  ]
  it.each(cases)('%s', (_label, comment, expected) => {
    expect(commentAuthorName({ ...base, ...comment } as GuestComment)).toBe(expected)
  })

  it('always returns something charAt can be called on', () => {
    for (const [, comment] of cases) {
      const name = commentAuthorName({ ...base, ...comment } as GuestComment)
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })
})

describe('the list itself', () => {
  it('shows the empty state rather than crashing on no comments', async () => {
    serve([])
    render(<GuestCommentList token="tok" refreshKey={0} />)
    await waitFor(() => expect(screen.getByText('No comments — yet')).toBeTruthy())
  })

  it('survives a non-array body from the API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ detail: 'nope' }) })))
    render(<GuestCommentList token="tok" refreshKey={0} />)
    await waitFor(() => expect(screen.getByText('No comments — yet')).toBeTruthy())
  })
})
