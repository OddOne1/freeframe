/**
 * The share-link download permission picker (CLAUDE.md §30/§30b).
 *
 * The grid layout groups the six variants as three qualities x plain/LUT.
 * That is a presentation choice, and the risk it introduces is that the
 * grouping starts behaving like a constraint — so what is asserted here is
 * that every combination remains independently selectable, and that what
 * gets emitted is always the canonical list rather than click order.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DownloadVariantPicker } from '../download-variant-picker'
import { ALL_DOWNLOAD_VARIANTS, type DownloadVariant } from '@/types'

function setup(value: DownloadVariant[] = []) {
  const onChange = vi.fn()
  render(<DownloadVariantPicker value={value} onChange={onChange} />)
  return { onChange, user: userEvent.setup() }
}

describe('every variant is reachable', () => {
  it('renders a control for all six', () => {
    setup()
    expect(screen.getAllByRole('checkbox')).toHaveLength(6)
  })

  it.each(ALL_DOWNLOAD_VARIANTS)('can turn on %s from empty', async (v) => {
    const { onChange, user } = setup([])
    const labels: Record<DownloadVariant, string> = {
      raw: 'Original',
      raw_lut: 'Original + LUT',
      proxy_720p: 'Proxy 720p',
      proxy_720p_lut: 'Proxy 720p + LUT',
      proxy_1080p: 'Proxy 1080p',
      proxy_1080p_lut: 'Proxy 1080p + LUT',
    }
    await user.click(screen.getByRole('checkbox', { name: labels[v] }))
    expect(onChange).toHaveBeenCalledWith([v])
  })
})

describe('the grid groups without constraining', () => {
  it('allows a LUT variant without its plain counterpart', async () => {
    const { onChange, user } = setup([])
    await user.click(screen.getByRole('checkbox', { name: 'Proxy 720p + LUT' }))
    expect(onChange).toHaveBeenCalledWith(['proxy_720p_lut'])
  })

  it('does not turn on a whole quality row at once', async () => {
    const { onChange, user } = setup([])
    await user.click(screen.getByRole('checkbox', { name: 'Proxy 1080p' }))
    expect(onChange).toHaveBeenCalledWith(['proxy_1080p'])
  })
})

describe('what it emits', () => {
  it('is canonically ordered, not click-ordered', async () => {
    const { onChange, user } = setup(['proxy_1080p'])
    await user.click(screen.getByRole('checkbox', { name: 'Original' }))
    // "raw" precedes "proxy_1080p" in the canonical order even though it
    // was clicked second — otherwise two links permitting the same things
    // would store different lists.
    expect(onChange).toHaveBeenCalledWith(['raw', 'proxy_1080p'])
  })

  it('removes rather than duplicating when a checked box is clicked', async () => {
    const { onChange, user } = setup(['raw', 'proxy_720p'])
    await user.click(screen.getByRole('checkbox', { name: 'Original' }))
    expect(onChange).toHaveBeenCalledWith(['proxy_720p'])
  })

  it('can reach empty, which is how downloads get turned off', async () => {
    const { onChange, user } = setup(['raw'])
    await user.click(screen.getByRole('checkbox', { name: 'Original' }))
    expect(onChange).toHaveBeenCalledWith([])
  })
})

describe('it says what the current state means', () => {
  it('spells out that empty means downloads are off', () => {
    setup([])
    expect(screen.getByText(/downloads are off/i)).toBeInTheDocument()
  })

  it('reflects the checked state it was given', () => {
    setup(['raw', 'proxy_720p_lut'])
    expect(screen.getByRole('checkbox', { name: 'Original' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: 'Proxy 720p + LUT' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: 'Proxy 720p' })).toHaveAttribute('aria-checked', 'false')
  })
})
