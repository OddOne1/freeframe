/**
 * Folder-share listing: sort is the server's job, totals are link-wide
 * (CLAUDE.md §140).
 *
 * Three bugs are pinned here, and each one is asserted on the thing that
 * actually broke rather than on something adjacent:
 *
 *  - the viewer must ASK the API to sort (a request assertion), and must not
 *    re-sort what comes back (an order assertion after load-more);
 *  - the header, summary and footer must report the LINK's totals, not the
 *    number of rows loaded so far;
 *  - the size figure must come from the API's aggregate, not a sum over the
 *    loaded page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { FolderShareViewer } from '../folder-share-viewer'

const GB = 1024 ** 3

function asset(name: string, i: number, size: number) {
  return {
    id: `a-${name}`,
    name,
    asset_type: 'video',
    thumbnail_url: null,
    file_size: size,
    duration_seconds: null,
    comment_count: 0,
    created_by_name: 'Mathias',
    created_at: new Date(Date.UTC(2026, 2, 1, 12, i)).toISOString(),
    download_variants: [],
  }
}

/** Page 1 and page 2 of a 4-asset link, already in the server's order. */
const PAGE_1 = [asset('zulu', 1, 4 * GB), asset('yankee', 2, 3 * GB)]
const PAGE_2 = [asset('bravo', 3, 2 * GB), asset('alpha', 4, 1 * GB)]

const TOTAL = 4
const TOTAL_BYTES = 10 * GB

let requests: string[] = []

function mockApi(opts: { totalSizeBytes?: number | undefined } = {}) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(String(url))
      const page = /page=(\d+)/.exec(String(url))?.[1] ?? '1'
      return {
        ok: true,
        json: async () => ({
          assets: page === '1' ? PAGE_1 : PAGE_2,
          subfolders: [],
          total: TOTAL,
          ...(opts.totalSizeBytes === undefined
            ? {}
            : { total_size_bytes: opts.totalSizeBytes }),
          page: Number(page),
          per_page: 2,
        }),
      } as unknown as Response
    }),
  )
}

function renderViewer(sortBy: 'name' | 'created_at' | 'file_size' = 'name') {
  return render(
    <FolderShareViewer
      token="tok"
      shareSession={null}
      folderName="Dailies"
      title="Dailies"
      description={null}
      permission={'view' as never}
      downloadVariants={[]}
      fieldsVisibility={'disabled' as never}
      showVersions={false}
      appearance={{ layout: 'list', sort_by: sortBy } as never}
      branding={null}
    />,
  )
}

async function loadMore() {
  const btn = await screen.findByRole('button', { name: /load more/i })
  await userEvent.click(btn)
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ── B. sort ───────────────────────────────────────────────────────────────

describe('sort is delegated to the API', () => {
  it.each(['name', 'created_at', 'file_size'] as const)(
    'sends sort=%s on the initial fetch',
    async (sortBy) => {
      mockApi({ totalSizeBytes: TOTAL_BYTES })
      renderViewer(sortBy)
      await waitFor(() => expect(requests.length).toBeGreaterThan(0))
      expect(requests[0]).toContain(`sort=${sortBy}`)
    },
  )

  it('sends the same sort on load-more, not just the first page', async () => {
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer('file_size')
    await screen.findByText('zulu')
    await loadMore()
    await waitFor(() => expect(requests.length).toBe(2))
    expect(requests[1]).toContain('sort=file_size')
    expect(requests[1]).toContain('page=2')
  })

  it('refetches from page 1 when the configured sort changes', async () => {
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    const { rerender } = renderViewer('name')
    await screen.findByText('zulu')
    const before = requests.length

    rerender(
      <FolderShareViewer
        token="tok"
        shareSession={null}
        folderName="Dailies"
        title="Dailies"
        description={null}
        permission={'view' as never}
        downloadVariants={[]}
        fieldsVisibility={'disabled' as never}
        showVersions={false}
        appearance={{ layout: 'list', sort_by: 'file_size' } as never}
        branding={null}
      />,
    )
    await waitFor(() => expect(requests.length).toBeGreaterThan(before))
    expect(requests[requests.length - 1]).toContain('sort=file_size')
    expect(requests[requests.length - 1]).toContain('page=1')
  })

  it('does NOT reorder what the server returned when page 2 arrives', async () => {
    // This is the reported bug. Under a name sort the old client-side
    // comparator would hoist alpha/bravo above the already-visible
    // zulu/yankee the moment page 2 landed. Server order must survive.
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer('name')
    await screen.findByText('zulu')
    await loadMore()
    await screen.findByText('alpha')

    const shown = ['zulu', 'yankee', 'bravo', 'alpha'].map((n) =>
      screen.getByText(n),
    )
    const order = shown
      .map((el) => ({ el, top: el.compareDocumentPosition(shown[0]) }))
      .map(({ el }) => el.textContent)
    expect(order).toEqual(['zulu', 'yankee', 'bravo', 'alpha'])

    // Positional check that does not depend on textContent ordering above:
    // each name must appear after the previous one in document order.
    for (let i = 1; i < shown.length; i++) {
      expect(
        shown[i - 1].compareDocumentPosition(shown[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
  })
})

// ── C. totals ─────────────────────────────────────────────────────────────

describe('counts and size describe the link, not the loaded page', () => {
  it('shows the link total before any load-more', async () => {
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer()
    await screen.findByText('zulu')
    // 4 assets exist; only 2 are loaded. getAllByText because the count
    // legitimately renders in both the summary line and the section header.
    expect(screen.getAllByText(/\b4 Assets\b/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\b2 Assets\b/)).not.toBeInTheDocument()
  })

  it('shows the API byte total, not the sum of the loaded page', async () => {
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer()
    await screen.findByText('zulu')
    // Loaded page is 7 GB; the link is 10 GB.
    expect(screen.getByText(/10\.00 GB/)).toBeInTheDocument()
    expect(screen.queryByText(/\b7\.00 GB/)).not.toBeInTheDocument()
  })

  it('footer counts the link total, not the rows on screen', async () => {
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer()
    await screen.findByText('zulu')
    expect(screen.getByText(/^4 items$/)).toBeInTheDocument()
  })

  it('falls back to summing loaded assets when the API omits the field', async () => {
    // An API that predates total_size_bytes must not blank the figure out.
    mockApi({ totalSizeBytes: undefined })
    renderViewer()
    await screen.findByText('zulu')
    expect(screen.getByText(/7\.00 GB/)).toBeInTheDocument()
  })

  it('a search narrows the count to the matches on screen', async () => {
    // Search is client-side over loaded pages, so reporting the link-wide
    // total here would answer a question the user did not ask.
    mockApi({ totalSizeBytes: TOTAL_BYTES })
    renderViewer()
    await screen.findByText('zulu')
    const box = screen.getByPlaceholderText(/search/i)
    await userEvent.type(box, 'zulu')
    await waitFor(() =>
      expect(screen.getAllByText(/\b1 Asset\b(?!s)/).length).toBeGreaterThan(0),
    )
    expect(screen.queryByText(/\b4 Assets\b/)).not.toBeInTheDocument()
    // The link-wide byte total is hidden too, for the same reason: it
    // describes the link, and the user is now looking at one match.
    expect(screen.queryByText(/10\.00 GB/)).not.toBeInTheDocument()
  })
})
