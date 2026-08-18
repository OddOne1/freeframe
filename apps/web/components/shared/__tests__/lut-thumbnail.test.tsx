import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LutThumbnail } from '../lut-thumbnail'
import { REFERENCE_IMAGE_SRC } from '@/lib/lut/lut-thumbnail'

const renderLutThumbnail = vi.fn()
const getCachedLutThumbnail = vi.fn<(id: string) => string | null>()

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.png',
  renderLutThumbnail: (id: string, url: string | null) => renderLutThumbnail(id, url),
  getCachedLutThumbnail: (id: string) => getCachedLutThumbnail(id),
}))

const LUT = { id: 'lut-1', file_url: '/luts/one.cube' }

beforeEach(() => {
  renderLutThumbnail.mockReset()
  getCachedLutThumbnail.mockReset()
  getCachedLutThumbnail.mockReturnValue(null)
  renderLutThumbnail.mockResolvedValue('data:image/png;base64,graded')
})

describe('LutThumbnail', () => {
  it('renders its frame immediately and fills the swatch in after', async () => {
    // The point of the whole design: a list never waits on WebGL to show text.
    const { container } = render(<LutThumbnail lut={LUT} />)
    expect(screen.getByTestId('lut-thumbnail')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()

    await waitFor(() => {
      expect(container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/png;base64,graded',
      )
    })
    expect(renderLutThumbnail).toHaveBeenCalledWith('lut-1', '/luts/one.cube')
  })

  it('paints an already-rendered swatch on the first frame, with no flash', () => {
    getCachedLutThumbnail.mockReturnValue('data:image/png;base64,cached')
    const { container } = render(<LutThumbnail lut={LUT} />)

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,cached',
    )
    expect(renderLutThumbnail).not.toHaveBeenCalled()
  })

  it('shows the ungraded reference frame for the "None" row', () => {
    const { container } = render(<LutThumbnail lut={null} />)
    expect(container.querySelector('img')).toHaveAttribute('src', REFERENCE_IMAGE_SRC)
    expect(renderLutThumbnail).not.toHaveBeenCalled()
  })

  it('stays an empty placeholder when the LUT will not render', async () => {
    renderLutThumbnail.mockRejectedValue(new Error('no WebGL2'))
    const { container } = render(<LutThumbnail lut={LUT} />)

    await waitFor(() => expect(renderLutThumbnail).toHaveBeenCalled())
    // An ungraded frame shown as a grade would be worse than no swatch.
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('lut-thumbnail')).toBeInTheDocument()
  })

  it('swaps to the new LUT rather than keeping the old swatch', async () => {
    const { container, rerender } = render(<LutThumbnail lut={LUT} />)
    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/png;base64,graded',
      ),
    )

    let resolveSecond: (v: string) => void = () => {}
    renderLutThumbnail.mockReturnValue(new Promise<string>((r) => { resolveSecond = r }))
    rerender(<LutThumbnail lut={{ id: 'lut-2', file_url: '/luts/two.cube' }} />)

    // lut-2's swatch is not ready, and lut-1's must not stand in for it.
    expect(container.querySelector('img')).toBeNull()
    resolveSecond('data:image/png;base64,second')
    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/png;base64,second',
      ),
    )
  })

  it('takes its size from the caller', () => {
    render(<LutThumbnail lut={null} className="h-4 w-6" />)
    expect(screen.getByTestId('lut-thumbnail')).toHaveClass('h-4', 'w-6')
  })
})
