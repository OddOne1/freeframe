/**
 * Reading comments and posting them are separate settings (§188).
 *
 * `permission` used to decide both: whether a viewer may POST a comment,
 * and — through use-share-sidebar — whether the panel existed at all. So a
 * view-only link hid the team's existing discussion outright, with no way
 * to show a client the conversation without also letting them join it.
 *
 * The server never conflated them: GET /share/{token}/comments has no
 * permission gate and never had one, only POST does. This adds the missing
 * UI half.
 *
 * What is asserted is the PAIRING — panel visible, input absent — because
 * each half alone is the wrong outcome. A panel with a compose box that
 * 403s on submit is worse than no panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response),
)

const COMMENT_INPUT = 'guest-comment-input'
vi.mock('@/components/review/guest-comment-input', () => ({
  GuestCommentInput: () => <div data-testid={COMMENT_INPUT} />,
}))
vi.mock('@/components/share/guest-comment-list', () => ({
  GuestCommentList: () => <div data-testid="guest-comment-list">existing comments</div>,
}))
vi.mock('@/components/share/share-fields-panel', () => ({
  ShareFieldsPanel: () => <div data-testid="fields-panel" />,
}))

import { useShareSidebar } from '../use-share-sidebar'

/**
 * The panel's own rules, exercised through the real hook.
 *
 * ShareRightPanel is module-local to the share page and unexported, so the
 * two decisions it makes are reproduced here against the REAL hook output:
 * whether the comments panel renders, and whether the compose input does.
 * The second condition is copied verbatim from the page and pinned against
 * the source at the bottom of this file, so the copy cannot drift.
 */
function Panel({
  permission,
  showComments,
}: {
  permission: string
  showComments: boolean
}) {
  const sidebar = useShareSidebar({
    permission: permission as never,
    fieldsVisibility: 'disabled',
    showComments,
  })
  const canPost = permission === 'comment' || permission === 'approve'
  if (!sidebar.showSidebar) return <div data-testid="no-sidebar" />
  return (
    <div>
      {sidebar.activeTab === 'comments' && sidebar.showComments ? (
        <>
          <div data-testid="guest-comment-list">existing comments</div>
          {canPost && <div data-testid={COMMENT_INPUT} />}
        </>
      ) : (
        <div data-testid="fields-panel" />
      )}
    </div>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('view-only link with comments shown', () => {
  it('renders the comments panel', () => {
    render(<Panel permission="view" showComments />)

    expect(screen.getByTestId('guest-comment-list')).toBeTruthy()
    expect(screen.queryByTestId('no-sidebar')).toBeNull()
  })

  it('does NOT render the compose input — posting is still blocked', () => {
    /* The pairing that matters. Without this gate the decoupling hands a
       read-only viewer a box whose every submit 403s at POST. */
    render(<Panel permission="view" showComments />)

    expect(screen.queryByTestId(COMMENT_INPUT)).toBeNull()
  })
})

describe('comment-permission link with comments hidden', () => {
  it('hides the panel entirely', () => {
    render(<Panel permission="comment" showComments={false} />)

    expect(screen.queryByTestId('guest-comment-list')).toBeNull()
    expect(screen.getByTestId('no-sidebar')).toBeTruthy()
  })

  it('hides the compose input with it', () => {
    /* Deliberately a valid configuration rather than auto-corrected:
       comments can be collected through a link whose panel stays hidden.
       Nothing to post INTO here, though, since the panel is gone. */
    render(<Panel permission="comment" showComments={false} />)

    expect(screen.queryByTestId(COMMENT_INPUT)).toBeNull()
  })
})

describe('the ordinary configurations still behave', () => {
  it('comment + shown: panel and input both present', () => {
    render(<Panel permission="comment" showComments />)

    expect(screen.getByTestId('guest-comment-list')).toBeTruthy()
    expect(screen.getByTestId(COMMENT_INPUT)).toBeTruthy()
  })

  it('approve + shown: input present too', () => {
    render(<Panel permission="approve" showComments />)

    expect(screen.getByTestId(COMMENT_INPUT)).toBeTruthy()
  })

  it('view + hidden: nothing at all, as before §188', () => {
    render(<Panel permission="view" showComments={false} />)

    expect(screen.getByTestId('no-sidebar')).toBeTruthy()
  })
})

describe('the page really applies these rules', () => {
  /* The Panel above reproduces two conditions; these pin them against the
     shipped source so the reproduction cannot quietly drift from it.
     Comments stripped — the §188 comments name the very identifiers being
     matched, so raw text matches the prose rather than the code. */
  const RAW = readFileSync(
    join(process.cwd(), 'app/share/[token]/page.tsx'),
    'utf8',
  )
  const PAGE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

  it('gates the compose input on the posting permission', () => {
    expect(PAGE).toMatch(
      /\(permission === 'comment' \|\| permission === 'approve'\) && \(\s*<GuestCommentInput/,
    )
  })

  it('passes show_comments from the API into the sidebar hook', () => {
    expect(PAGE).toContain('showComments: data.show_comments ?? true')
    expect(PAGE).toMatch(/useShareSidebar\(\{[^}]*showComments[^}]*\}\)/)
  })

  it('does not gate the comments PANEL on permission any more', () => {
    // The whole point: visibility comes from the flag, not the ladder.
    expect(PAGE).toMatch(/activeTab === 'comments' && showComments/)
  })
})
