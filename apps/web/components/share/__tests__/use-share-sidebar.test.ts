/**
 * Share sidebar visibility (CLAUDE.md §33).
 *
 * The two bugs this replaces were both "a tab that is visible but does
 * nothing" — so what is asserted here is the absence of surfaces, not just
 * their presence.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useShareSidebar } from '../use-share-sidebar'

const run = (permission: string, fieldsVisibility: 'disabled' | 'basic' | 'full') =>
  renderHook(() => useShareSidebar({ permission: permission as never, fieldsVisibility }))

describe('neither panel enabled', () => {
  it('hides the sidebar entirely, toggle included', () => {
    const { result } = run('view', 'disabled')
    expect(result.current.showSidebar).toBe(false)
    expect(result.current.showComments).toBe(false)
    expect(result.current.showFields).toBe(false)
    expect(result.current.showTabSwitcher).toBe(false)
  })
})

describe('exactly one panel enabled', () => {
  it('shows Fields with no switcher when comments are off', () => {
    const { result } = run('view', 'basic')
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
    const { result } = run('view', 'full')
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
    const { result } = run('view', 'full')
    expect(result.current.showComments).toBe(false)
    expect(result.current.showFields).toBe(true)
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
