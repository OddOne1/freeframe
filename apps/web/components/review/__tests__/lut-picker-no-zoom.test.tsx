/**
 * The picker keeps one click meaning (CLAUDE.md §36).
 *
 * Zoom is deliberately Settings-only: a picker row's whole job is to select
 * the LUT, so a swatch that also opened a dialog would make the same click
 * ambiguous. This pins that decision, since the obvious "make it consistent"
 * follow-up is exactly what it rules out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LutPicker } from '../lut-picker'

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutThumbnail: () => Promise.resolve('data:image/png;base64,small'),
  getCachedLutThumbnail: () => 'data:image/png;base64,small',
  renderLutPreview: () => Promise.reject(new Error('the picker must not ask for this')),
  getCachedLutPreview: () => null,
}))

const LUTS = [
  {
    id: 'lut-1',
    name: 'Kodak 2383',
    file_url: '/luts/one.cube',
    lut_size: 33,
    shared_with_project: true,
  },
] as never[]

beforeEach(() => {
  // Radix needs these in jsdom to open a dropdown.
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.HTMLElement.prototype.hasPointerCapture = vi.fn()
})

describe('LutPicker', () => {
  it('selects on click, with no zoom trigger competing for it', async () => {
    const onSelect = vi.fn()
    render(<LutPicker luts={LUTS} selectedId={null} onSelect={onSelect} />)

    await userEvent.click(screen.getByLabelText('Color LUT'))
    const item = await screen.findByText('Kodak 2383')

    // No preview button anywhere in the menu — the swatch is decorative here.
    expect(screen.queryByLabelText(/^Preview /)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(item)
    expect(onSelect).toHaveBeenCalledWith('lut-1')
  })
})
