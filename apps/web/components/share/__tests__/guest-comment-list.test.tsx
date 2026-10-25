/**
 * The asset share page's comment list.
 *
 * Two things this file has always been for, and one §234 adds.
 *
 * The original: a comment from a signed-in user has no `guest_name`, and
 * reading `comment.guest_name.charAt(0)` on one took the whole asset share
 * page down to Next's generic "Application error" screen (confirmed live on
 * two independent share links). The four-field chain that fixed it is gone
 * now — §234 F2 sends ONE field, `author_label` — but the lesson is the same
 * and is why these tests render the real component rather than only the
 * helper: the crash was in the JSX, and a pure-function test would keep
 * passing if someone put a field-specific `.charAt(0)` back in the markup.
 *
 * What §234 adds: the list may show NOTHING about an author except the
 * server's label and colour. A response carrying an author object, a guest
 * e-mail or a name is no longer something the server sends — and must not be
 * something this component would render if it arrived anyway.
 *
 * And what §234b changes: the chip's letters come from `author_initials`,
 * which the server sends on BOTH kinds of link, rather than being guessed
 * from the label. So a password link reads "MS" in the chip with "Mathias"
 * beside it, and an open link, where the two are the same string, shows the
 * chip alone. `visibility` is gone with the option it marked: a share link
 * never returns an internal comment, so there is nothing to badge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  GuestCommentList,
  commentAuthorName,
  commentAuthorColor,
  commentAuthorInitials,
  type GuestComment,
} from '../guest-comment-list'

const base = { id: 'c1', body: 'Looks good', created_at: '2026-01-01T00:00:00Z' }

function serve(comments: Partial<GuestComment>[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => comments })))
}

async function renderList(props: Record<string, unknown> = {}) {
  render(<GuestCommentList token="tok" refreshKey={0} {...props} />)
  await waitFor(() => expect(screen.queryByText('Looks good')).toBeTruthy())
}

function lastFetchUrl(): string {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>
  return String(mock.mock.calls[mock.mock.calls.length - 1][0])
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

describe('§234 F3 — who left the comment, as far as a share viewer may know', () => {
  it('renders the label the server sent', async () => {
    serve([{ ...base, author_label: 'MS' }])
    await renderList()
    expect(screen.getByText('MS')).toBeTruthy()
  })

  it('renders a first name on a password-protected link just as it arrives', async () => {
    // The server decides which of the two it sends; the page does not.
    serve([{ ...base, author_label: 'Mathias', author_initials: 'MS' }])
    await renderList()
    expect(screen.getByText('Mathias')).toBeTruthy()
  })

  it('paints the chip with the colour the server chose', async () => {
    serve([{ ...base, author_label: 'MS', author_color: '#10b981' }])
    await renderList()
    const chips = document.querySelectorAll('[style*="background-color"]')
    expect(chips.length).toBeGreaterThan(0)
    expect(
      Array.from(chips).some((c) =>
        (c as HTMLElement).style.backgroundColor === 'rgb(16, 185, 129)',
      ),
    ).toBe(true)
  })

  it('gives two authors with the same label their two different colours', async () => {
    serve([
      { id: 'a', body: 'Looks good', created_at: base.created_at, author_label: 'MS', author_color: '#8b5cf6' },
      { id: 'b', body: 'Agreed', created_at: base.created_at, author_label: 'MS', author_color: '#10b981' },
    ])
    await renderList()
    const colours = new Set(
      Array.from(document.querySelectorAll('[style*="background-color"]')).map(
        (c) => (c as HTMLElement).style.backgroundColor,
      ),
    )
    expect(colours.size).toBe(2)
  })

  it('renders a thread of two without either one crashing it', async () => {
    serve([
      { id: 'a', body: 'Looks good', created_at: base.created_at, author_label: 'DD' },
      { id: 'b', body: 'Agreed', created_at: base.created_at, author_label: 'MS' },
    ])
    await renderList()
    expect(screen.getByText('DD')).toBeTruthy()
    expect(screen.getByText('MS')).toBeTruthy()
    expect(screen.getByText('Agreed')).toBeTruthy()
  })

  it('falls back to "User" when the comment names nobody at all', async () => {
    serve([{ ...base }])
    await renderList()
    expect(screen.getByText('User')).toBeTruthy()
  })

  it('badges nothing as internal, whatever a response claims (§234b)', async () => {
    /* The server cannot send an internal comment to a share link any more.
       The point of the assertion is that the COMPONENT would not mark one
       either, so a response from an older API cannot put the badge back. */
    serve([
      {
        ...base,
        author_label: 'MS',
        ...({ visibility: 'internal' } as Record<string, unknown>),
      },
    ])
    await renderList()
    expect(screen.queryByText('Internal')).toBeNull()
    expect(document.body.textContent).not.toContain('Internal')
  })

  it('renders nothing from an author object, should one ever arrive', async () => {
    // The server stopped sending these (§234 F2). The point of the assertion
    // is that the COMPONENT does not display them either, so a response from
    // an older API cannot put a name or an address back on the page.
    serve([
      {
        ...base,
        author_label: 'MS',
        ...({
          author: { id: 'u1', name: 'Mathias Sonnleitner', avatar_url: null },
          guest_author: { id: 'g1', name: 'Dana Doe', email: 'dana@example.test' },
          author_name: 'Mathias Sonnleitner',
          guest_email: 'dana@example.test',
        } as Record<string, unknown>),
      },
    ])
    await renderList()
    expect(screen.getByText('MS')).toBeTruthy()
    for (const leaked of ['Mathias Sonnleitner', 'Dana Doe', 'dana@example.test']) {
      expect(screen.queryByText(leaked)).toBeNull()
    }
    expect(document.body.textContent).not.toContain('dana@example.test')
  })
})

