/**
 * §119 — the LUT picker as a sidebar: grouped, nested, and not truncated.
 *
 * The dropdown it replaces was a 240px panel anchored `align="end"`, which
 * grows LEFTWARD from a trigger sitting near the left of the transport bar —
 * so it ran into the nav by construction, not by viewport accident. It also
 * ignored `group_id`, which is already on every LUT it receives.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LutSidebar, LutSidebarToggle } from '../lut-sidebar'

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutThumbnail: () => Promise.resolve('data:image/png;base64,small'),
  getCachedLutThumbnail: () => 'data:image/png;base64,small',
  renderLutPreview: () => Promise.reject(new Error('the list must not ask for this')),
  getCachedLutPreview: () => null,
}))

const GROUPS = [
  { id: 'g-main', name: 'Show LUTs', is_platform: false, parent_group_id: null, created_at: '' },
  { id: 'g-sub', name: 'Dailies', is_platform: false, parent_group_id: 'g-main', created_at: '' },
]

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === '/me/lut-groups' ? GROUPS : [],
    isLoading: false,
  }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), upload: vi.fn() } }))

const lut = (over: Partial<Record<string, unknown>>) => ({
  id: 'x', name: 'X', lut_size: 33, file_url: '/a.cube',
  shared_with_project: true, group_id: null, ...over,
}) as never

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.localStorage.clear()
})

const base = {
  selectedId: null,
  onSelect: vi.fn(),
  onClose: vi.fn(),
}

describe('grouping', () => {
  it('renders a LUT under its own group name, resolved from group_id', () => {
    render(<LutSidebar {...base} luts={[lut({ id: 'a', name: 'Kodak', group_id: 'g-main' })]} />)
    expect(screen.getByText('Show LUTs')).toBeInTheDocument()
    expect(screen.getByText('Kodak')).toBeInTheDocument()
  })

  it('nests a sub-group inside its parent, one level (§45)', () => {
    render(
      <LutSidebar
        {...base}
        luts={[
          lut({ id: 'a', name: 'Kodak', group_id: 'g-main' }),
          lut({ id: 'b', name: 'Fuji', group_id: 'g-sub' }),
        ]}
      />,
    )
    // The sub-group renders, and inside the parent's subtree rather than
    // beside it.
    const parent = screen.getByText('Show LUTs').closest('div')!.parentElement!
    expect(within(parent).getByText('Dailies')).toBeInTheDocument()
    expect(within(parent).getByText('Fuji')).toBeInTheDocument()
  })

  it('counts a parent group including what its sub-group holds', () => {
    render(
      <LutSidebar
        {...base}
        luts={[
          lut({ id: 'a', name: 'Kodak', group_id: 'g-main' }),
          lut({ id: 'b', name: 'Fuji', group_id: 'g-sub' }),
        ]}
      />,
    )
    // Otherwise folding the sub-group makes rows look like they went missing.
    // The count is a sibling span of the title, so assert on the toggle
    // button that contains both.
    const toggle = screen.getByRole('button', { name: /Show LUTs/ })
    expect(toggle.textContent).toContain('2')
  })

  it('keeps an unresolvable group_id visible rather than dropping the LUT', () => {
    // A shared LUT filed under another user's private group: this client can
    // never read that group's name, and the LUT must not vanish because of it.
    render(<LutSidebar {...base} luts={[lut({ id: 'a', name: 'Orphan', group_id: 'g-someone-else' })]} />)
    expect(screen.getByText('Orphan')).toBeInTheDocument()
  })

  it('keeps the shared / personal distinction', () => {
    render(
      <LutSidebar
        {...base}
        luts={[
          lut({ id: 'a', name: 'Team', shared_with_project: true }),
          lut({ id: 'b', name: 'Mine', shared_with_project: false }),
        ]}
      />,
    )
    expect(screen.getByText('In this project')).toBeInTheDocument()
    expect(screen.getByText('Your library')).toBeInTheDocument()
    expect(screen.getByText('Preview only until shared.')).toBeInTheDocument()
  })
})

describe('the panel itself', () => {
  it('is a column, not a floating menu — nothing to collide with', () => {
    render(<LutSidebar {...base} luts={[]} />)
    const panel = screen.getByTestId('lut-sidebar')
    expect(panel.className).toContain('shrink-0')
    expect(panel.className).toContain('border-r')
    expect(panel.className).not.toContain('absolute')
    expect(panel.className).not.toContain('fixed')
  })

  it('does not clamp LUT names to the old dropdown width', () => {
    render(<LutSidebar {...base} luts={[lut({ id: 'a', name: 'A Very Long LUT Name Indeed' })]} />)
    const label = screen.getByText('A Very Long LUT Name Indeed')
    expect(label.className).not.toContain('truncate')
    expect(label.className).not.toContain('max-w-')
  })

  it('offers None, and selecting it clears the LUT', async () => {
    const onSelect = vi.fn()
    render(<LutSidebar {...base} onSelect={onSelect} luts={[lut({ id: 'a' })]} />)
    await userEvent.click(screen.getByText('None'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})

describe('the toggle button', () => {
  it('carries a real background, so it survives light footage behind it', () => {
    // It previously had no bg at all — just a border and coloured text — and
    // disappeared over pale or busy frames.
    render(<LutSidebarToggle open={false} onToggle={vi.fn()} selectedName={null} />)
    const btn = screen.getByLabelText('Color LUT')
    expect(btn.className).toContain('bg-black/40')
    expect(btn.className).toContain('backdrop-blur-sm')
  })

  it('reports its state, and toggles', async () => {
    const onToggle = vi.fn()
    render(<LutSidebarToggle open onToggle={onToggle} selectedName="Kodak" />)
    const btn = screen.getByLabelText('Color LUT')
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(btn)
    expect(onToggle).toHaveBeenCalled()
  })
})
