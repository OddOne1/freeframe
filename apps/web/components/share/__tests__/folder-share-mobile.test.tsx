/**
 * The public share view collapses to one column on mobile (§142).
 *
 * The reported symptom was a 320px right panel eating most of a 390px
 * screen, leaving the asset list a sliver and filling the rest with that
 * panel's own "select an asset" empty state.
 *
 * Two halves, and the second is the one a CSS-only fix would miss: below
 * xl there is no panel, so a tap has nowhere to show a selection and must
 * open the asset instead. That is behaviour, not layout, so it is asserted
 * through a real click rather than by reading class names.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { FolderShareViewer } from '../folder-share-viewer'

const asset = (name: string, i: number) => ({
  id: `a-${name}`, name, asset_type: 'image', thumbnail_url: null,
  file_size: 1024 * (i + 1), duration_seconds: null, comment_count: 0,
  created_by_name: 'M', created_at: new Date(Date.UTC(2026, 2, 1, 12, i)).toISOString(),
  download_variants: ['raw'],
})

/** jsdom has no layout engine, so matchMedia is what the component reads. */
function setViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({
    matches: wide && q.includes('1280'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })))
}

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => String(url).includes('/assets?')
      ? { assets: [asset('one', 0), asset('two', 1)], subfolders: [],
          total: 2, total_size_bytes: 3072, page: 1, per_page: 24 }
      : { url: '/stream/hls/x?token=t' },
  } as unknown as Response)))
}

function renderViewer(openInViewer = true) {
  return render(
    <FolderShareViewer
      token="tok" shareSession={null} folderName="Dailies" title="Dailies"
      description={null} permission={'view' as never}
      downloadVariants={['raw'] as never} fieldsVisibility={'disabled' as never}
      showVersions={false}
      appearance={{ layout: 'list', sort_by: 'name', open_in_viewer: openInViewer } as never}
      branding={null}
    />,
  )
}

beforeEach(() => { vi.unstubAllGlobals(); mockApi() })

describe('below xl (phone / tablet)', () => {
  it('tapping an asset opens it full-screen instead of selecting into a panel', async () => {
    setViewport(false)
    mockApi()
    renderViewer()
    await screen.findByText('one')
    // "Download All" belongs to the browse chrome and is absent in the
    // full-screen viewer — a stabler discriminator than the word "Assets",
    // which appears in several places.
    expect(screen.getByRole('button', { name: /download all/i })).toBeInTheDocument()

    await userEvent.click(screen.getByText('one'))

    // The viewer is a full-screen overlay; its inner player loads lazily,
    // so assert on the overlay rather than on content that arrives later.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /download all/i })).not.toBeInTheDocument(),
    )
    expect(document.querySelector('.fixed.inset-0.z-50')).toBeTruthy()
  })

  it('honours open_in_viewer: false rather than overriding the link owner', async () => {
    // A link configured not to open assets still does not open them on a
    // phone. Worth pinning: the tempting "just always open on mobile" would
    // quietly override a sharer's explicit choice.
    setViewport(false)
    mockApi()
    renderViewer(false)
    await screen.findByText('one')
    await userEvent.click(screen.getByText('one'))
    // still browsing
    expect(screen.getByRole('button', { name: /download all/i })).toBeInTheDocument()
  })
})

describe('xl and up (desktop) is unchanged', () => {
  it('tapping an asset selects it rather than opening the viewer', async () => {
    setViewport(true)
    mockApi()
    renderViewer()
    await screen.findByText('one')
    await userEvent.click(screen.getByText('one'))
    // the browse chrome is still there — we did not navigate into the viewer
    expect(screen.getByRole('button', { name: /download all/i })).toBeInTheDocument()
  })
})

describe('the right panel below xl — §224 replaced §142’s `hidden xl:flex`', () => {
  /* §142 solved a 320px panel squeezing a 390px screen by removing the
     panel below `xl` outright, and hiding its toggle with it. That left no
     way to see an asset's comments or fields on any screen under 1280px,
     and a toggle that was simply absent. §224 makes it a drawer instead:
     the list is still never squeezed, and the panel is reachable.

     Asserted through the toggle and the rendered panel rather than by
     matching class strings, because the class strings are exactly what
     changed and a test that reads them only ever pins the current spelling. */

  it('starts closed, so the asset list is not covered on arrival', async () => {
    setViewport(false)
    mockApi()
    renderViewer()
    await screen.findByText('one')
    expect(screen.queryByTestId('share-right-panel')).not.toBeInTheDocument()
  })

  it('offers a toggle that actually reveals the panel', async () => {
    setViewport(false)
    mockApi()
    renderViewer()
    await screen.findByText('one')

    // The control §142 hid. It must exist below xl…
    const toggle = screen.getByTestId('share-panel-toggle')
    expect(toggle).toBeInTheDocument()

    // …and do something when pressed.
    await userEvent.click(toggle)
    const panel = await screen.findByTestId('share-right-panel')
    // Not `hidden`: the whole bug was a panel that was rendered-but-hidden
    // (or not rendered) at exactly the widths where it was needed.
    expect(panel.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    // It overlays rather than sits in flow, which is what keeps §142's own
    // guarantee — the list behind it keeps its full width.
    expect(panel.className).toMatch(/\bfixed\b/)
  })

  it('the scrim closes it again', async () => {
    setViewport(false)
    mockApi()
    renderViewer()
    await screen.findByText('one')
    await userEvent.click(screen.getByTestId('share-panel-toggle'))
    await screen.findByTestId('share-right-panel')

    await userEvent.click(screen.getByTestId('share-panel-scrim'))
    await waitFor(() =>
      expect(screen.queryByTestId('share-right-panel')).not.toBeInTheDocument(),
    )
  })

  it('at xl it is a column in the layout, open from the start', async () => {
    setViewport(true)
    mockApi()
    renderViewer()
    await screen.findByText('one')
    const panel = await screen.findByTestId('share-right-panel')
    // `xl:static` is what puts it back in flow beside the list; there is no
    // scrim at this width because nothing is being overlaid.
    expect(panel.className).toMatch(/xl:static/)
    expect(screen.getByTestId('share-panel-scrim').className).toMatch(/xl:hidden/)
  })

  it('the full-screen viewer stacks its comments pane below the media', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'components/share/folder-share-viewer.tsx'), 'utf8')
    expect(src).toMatch(/flex flex-col xl:flex-row flex-1 overflow-hidden min-h-0/)
    expect(src).toMatch(/w-full xl:w-\[360px\]/)
  })
})
