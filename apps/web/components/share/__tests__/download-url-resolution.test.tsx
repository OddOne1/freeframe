/**
 * Download URLs get the /api prefix exactly once (§141).
 *
 * `proxy_url_for()` returns a RELATIVE path. Every download path has to
 * push it through `resolveApiMediaUrl()` before it reaches an <iframe> or
 * an <a>, or the browser resolves it against the page origin and 404s.
 *
 * The other half matters just as much and is asserted here too: resolving
 * TWICE is its own bug. With NEXT_PUBLIC_API_URL='/api' the resolved
 * string still begins with '/', so a second pass yields '/api/api/...' —
 * the exact shape §32 and §139 were filed for. So these tests pin "exactly
 * one prefix", not merely "has a prefix".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { DownloadMenu } from '../download-menu'
import { FolderShareViewer } from '../folder-share-viewer'
import { resolveApiMediaUrl } from '@/lib/utils'

const RELATIVE = '/stream/hls/original.tiff?token=abc&download=photo.tiff'

/** Every src an <iframe> or <a> was pointed at during a test. */
let hrefs: string[] = []

function captureNavigations() {
  hrefs = []
  const realCreate = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreate(tag)
    if (tag === 'iframe' || tag === 'a') {
      const prop = tag === 'iframe' ? 'src' : 'href'
      Object.defineProperty(el, prop, {
        set(v: string) { hrefs.push(v) },
        get() { return hrefs[hrefs.length - 1] },
        configurable: true,
      })
      // clicking an <a> must not actually navigate jsdom
      if (tag === 'a') (el as HTMLAnchorElement).click = () => {}
    }
    return el
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  hrefs = []
})

// ── the rule itself ───────────────────────────────────────────────────────

describe('resolveApiMediaUrl', () => {
  it('prefixes a relative proxy path', () => {
    expect(resolveApiMediaUrl(RELATIVE)).toBe(`/api${RELATIVE}`)
  })

  it('is NOT idempotent under a relative API base — so resolve exactly once', () => {
    // This is documentation as much as assertion: it is why the fix resolves
    // at one boundary per path instead of defensively everywhere.
    const once = resolveApiMediaUrl(RELATIVE)!
    expect(resolveApiMediaUrl(once)).toBe(`/api/api${RELATIVE}`)
  })
})

// ── share: DownloadMenu ───────────────────────────────────────────────────

describe('share DownloadMenu', () => {
  it('resolves the raw download URL exactly once', async () => {
    captureNavigations()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ url: RELATIVE }),
    } as unknown as Response)))

    render(<DownloadMenu token="tok" assetId="a1" variants={['raw'] as never} iconOnly={false} />)
    await userEvent.click(screen.getByRole('button', { name: /download/i }))

    await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
    expect(hrefs[0]).toBe(`/api${RELATIVE}`)
    expect(hrefs[0]).not.toContain('/api/api')
    expect(hrefs[0].startsWith('/stream/')).toBe(false)
  })
})

// ── share: "Download All", the reported path ──────────────────────────────

