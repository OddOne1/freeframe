/**
 * The click-to-zoom view behind a Settings row's swatch (CLAUDE.md §36).
 *
 * The failure worth pinning is the one the spec calls out: a zoom that shows
 * the cached 48px swatch scaled up. So these assert which render the dialog
 * asks for, not just that an image appears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LutPreviewDialog } from '../lut-preview-dialog'

const renderLutPreview = vi.fn()
const renderLutThumbnail = vi.fn()
const getCachedLutPreview = vi.fn<(id: string) => string | null>()

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutPreview: (id: string, url: string | null) => renderLutPreview(id, url),
  getCachedLutPreview: (id: string) => getCachedLutPreview(id),
  renderLutThumbnail: (id: string, url: string | null) => renderLutThumbnail(id, url),
  getCachedLutThumbnail: () => null,
}))

const LUT = { id: 'lut-1', name: 'Kodak 2383', file_url: '/luts/one.cube' } as never

beforeEach(() => {
  renderLutPreview.mockReset()
  renderLutThumbnail.mockReset()
  getCachedLutPreview.mockReset()
  getCachedLutPreview.mockReturnValue(null)
  renderLutPreview.mockResolvedValue('data:image/jpeg;base64,large')
})

describe('LutPreviewDialog', () => {
  it('renders nothing until a LUT is passed', () => {
    render(<LutPreviewDialog lut={null} onOpenChange={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(renderLutPreview).not.toHaveBeenCalled()
  })

  it('asks for the large render, never the row swatch', async () => {
    render(<LutPreviewDialog lut={LUT} onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(screen.getByTestId('lut-preview-frame').querySelector('img')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,large',
      ),
    )
    expect(renderLutPreview).toHaveBeenCalledWith('lut-1', '/luts/one.cube')
    // Upscaling the cached thumbnail is exactly what this view exists to avoid.
    expect(renderLutThumbnail).not.toHaveBeenCalled()
  })

  it('spins while the render is in flight rather than showing an empty box', () => {
    renderLutPreview.mockReturnValue(new Promise(() => {}))
    render(<LutPreviewDialog lut={LUT} onOpenChange={() => {}} />)

    const frame = screen.getByTestId('lut-preview-frame')
    expect(frame.querySelector('img')).toBeNull()
    expect(frame.querySelector('svg')).toBeInTheDocument()
  })

  it('says so when the LUT cannot be rendered, instead of spinning forever', async () => {
    renderLutPreview.mockRejectedValue(new Error('no WebGL2'))
    render(<LutPreviewDialog lut={LUT} onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(screen.getByText(/could not be previewed/i)).toBeInTheDocument(),
    )
    expect(screen.getByTestId('lut-preview-frame').querySelector('img')).toBeNull()
  })

  it('shows the ungraded frame beside it, so the grade reads as a difference', async () => {
    render(<LutPreviewDialog lut={LUT} onOpenChange={() => {}} />)
    await waitFor(() => expect(renderLutPreview).toHaveBeenCalled())

    // Radix portals the content, so this reads the document, not the container.
    const dialog = screen.getByRole('dialog')
    const sources = Array.from(dialog.querySelectorAll('img')).map((i) => i.getAttribute('src'))
    expect(sources).toContain('/lut-reference.jpg')
    expect(screen.getByText('Ungraded')).toBeInTheDocument()
  })

  it('names the LUT and closes on the close button', async () => {
    const onOpenChange = vi.fn()
    render(<LutPreviewDialog lut={LUT} onOpenChange={onOpenChange} />)

    expect(screen.getByRole('heading', { name: 'Kodak 2383' })).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('paints an already-rendered zoom with no spinner', () => {
    getCachedLutPreview.mockReturnValue('data:image/jpeg;base64,cached')
    render(<LutPreviewDialog lut={LUT} onOpenChange={() => {}} />)

    expect(screen.getByTestId('lut-preview-frame').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,cached',
    )
    expect(renderLutPreview).not.toHaveBeenCalled()
  })
})
