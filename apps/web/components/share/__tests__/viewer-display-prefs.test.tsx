/**
 * Sort and card size belong to the VIEWER, not the link (§144).
 *
 * The load-bearing property is negative and easy to lose: a guest changing
 * their own view must never write back to the link's appearance, because
 * that would reorder the folder for everyone else holding the URL. So the
 * request assertions here check that no PATCH is ever sent, not only that
 * the list reorders.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { FolderShareViewer } from '../folder-share-viewer'

const asset = (name: string, i: number) => ({
  id: `a-${name}`, name, asset_type: 'image', thumbnail_url: null,
  file_size: 1000 * (i + 1), duration_seconds: null, comment_count: 0,
  created_by_name: 'M', created_at: new Date(Date.UTC(2026, 4, 1, 12, i)).toISOString(),
  download_variants: ['raw'],
})

let requests: { url: string; method: string }[] = []

function mockApi() {
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() })
    return {
      ok: true,
      json: async () => ({
        assets: [asset('one', 0), asset('two', 1)],
        subfolders: [], total: 2, total_size_bytes: 3000, page: 1, per_page: 24,
      }),
    } as unknown as Response
  }))
}

function renderViewer(appearance: Record<string, unknown> = {}) {
  return render(
    <FolderShareViewer
      token="tok" shareSession={null} folderName="F" title="F" description={null}
      permission={'view' as never} downloadVariants={['raw'] as never}
      fieldsVisibility={'disabled' as never} showVersions={false}
      appearance={{ layout: 'grid', sort_by: 'created_at', card_size: 'm', ...appearance } as never}
      branding={null}
    />,
  )
}

const sortsSent = () =>
  requests.filter(r => r.url.includes('/assets?')).map(r => /sort=([a-z_]+)/.exec(r.url)?.[1])

beforeEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  mockApi()
})

describe('defaults come from the link', () => {
  it("uses the creator's sort when the viewer has not chosen one", async () => {
    renderViewer({ sort_by: 'name' })
    await screen.findByText('one')
    expect(sortsSent()[0]).toBe('name')
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('name')
  })

  it('fetches once on mount, not twice', async () => {
    // The readiness gate exists for this: firing with the creator default
    // and then again with the stored value would double every mount.
    renderViewer()
    await screen.findByText('one')
    await new Promise(r => setTimeout(r, 50))
    expect(sortsSent()).toHaveLength(1)
  })
})

describe('the viewer can change their own view', () => {
  it('re-requests with the chosen sort', async () => {
    renderViewer()
    await screen.findByText('one')
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'file_size')
    await waitFor(() => expect(sortsSent()).toContain('file_size'))
  })

  it('changes the grid density when card size changes', async () => {
    const { container } = renderViewer()
    await screen.findByText('one')
    const before = container.querySelector('[class*="grid-cols-"]')!.className

    await userEvent.click(screen.getByLabelText('Card size L'))
    const after = container.querySelector('[class*="grid-cols-"]')!.className
    expect(after).not.toBe(before)
    expect(after).toContain('grid-cols-1')
  })

  it('NEVER writes the choice back to the share link', async () => {
    // The whole point. A PATCH here would change what every other holder
    // of this public URL sees.
    renderViewer()
    await screen.findByText('one')
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'name')
    await userEvent.click(screen.getByLabelText('Card size S'))
    await waitFor(() => expect(sortsSent()).toContain('name'))

    const mutations = requests.filter(r => r.method !== 'GET')
    expect(mutations).toEqual([])
  })

  it('offers exactly the sort keys the backend accepts', async () => {
    // A fourth option would be ignored server-side and the list would not
    // reorder — a control that looks broken rather than one that refuses.
    renderViewer()
    await screen.findByText('one')
    const opts = within(screen.getByLabelText('Sort by')).getAllByRole('option')
    expect(opts.map(o => (o as HTMLOptionElement).value)).toEqual(['name', 'created_at', 'file_size'])
  })

  it('hides the card-size control in list layout, where there are no cards', async () => {
    renderViewer({ layout: 'list' })
    await screen.findByText('one')
    expect(screen.queryByLabelText('Card size L')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Sort by')).toBeInTheDocument()
  })
})

describe('a viewer who has not chosen still follows the link', () => {
  it("tracks a change to the creator's sort until the viewer picks one", async () => {
    // Freezing the creator's value at mount would mean a link whose owner
    // changes the sort stops updating for someone already looking at it,
    // even though they never expressed a preference. §140 has a test for
    // that refetch; this keeps it true.
    const { rerender } = renderViewer({ sort_by: 'created_at' })
    await screen.findByText('one')
    expect(sortsSent()[0]).toBe('created_at')

    rerender(
      <FolderShareViewer
        token="tok" shareSession={null} folderName="F" title="F" description={null}
        permission={'view' as never} downloadVariants={['raw'] as never}
        fieldsVisibility={'disabled' as never} showVersions={false}
        appearance={{ layout: 'grid', sort_by: 'name', card_size: 'm' } as never}
        branding={null}
      />,
    )
    await waitFor(() => expect(sortsSent()).toContain('name'))
  })

  it("stops following the creator once the viewer has chosen", async () => {
    const { rerender } = renderViewer({ sort_by: 'created_at' })
    await screen.findByText('one')
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'file_size')
    await waitFor(() => expect(sortsSent()).toContain('file_size'))

    rerender(
      <FolderShareViewer
        token="tok" shareSession={null} folderName="F" title="F" description={null}
        permission={'view' as never} downloadVariants={['raw'] as never}
        fieldsVisibility={'disabled' as never} showVersions={false}
        appearance={{ layout: 'grid', sort_by: 'name', card_size: 'm' } as never}
        branding={null}
      />,
    )
    await new Promise(r => setTimeout(r, 80))
    expect(sortsSent()).not.toContain('name')
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('file_size')
  })
})

describe('persistence is per-tab and per-link', () => {
  it('stores the choice in sessionStorage under a token-scoped key', async () => {
    renderViewer()
    await screen.findByText('one')
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'name')
    await userEvent.click(screen.getByLabelText('Card size L'))
    await waitFor(() =>
      expect(window.sessionStorage.getItem('ff-share-sort:tok')).toBe('name'),
    )
    expect(window.sessionStorage.getItem('ff-share-size:tok')).toBe('l')
    // localStorage would outlive the visit; the requirement is that a fresh
    // visit shows the creator's default again.
    expect(window.localStorage.getItem('ff-share-sort:tok')).toBeNull()
  })

  it('restores a stored choice over the creator default', async () => {
    window.sessionStorage.setItem('ff-share-sort:tok', 'file_size')
    renderViewer({ sort_by: 'created_at' })
    await screen.findByText('one')
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('file_size')
    expect(sortsSent()[0]).toBe('file_size')
  })

  it('does not read another link\'s preference', async () => {
    window.sessionStorage.setItem('ff-share-sort:other-link', 'name')
    renderViewer({ sort_by: 'created_at' })
    await screen.findByText('one')
    expect((screen.getByLabelText('Sort by') as HTMLSelectElement).value).toBe('created_at')
  })

  it('ignores a stored value that is not a real sort key', async () => {
    // sessionStorage is user-writable; a junk value must not be sent to the
    // API as a sort param.
    window.sessionStorage.setItem('ff-share-sort:tok', 'name; DROP TABLE assets')
    renderViewer({ sort_by: 'created_at' })
    await screen.findByText('one')
    expect(sortsSent()[0]).toBe('created_at')
  })
})
