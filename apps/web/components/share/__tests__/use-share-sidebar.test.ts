/**
 * Share sidebar visibility (CLAUDE.md §33).
 *
 * The two bugs this replaces were both "a tab that is visible but does
 * nothing" — so what is asserted here is the absence of surfaces, not just
 * their presence.
 *
 * §188 — `showComments` is now its own persisted flag rather than something
 * derived from `permission`. The cases below used to say `view` and mean
 * "comments hidden"; they now say so directly, because those became two
 * different statements the moment a view-only link could show comments.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useShareSidebar } from '../use-share-sidebar'

const run = (
  permission: string,
  fieldsVisibility: 'disabled' | 'basic' | 'full',
  showComments = true,
) =>
  renderHook(() =>
    useShareSidebar({ permission: permission as never, fieldsVisibility, showComments }),
  )

describe('neither panel enabled', () => {
  it('hides the sidebar entirely, toggle included', () => {
    const { result } = run('view', 'disabled', false)
    expect(result.current.showSidebar).toBe(false)
    expect(result.current.showComments).toBe(false)
    expect(result.current.showFields).toBe(false)
    expect(result.current.showTabSwitcher).toBe(false)
  })
})

describe('exactly one panel enabled', () => {
  it('shows Fields with no switcher when comments are off', () => {
    const { result } = run('view', 'basic', false)
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.showTabSwitcher).toBe(false)
    expect(result.current.activeTab).toBe('fields')
  })

  it('shows Comments with no switcher when fields are off', () => {
    const { result } = run('comment', 'disabled')
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.showTabSwitcher).toBe(false)
    expect(result.current.activeTab).toBe('comments')
  })

  it('never lands on a hidden tab, whatever was clicked before', () => {
    // The original folder-viewer bug in miniature: a stored tab pointing at
    // a panel that is not rendered.
    const { result } = run('view', 'full', false)
    act(() => result.current.setActiveTab('comments'))
    expect(result.current.activeTab).toBe('fields')
  })
})

describe('both panels enabled', () => {
  it('keeps the switcher and lets it switch', () => {
    const { result } = run('comment', 'basic')
    expect(result.current.showTabSwitcher).toBe(true)
    expect(result.current.activeTab).toBe('comments')
    act(() => result.current.setActiveTab('fields'))
    expect(result.current.activeTab).toBe('fields')
  })
})

describe('fields is independent of the comments permission', () => {
  it('is off for an approve-permission link that did not enable it', () => {
    const { result } = run('approve', 'disabled')
    expect(result.current.showComments).toBe(true)
    expect(result.current.showFields).toBe(false)
  })

  it('is on for a view-only link that did enable it', () => {
    const { result } = run('view', 'full', false)
    expect(result.current.showComments).toBe(false)
    expect(result.current.showFields).toBe(true)
  })
})

// ─── §188: reading comments is independent of posting them ──────────────────

describe('comments visibility no longer follows the permission', () => {
  it('shows the panel on a VIEW-ONLY link when the owner enabled it', () => {
    /* The point of §188. A client can read the team's discussion on a
       read-only link; whether they may reply is a separate switch, checked
       elsewhere (`canComment`) and untouched here. */
    const { result } = run('view', 'disabled', true)
    expect(result.current.showComments).toBe(true)
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.activeTab).toBe('comments')
  })

  it('still hides the panel if it somehow receives the forbidden pair', () => {
    /* §188 called this a valid configuration. §189 removed it — posting
       with no visible panel is a dead end, and the server now reconciles
       the two fields so it cannot be stored (see
       _reconcile_comment_settings). The assertion is KEPT rather than
       deleted because the hook is a pure function that can still be handed
       this pair: a row written before §189, a stale cached validate
       response, an older client. Hiding the panel is the right response to
       it; what changed is that this is defensive, not a supported setting. */
    const { result } = run('comment', 'disabled', false)
    expect(result.current.showComments).toBe(false)
    expect(result.current.showSidebar).toBe(false)
  })

  it('hides it on an APPROVE link too when turned off', () => {
    const { result } = run('approve', 'disabled', false)
    expect(result.current.showComments).toBe(false)
  })

  it.each(['view', 'comment', 'approve'])(
    'ignores permission=%s entirely when deciding visibility',
    (permission) => {
      expect(run(permission, 'disabled', true).result.current.showComments).toBe(true)
      expect(run(permission, 'disabled', false).result.current.showComments).toBe(false)
    },
  )

  it('defaults to SHOWING when the flag is missing', () => {
    /* An older cached validate response, or the field renamed on one side.
       A missing panel reads as a broken app; an extra one does not. */
    const { result } = renderHook(() =>
      useShareSidebar({ permission: 'view' as never, fieldsVisibility: 'disabled' }),
    )
    expect(result.current.showComments).toBe(true)
  })
})

describe('the full level is carried through, not flattened to a boolean', () => {
  it.each([
    ['basic', 'basic'],
    ['full', 'full'],
  ] as const)('reports %s as-is', (given, expected) => {
    expect(run('view', given).result.current.fieldsLevel).toBe(expected)
  })

  it('defaults to disabled when the link predates the setting', () => {
    const { result } = renderHook(() =>
      useShareSidebar({ permission: 'comment' as never, fieldsVisibility: undefined }),
    )
    expect(result.current.fieldsLevel).toBe('disabled')
    expect(result.current.showFields).toBe(false)
  })
})
