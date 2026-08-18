/**
 * The share-link Fields level control (CLAUDE.md §33).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldsVisibilityPicker } from '../fields-visibility-picker'
import type { FieldsVisibility } from '@/types'

function setup(value: FieldsVisibility = 'disabled') {
  const onChange = vi.fn()
  render(<FieldsVisibilityPicker value={value} onChange={onChange} />)
  return { onChange, user: userEvent.setup() }
}

describe('all three levels are reachable', () => {
  it('offers exactly three, not a boolean', () => {
    setup()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it.each([
    ['Off', 'disabled'],
    ['Basic', 'basic'],
    ['Full', 'full'],
  ] as const)('selecting %s emits %s', async (label, value) => {
    const { onChange, user } = setup(value === 'disabled' ? 'full' : 'disabled')
    await user.click(screen.getByRole('radio', { name: label }))
    expect(onChange).toHaveBeenCalledWith(value)
  })
})

describe('it reflects the level it was given', () => {
  it('marks only the active level', () => {
    setup('basic')
    expect(screen.getByRole('radio', { name: 'Basic' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Full' })).toHaveAttribute('aria-checked', 'false')
  })
})

describe('it explains what Full actually includes', () => {
  it('names the exclusions rather than implying "everything"', () => {
    setup('full')
    const hint = screen.getByText(/technical metadata/i)
    expect(hint.textContent).toMatch(/never includes/i)
    expect(hint.textContent).toMatch(/custom fields/i)
  })
})