describe('§234 D — the password session travels with the request', () => {
  it('is sent when there is one', async () => {
    serve([{ ...base, author_label: 'MS' }])
    await renderList({ shareSession: 'sess-123' })
    expect(lastFetchUrl()).toContain('share_session=sess-123')
  })

  it('is absent when there is none, rather than sent empty', async () => {
    serve([{ ...base, author_label: 'MS' }])
    await renderList()
    expect(lastFetchUrl()).not.toContain('share_session')
  })

  it('refetches when the visitor unlocks the link', async () => {
    serve([{ ...base, author_label: 'MS' }])
    const { rerender } = render(
      <GuestCommentList token="tok" refreshKey={0} shareSession={null} />,
    )
    await waitFor(() => expect(screen.queryByText('Looks good')).toBeTruthy())
    rerender(<GuestCommentList token="tok" refreshKey={0} shareSession="sess-after" />)
    await waitFor(() => expect(lastFetchUrl()).toContain('share_session=sess-after'))
  })
})

describe('§234b — the chip shows the initials, the label only when it adds', () => {
  it('a password link: "MS" in the chip, "Mathias" beside it', async () => {
    serve([{ ...base, author_label: 'Mathias', author_initials: 'MS' }])
    await renderList()
    expect(screen.getByText('MS')).toBeTruthy()
    expect(screen.getByText('Mathias')).toBeTruthy()
    // The chip is the coloured circle; the label is the text next to it.
    const chip = document.querySelector('[style*="background-color"]')
    expect(chip?.textContent).toBe('MS')
  })

  it('never takes letters off a first name', async () => {
    /* The bug §234b fixes: the page derived the chip from the label, so
       "Mathias" became "M" — the same person read "MS" on one link and "M"
       on another. */
    serve([{ ...base, author_label: 'Mathias', author_initials: 'MS' }])
    await renderList()
    const chip = document.querySelector('[style*="background-color"]')
    expect(chip?.textContent).not.toBe('M')
    expect(chip?.textContent).not.toBe('MA')
  })

  it('an open link: the chip alone, not "MS MS"', async () => {
    serve([{ ...base, author_label: 'MS', author_initials: 'MS' }])
    await renderList()
    expect(screen.getAllByText('MS')).toHaveLength(1)
  })

  it('renders no last name even if one arrived in the initials field', async () => {
    /* The server derives the field with `initials_for_name`, which cannot
       produce a word. This is the page half: whatever arrives goes in the
       chip and nowhere else, so nothing is spread across the row. */
    serve([{ ...base, author_label: 'Mathias', author_initials: 'MS' }])
    await renderList()
    expect(document.body.textContent).not.toContain('Sonnleitner')
  })

  it('falls back to the old rule when the server sent no initials', async () => {
    // An older API, or a parse that failed: a chip, never a crash.
    serve([{ ...base, author_label: 'Mathias' }])
    await renderList()
    const chip = document.querySelector('[style*="background-color"]')
    expect(chip?.textContent).toBe('M')
    expect(screen.getByText('Mathias')).toBeTruthy()
  })

  it('and to "U" when the comment names nobody at all', async () => {
    serve([{ ...base }])
    await renderList()
    const chip = document.querySelector('[style*="background-color"]')
    expect(chip?.textContent).toBe('U')
    expect(screen.getByText('User')).toBeTruthy()
  })
})

describe('commentAuthorInitials', () => {
  const cases: Array<[string, Partial<GuestComment>, string]> = [
    ['the field the server sent', { author_initials: 'MS', author_label: 'Mathias' }, 'MS'],
    ['an open link, where the two agree', { author_initials: 'MS', author_label: 'MS' }, 'MS'],
    ['no initials, a short label', { author_label: 'MS' }, 'MS'],
    ['no initials, a first name', { author_label: 'Mathias' }, 'M'],
    ['nothing at all', {}, 'U'],
    ['an empty initials field is not a field', { author_initials: '', author_label: 'MS' }, 'MS'],
  ]
  it.each(cases)('%s', (_label, comment, expected) => {
    expect(commentAuthorInitials({ ...base, ...comment } as GuestComment)).toBe(expected)
  })

  it('always returns something renderable', () => {
    for (const [, comment] of cases) {
      const got = commentAuthorInitials({ ...base, ...comment } as GuestComment)
      expect(typeof got).toBe('string')
      expect(got.length).toBeGreaterThan(0)
    }
  })
})

describe('commentAuthorName / commentAuthorColor', () => {
  const cases: Array<[string, Partial<GuestComment>, string]> = [
    ['the label', { author_label: 'MS' }, 'MS'],
    ['a first name is a label too', { author_label: 'Mathias' }, 'Mathias'],
    ['nothing at all', {}, 'User'],
    ['an empty label is not a label', { author_label: '' }, 'User'],
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

  it('always returns a colour, even with none in the payload', () => {
    expect(commentAuthorColor({ ...base } as GuestComment)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(
      commentAuthorColor({ ...base, author_color: '#123456' } as GuestComment),
    ).toBe('#123456')
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

  it('shows the empty state on a 403 — a link whose password was not answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })))
    render(<GuestCommentList token="tok" refreshKey={0} />)
    await waitFor(() => expect(screen.getByText('No comments — yet')).toBeTruthy())
  })
})
