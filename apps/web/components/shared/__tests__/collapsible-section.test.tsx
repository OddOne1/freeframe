/**
 * The shared collapsible section (CLAUDE.md §38).
 *
 * Extracted from Settings → Admin's UserGroupBlock, which was the only
 * implementation of the pattern. Two things are worth pinning: that collapse
 * state survives a reload (the reason it was extracted rather than copied —
 * Admin's own version reset on every load), and that a section's key is
 * genuinely its own, since the whole ask is "collapse this one group".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsibleSection } from '../collapsible-section'

beforeEach(() => {
  window.localStorage.clear()
})

describe('CollapsibleSection', () => {
  it('shows its children until it is collapsed', async () => {
    render(
      <CollapsibleSection title="Ungrouped" count={3} storageKey="t-a">
        <p>contents</p>
      </CollapsibleSection>,
    )
    expect(screen.getByText('contents')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByText('contents')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('remembers being collapsed across a remount', async () => {
    const { unmount } = render(
      <CollapsibleSection title="Ungrouped" storageKey="t-b">
        <p>contents</p>
      </CollapsibleSection>,
    )
    await userEvent.click(screen.getByRole('button'))
    unmount()

    render(
      <CollapsibleSection title="Ungrouped" storageKey="t-b">
        <p>contents</p>
      </CollapsibleSection>,
    )
    // Admin's own version reset on every page load; that is what §38 changes.
    expect(screen.queryByText('contents')).not.toBeInTheDocument()
  })

  it('keeps each section on its own key', async () => {
    render(
      <>
        <CollapsibleSection title="One" storageKey="t-one">
          <p>first</p>
        </CollapsibleSection>
        <CollapsibleSection title="Two" storageKey="t-two">
          <p>second</p>
        </CollapsibleSection>
      </>,
    )
    await userEvent.click(screen.getByRole('heading', { name: /^One/ }).querySelector('button')!)

    expect(screen.queryByText('first')).not.toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
    expect(window.localStorage.getItem('ff-collapse-t-one')).toBe('1')
    expect(window.localStorage.getItem('ff-collapse-t-two')).toBeNull()
  })

  it('honours a stored expansion over defaultCollapsed', () => {
    window.localStorage.setItem('ff-collapse-t-c', '0')
    render(
      <CollapsibleSection title="Deactivated" storageKey="t-c" defaultCollapsed>
        <p>contents</p>
      </CollapsibleSection>,
    )
    expect(screen.getByText('contents')).toBeInTheDocument()
  })

  it('falls back to defaultCollapsed with nothing stored', () => {
    render(
      <CollapsibleSection title="Deactivated" storageKey="t-d" defaultCollapsed>
        <p>contents</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('contents')).not.toBeInTheDocument()
  })

  it('does not persist a section given no key', async () => {
    render(
      <CollapsibleSection title="Ephemeral">
        <p>contents</p>
      </CollapsibleSection>,
    )
    await userEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('contents')).not.toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })

  it('survives localStorage being unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      render(
        <CollapsibleSection title="Private" storageKey="t-e">
          <p>contents</p>
        </CollapsibleSection>,
      )
      // Still collapses; it just forgets. Not rendering at all would be worse.
      await userEvent.click(screen.getByRole('button'))
      expect(screen.queryByText('contents')).not.toBeInTheDocument()
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('keeps the header a real heading, with the toggle inside it', () => {
    render(
      <CollapsibleSection title="Members" count={2} tone="block">
        <p>contents</p>
      </CollapsibleSection>,
    )
    const heading = screen.getByRole('heading', { name: /^Members/ })
    // <h2><button aria-expanded> — a heading inside a button would be invalid.
    expect(heading.tagName).toBe('H2')
    expect(heading.querySelector('button')).toHaveAttribute('aria-expanded', 'true')
    // Admin's literal "MEMBERS (2)" format, unchanged by the extraction.
    expect(heading).toHaveTextContent('Members (2)')
  })

  it('puts actions outside the toggle, where a button can legally live', async () => {
    const onAction = vi.fn()
    render(
      <CollapsibleSection
        title="Group"
        storageKey="t-f"
        actions={<button onClick={onAction}>Rename</button>}
      >
        <p>contents</p>
      </CollapsibleSection>,
    )
    const action = screen.getByRole('button', { name: 'Rename' })
    expect(action.closest('[aria-expanded]')).toBeNull()

    await userEvent.click(action)
    expect(onAction).toHaveBeenCalled()
    // Using an action must not toggle the section.
    expect(screen.getByText('contents')).toBeInTheDocument()
  })

  it('swaps the title out for an inline editor without losing the toggle', async () => {
    render(
      <CollapsibleSection
        title="Group"
        storageKey="t-g"
        titleOverride={<input aria-label="Rename Group" defaultValue="Group" />}
      >
        <p>contents</p>
      </CollapsibleSection>,
    )
    const input = screen.getByLabelText('Rename Group')
    // The reason titleOverride exists: an <input> cannot live in a <button>.
    expect(input.closest('button')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Collapse/ }))
    expect(screen.queryByText('contents')).not.toBeInTheDocument()
  })
})