describe('share viewer "Download All"', () => {
  it('opens the batch dialog instead of firing one download per file', async () => {
    // §143 deliberately replaced this path. It used to trigger N staggered
    // iframe downloads — which is what made the browser re-prompt once per
    // remaining file — and now collects the selection and hands it to the
    // zip dialog. The §141 rule this file exists for (resolve the proxy URL
    // exactly once) still applies, but to the ONE zip URL, and is asserted
    // where that download happens: batch-download-dialog.test.tsx plus
    // triggerBrowserDownload's own tests above.
    captureNavigations()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/assets?')) {
        return { ok: true, json: async () => ({
          assets: [
            { id: 'a1', name: 'one', asset_type: 'image', thumbnail_url: null,
              file_size: 10, duration_seconds: null, comment_count: 0,
              created_by_name: 'M', created_at: new Date().toISOString(),
              download_variants: ['raw'] },
            // TWO, since §177: a link holding exactly one asset now hands
            // that asset over directly (an archive containing one file is
            // not a batch — see the test below), so a one-asset fixture
            // would no longer exercise the dialog this test is about.
            { id: 'a2', name: 'two', asset_type: 'image', thumbnail_url: null,
              file_size: 10, duration_seconds: null, comment_count: 0,
              created_by_name: 'M', created_at: new Date().toISOString(),
              download_variants: ['raw'] },
          ],
          subfolders: [], total: 2, total_size_bytes: 20, page: 1, per_page: 24,
        }) } as unknown as Response
      }
      if (u.includes('/zip/options')) {
        return { ok: true, json: async () => ({
          variants: ['raw'],
          assets: [
            { asset_id: 'a1', asset_name: 'one', versions: [] },
            { asset_id: 'a2', asset_name: 'two', versions: [] },
          ],
        }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ url: RELATIVE }) } as unknown as Response
    }))

    render(
      <FolderShareViewer
        token="tok" shareSession={null} folderName="F" title="F"
        description={null} permission={'view' as never}
        downloadVariants={['raw'] as never} fieldsVisibility={'disabled' as never}
        showVersions={false} appearance={{ layout: 'list', sort_by: 'name' } as never}
        branding={null}
      />,
    )
    await screen.findByText('one')
    await userEvent.click(screen.getByRole('button', { name: /download all/i }))

    // A dialog, and crucially NOT a download per file.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(hrefs).toEqual([])
  })

  it('hands over the file itself when the link holds exactly one (§177)', async () => {
    // The popup-spam bug §143 fixed cannot happen with one file, and an
    // archive the viewer has to unpack to reach a single image is worse
    // than the image. The §141 resolution rule still has to hold on that
    // direct URL, which is why this lives in this file.
    captureNavigations()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/assets?')) {
        return { ok: true, json: async () => ({
          assets: [
            { id: 'a1', name: 'one', asset_type: 'image', thumbnail_url: null,
              file_size: 10, duration_seconds: null, comment_count: 0,
              created_by_name: 'M', created_at: new Date().toISOString(),
              download_variants: ['raw'] },
          ],
          subfolders: [], total: 1, total_size_bytes: 10, page: 1, per_page: 24,
        }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ url: RELATIVE }) } as unknown as Response
    }))

    render(
      <FolderShareViewer
        token="tok" shareSession={null} folderName="F" title="F"
        description={null} permission={'view' as never}
        downloadVariants={['raw'] as never} fieldsVisibility={'disabled' as never}
        showVersions={false} appearance={{ layout: 'list', sort_by: 'name' } as never}
        branding={null}
      />,
    )
    await screen.findByText('one')
    await userEvent.click(screen.getByRole('button', { name: /download all/i }))

    await waitFor(() => expect(hrefs.length).toBe(1))
    expect(hrefs[0]).toBe(`/api${RELATIVE}`)
    expect(hrefs[0]).not.toContain('/api/api')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ── every download path, including the ones a component test cannot reach ─

describe('one download helper, used everywhere', () => {
  it('triggerBrowserDownload resolves exactly once and refuses empty input', async () => {
    captureNavigations()
    const { triggerBrowserDownload } = await import('@/lib/download')

    expect(triggerBrowserDownload(RELATIVE)).toBe(true)
    expect(hrefs).toEqual([`/api${RELATIVE}`])

    expect(triggerBrowserDownload(null)).toBe(false)
    expect(triggerBrowserDownload('')).toBe(false)
    expect(hrefs).toHaveLength(1)
  })

  it('no download path hand-rolls its own iframe', async () => {
    // Structural, and it earns its place: this bug existed because six
    // copies of "create an iframe, set .src" drifted, and three forgot to
    // resolve. With one helper there is one place to get right — so the
    // invariant worth pinning is that nobody re-rolls it.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const files = [
      'components/share/download-menu.tsx',
      'components/share/folder-share-viewer.tsx',
      'app/(dashboard)/projects/[id]/page.tsx',
      'app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx',
    ]
    const offenders: string[] = []
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(process.cwd(), f), 'utf8')
      if (!src.includes('download=true') && !src.includes('lut-export')) continue
      src.split('\n').forEach((line, i) => {
        if (/createElement\((["'])iframe\1\)/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      `download iframe built by hand instead of triggerBrowserDownload:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
