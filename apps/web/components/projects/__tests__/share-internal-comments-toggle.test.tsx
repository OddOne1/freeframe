/**
 * §234 F1 — "Display internal comments to guests", in the settings of an
 * existing link.
 *
 * The setting is deliberately NOT a fourth independent switch. It is
 * subordinate to "Show comments" in exactly the way §189 made `permission`
 * subordinate to it: "include the internal ones" with no comment panel to
 * include them in is a dead end, not a configuration. So:
 *
 *   * it is offered only while "Show comments" is on;
 *   * turning "Show comments" off clears it IN THE SAME PATCH, because two
 *     PATCHes would leave a window in which the link is stored as "no
 *     panel, internal visible", and because a link whose comments were
 *     hidden and later shown again must not bring the internal thread back
 *     with it.
 *
 * `_reconcile_comment_settings` server-side is the actual guarantee (a
 * hand-made PATCH goes through it too, and tests/
 * test_share_comment_settings_invariant.py covers it); this file is about
 * the panel being right immediately, without waiting for a refetch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ themeColors: null, isLoading: false }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

let link: Record<string, unknown> = {}
const mutate = vi.fn()
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr')
  return {
    ...actual,
    default: () => ({ data: link, mutate, isLoading: false }),
  }
})

import { api } from '@/lib/api'
import { ShareLinkSettingsPanel } from '../share-link-detail'

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
    show_internal_comments: false,
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
  link = baseLink()
})

describe('where the toggle is', () => {
  it('is offered, directly below "Show comments"', () => {
    render(<ShareLinkSettingsPanel token="tok" />)
    const show = screen.getByRole('switch', { name: 'Show comments' })
    const internal = screen.getByRole('switch', { name: INTERNAL })
    expect(internal).toBeTruthy()
    // Document order: the next switch after "Show comments" is this one.
    const switches = Array.from(document.querySelectorAll('[role="switch"]'))
    expect(switches.indexOf(internal)).toBe(switches.indexOf(show) + 1)
  })

  it('carries the owner\'s one-line explanation', () => {
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(
      screen.getByText('Internal comments are visible to everyone who opens this link'),
    ).toBeTruthy()
  })

  it('is not offered at all while comments are hidden', () => {
    link = baseLink({ show_comments: false })
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(screen.getByRole('switch', { name: 'Show comments' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: INTERNAL })).toBeNull()
  })

  it('reflects the stored value', () => {
    link = baseLink({ show_internal_comments: true })
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(screen.getByRole('switch', { name: INTERNAL })).toHaveAttribute(
      'data-state',
      'checked',
    )
  })

  it('reads as off for a link created before the column existed', () => {
    // An older cached response has no such field; undefined must not read
    // as "show them".
    const { show_internal_comments: _omitted, ...without } = baseLink()
    link = without
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(screen.getByRole('switch', { name: INTERNAL })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
  })
})

describe('what it writes', () => {
  it('PATCHes the one field when turned on', async () => {
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: INTERNAL }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ show_internal_comments: true }])
  })

  it('and when turned off again', async () => {
    link = baseLink({ show_internal_comments: true })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: INTERNAL }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()).toEqual([{ show_internal_comments: false }])
  })
})

describe('§189\'s rule, extended to the third setting', () => {
  it('hiding the comment panel clears it in the same update', async () => {
    link = baseLink({ show_comments: true, show_internal_comments: true })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Show comments' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    // ONE patch, carrying all three — not a sequence with an invalid state
    // stored in between.
    expect(patchBodies()).toEqual([
      {
        show_comments: false,
        permission: 'view',
        show_internal_comments: false,
      },
    ])
  })

  it('and still withdraws posting, which is §189\'s own half', async () => {
    link = baseLink({ permission: 'comment', show_comments: true })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Show comments' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()[0].permission).toBe('view')
  })

  it('turning posting on still forces the panel visible', async () => {
    link = baseLink({ permission: 'view', show_comments: false })
    const user = userEvent.setup()
    render(<ShareLinkSettingsPanel token="tok" />)
    await user.click(screen.getByRole('switch', { name: 'Let viewers comment' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBodies()[0]).toEqual({ permission: 'comment', show_comments: true })
  })
})
