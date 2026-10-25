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
 *
 * §234b — these two settings are now the ONLY two. "Display internal
 * comments to guests" (§234 F1) was removed: a comment marked internal is
 * never shown on a share link, password or not. The assertions below say
 * that neither the toggle nor its field is left anywhere in the panel, and
 * that the two that remain are untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ themeColors: null, isLoading: false }),
}))

/** The settings panel reads its link through SWR; §234b's assertions are
 *  about what it renders and PATCHes for a given link, so the link is
 *  supplied directly. */
let settingsLink: Record<string, unknown> = {}
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr')
  return { ...actual, default: () => ({ data: settingsLink, mutate: vi.fn(), isLoading: false }) }
})

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

import { api } from '@/lib/api'
import { useShareSidebar } from '../use-share-sidebar'
import { ShareLinkSettingsPanel } from '@/components/projects/share-link-detail'

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

describe('comment-permission link with comments hidden — no longer storable', () => {
  /* §188 shipped this as a valid configuration. Live testing found it is a
     dead end: posting is allowed server-side with no box anywhere to type
     into. §189 reconciles the two fields on every write, so this pair
     cannot be persisted any more.

     These stay as DEFENSIVE cases, not as a supported setting: a row
     written before §189, or a stale cached response, can still produce it,
     and hiding the panel remains the right response. The rule itself is
     asserted in test_share_comment_settings_invariant.py. */
  it('hides the panel entirely', () => {
    render(<Panel permission="comment" showComments={false} />)

    expect(screen.queryByTestId('guest-comment-list')).toBeNull()
    expect(screen.getByTestId('no-sidebar')).toBeTruthy()
  })

  it('hides the compose input with it', () => {
    /* The dead end itself, in miniature: permission says post, and there
       is nowhere to. §189 stops this pair being stored at all; if one
       reaches the UI anyway, hiding the input is right — an input inside a
       panel that is not rendered could not be reached regardless. */
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

// ─── §189: the toggles cannot produce the dead-end pair ─────────────────────

describe('the Permissions toggles send both fields together', () => {
  /* Each toggle writes BOTH fields when its change would otherwise leave
     them contradicting. One immediateUpdate call, not two: it PATCHes the
     object it is handed, so a single call never renders the invalid
     in-between state.

     Read from the source — ShareLinkDetail needs a project, SWR and a share
     link to mount, and what is being checked is the payload shape, which is
     literal in the file. Comments stripped: the §189 comment above these
     toggles names both fields, so raw text matches the prose. */
  const RAW = readFileSync(
    join(process.cwd(), 'components/projects/share-link-detail.tsx'),
    'utf8',
  )
  const SRC = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

  it('turning posting ON also shows the panel', () => {
    expect(SRC).toMatch(
      /\{ permission: "comment", show_comments: true \}/,
    )
  })

  it('hiding the panel also revokes posting', () => {
    // §234 F1 had added a THIRD field to this same payload; §234b removed
    // the setting, so the payload is the two fields §189 made it again.
    expect(SRC).toMatch(
      /\{ show_comments: false, permission: "view" \}/,
    )
  })

  it('and sends nothing about internal comments any more (§234b)', () => {
    /* The option is gone: a comment marked internal is never shown on a
       share link, so there is no third field to reconcile and no toggle to
       render. The field must be absent from the whole component — a
       leftover `show_internal_comments: false` in one payload would be a
       write to a dead column. */
    /* SRC, not RAW: the file still MENTIONS the removed control in the
       comment that records where it was, which is the point of keeping
       that comment. What must be gone is the code. */
    expect(SRC).not.toContain('show_internal_comments')
    expect(SRC).not.toContain('Display internal comments to guests')
  })

  it('never sends a bare permission:comment that could strand the panel', () => {
    /* The §188 shape. `permission: "comment"` on its own leaves
       show_comments at whatever it was — which is exactly the dead end. */
    expect(SRC).not.toMatch(/permission: checked \? "comment" : "view"/)
  })

  it('never sends a bare show_comments:false', () => {
    expect(SRC).not.toMatch(/immediateUpdate\(\{ show_comments: checked \}\)/)
  })

  it('still lets view-only + comments-shown be set — the real use case', () => {
    /* Turning the panel ON must NOT touch permission, or the feature's
       whole point is undone. */
    expect(SRC).toMatch(/\{ show_comments: true \}/)
  })

  it('turning posting OFF leaves the panel alone', () => {
    /* A reader can keep seeing the discussion after posting is revoked. */
    expect(SRC).toMatch(/\{ permission: "view" \}/)
  })
})

// ─── §234b: the settings panel of an existing link ──────────────────────────

describe('§234b — the link settings offer two comment toggles, not three', () => {
  /* The rendered panel, not its source: the removed control was a
     `ToggleRow`, and a leftover one would still be a switch in the DOM
     however the file reads. (This replaces
     components/projects/__tests__/share-internal-comments-toggle.test.tsx,
     which existed to assert the toggle was there.) */
  const INTERNAL = 'Display internal comments to guests'

  function baseLink(overrides: Record<string, unknown> = {}) {
    return {
      token: 'tok',
      has_password: false,
      appearance: { theme: 'dark', accent_color: null },
      allowed_download_variants: [],
      fields_visibility: 'disabled',
      permission: 'view',
      is_enabled: true,
      show_versions: true,
      show_comments: true,
      ...overrides,
    }
  }

  function patchBodies() {
    return (api.patch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[0]) === '/share/tok')
      .map((c) => c[1] as Record<string, unknown>)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
    settingsLink = baseLink()
  })

  it('renders no "Display internal comments to guests" toggle', () => {
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(screen.getByRole('switch', { name: 'Show comments' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Let viewers comment' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: INTERNAL })).toBeNull()
    expect(
      screen.queryByText('Internal comments are visible to everyone who opens this link'),
    ).toBeNull()
  })

  it('renders none even for a stored link whose dead column is TRUE', () => {
    /* A link created before §234b still carries the column in a cached
       response. It must not resurrect the control. */
    settingsLink = baseLink({ show_internal_comments: true })
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(screen.queryByRole('switch', { name: INTERNAL })).toBeNull()
  })

  it('"Show comments" still hides the panel and revokes posting, in one PATCH', async () => {
    settingsLink = baseLink({ permission: 'comment', show_comments: true })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Show comments' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ show_comments: false, permission: 'view' }])
  })

  it('turning it back on touches nothing else', async () => {
    settingsLink = baseLink({ permission: 'view', show_comments: false })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Show comments' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ show_comments: true }])
  })

  it('"Let viewers comment" still forces the panel visible', async () => {
    settingsLink = baseLink({ permission: 'view', show_comments: false })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Let viewers comment' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ permission: 'comment', show_comments: true }])
  })

  it('and withdrawing it leaves the panel alone', async () => {
    settingsLink = baseLink({ permission: 'comment', show_comments: true })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Let viewers comment' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ permission: 'view' }])
  })
})
