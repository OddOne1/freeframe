/**
 * §241 item 3 — Recently Deleted, rebuilt on §240's API.
 *
 * What the old view was: every deleted row in the project, folders and
 * assets in two separate lists, no search, no filters, no sort, no sizes,
 * no deleter, no total, and a "page 2" that meant the second page of each
 * list. What these tests hold is the list a person can read:
 *
 *  * the controls become QUERY PARAMETERS — one request per pause in
 *    typing, `kind`, `deleted_by`, `sort`+`order` and `include_nested`
 *    exactly as §240 named them, and `offset` rather than the deprecated
 *    `skip`;
 *  * the row says the four things the old one could not: where it lived,
 *    who deleted it, how long is left (coloured from a week out) and how
 *    big it is;
 *  * a VERSION row cannot be mistaken for a file of its own;
 *  * Restore and Delete Permanently are rendered from the server's flags,
 *    never re-derived;
 *  * an empty trash and an empty FILTER are different states with
 *    different words, because for an editor the first one is normal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'
import { SWRConfig } from 'swr'
import { ToastProvider } from '@/components/shared/toast'
import type { TrashEntry } from '@/types'

const PROJECT = 'proj-1'

let response: Record<string, unknown> = {}
const get = vi.fn(async (_path: string) => response)

vi.mock('@/lib/api', () => ({
  api: { get: (p: string) => get(p), post: vi.fn(async () => ({})) },
  ApiError: class extends Error {},
}))

import { RecentlyDeleted, expiryState, trashEntryTitle } from '../recently-deleted'

const entry = (over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: 'a-1',
  kind: 'asset',
  name: 'Opening shot.mov',
  deleted_at: '2026-10-20T09:00:00Z',
  expires_at: '2026-11-19T09:00:00Z',
  deleted_by: { id: 'u-1', name: 'Mathias' },
  original_folder_id: 'f-1',
  original_path: 'Day 1 / Selects',
  size_bytes: 2_000_000,
  can_restore: true,
  can_purge: false,
  child_count: 0,
  asset_type: 'video',
  asset_id: null,
  version_number: null,
  ...over,
})

function body(items: TrashEntry[], over: Record<string, unknown> = {}) {
  return {
    items,
    total: items.length,
    retention_days: 30,
    deleters: [{ id: 'u-1', name: 'Mathias' }],
    unknown_deleter_present: false,
    folders: [],
    assets: [],
    ...over,
  }
}

const handlers = () => ({
  onPurge: vi.fn(),
  onRestoreAsset: vi.fn().mockResolvedValue(undefined),
  onRestoreFolder: vi.fn().mockResolvedValue(undefined),
  onRestoreVersion: vi.fn().mockResolvedValue(undefined),
})

function renderView(props: Partial<React.ComponentProps<typeof RecentlyDeleted>> = {}) {
  const h = handlers()
  const utils = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>
        <RecentlyDeleted projectId={PROJECT} {...h} {...props} />
      </ToastProvider>
    </SWRConfig>,
  )
  return { ...utils, ...h }
}

/** The paths asked for so far, newest last. */
const paths = () => get.mock.calls.map((c) => c[0] as string)
const lastPath = () => paths()[paths().length - 1]

beforeEach(() => {
  get.mockClear()
  response = body([entry()])
})

// ─── The controls become the request ─────────────────────────────────────

describe('search', () => {
  it('waits for a pause before asking, then sends q once', async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    const before = paths().length

    await user.type(screen.getByTestId('trash-search'), 'clip')
    // Four keystrokes and not one request yet: the debounce is what makes
    // this a search box rather than a request per character.
    expect(paths().length).toBe(before)

    await waitFor(() => expect(lastPath()).toContain('q=clip'))
    expect(paths().filter((p) => p.includes('q=')).length).toBe(1)
  })

  it('leaves q out of the key when the box is empty', async () => {
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(lastPath()).toBe(`/projects/${PROJECT}/trash?order=desc&limit=25`)
  })
})

describe('the filter and sort controls', () => {
  it('send kind, deleted_by, sort+order and include_nested', async () => {
    const user = userEvent.setup()
    response = body([entry()], {
      deleters: [
        { id: 'u-1', name: 'Mathias' },
        { id: 'u-2', name: 'Pat' },
      ],
    })
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    const bar = screen.getByTestId('trash-controls-bar')

    await user.selectOptions(within(bar).getByTestId('trash-kind'), 'version')
    await waitFor(() => expect(lastPath()).toContain('kind=version'))

    await user.selectOptions(within(bar).getByTestId('trash-deleter'), 'u-2')
    await waitFor(() => expect(lastPath()).toContain('deleted_by=u-2'))

    await user.selectOptions(within(bar).getByTestId('trash-sort'), 'largest')
    await waitFor(() => expect(lastPath()).toContain('sort=size'))
    expect(lastPath()).toContain('order=desc')

    await user.click(within(bar).getByTestId('trash-nested'))
    await waitFor(() => expect(lastPath()).toContain('include_nested=true'))
  })

  it('maps each of the six orderings to its own sort and order', async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    const sort = within(screen.getByTestId('trash-controls-bar')).getByTestId('trash-sort')

    const expected: [string, string][] = [
      ['oldest', 'order=asc'],
      ['name_asc', 'sort=name'],
      ['name_desc', 'order=desc'],
      ['largest', 'sort=size'],
      ['expiring', 'sort=expires_at'],
    ]
    for (const [value, fragment] of expected) {
      await user.selectOptions(sort, value)
      await waitFor(() => expect(lastPath()).toContain(fragment))
    }
    // "Newest deleted" is the API's own default, so it is not spelled out.
    await user.selectOptions(sort, 'newest')
    await waitFor(() => expect(lastPath()).not.toContain('sort='))
  })

  it('offers "Unknown" only when the server says such rows exist', async () => {
    response = body([entry()], {
      deleters: [{ id: 'u-1', name: 'Mathias' }],
      unknown_deleter_present: true,
    })
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    const bar = screen.getByTestId('trash-controls-bar')
    expect(
      within(within(bar).getByTestId('trash-deleter')).getByRole('option', {
        name: 'Unknown',
      }),
    ).toBeInTheDocument()
  })

  it('hides "Deleted by" entirely for an editor, who can only see their own', async () => {
    response = body([entry()], { deleters: [{ id: 'u-1', name: 'Mathias' }] })
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByTestId('trash-deleter')).not.toBeInTheDocument()
  })

  it('renders the same controls in the phone sheet', async () => {
    const user = userEvent.setup()
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())

    await user.click(screen.getByTestId('trash-filter-sheet-trigger'))
    const sheet = await screen.findByTestId('trash-controls-sheet')
    expect(within(sheet).getByTestId('trash-kind-sheet')).toBeInTheDocument()
    expect(within(sheet).getByTestId('trash-sort-sheet')).toBeInTheDocument()
    expect(within(sheet).getByTestId('trash-nested-sheet')).toBeInTheDocument()

    await user.selectOptions(within(sheet).getByTestId('trash-kind-sheet'), 'folder')
    await waitFor(() => expect(lastPath()).toContain('kind=folder'))
  })
})

describe('paging', () => {
  it('walks pages with offset and reports the range out of total', async () => {
    const user = userEvent.setup()
    const page = Array.from({ length: 25 }, (_, i) =>
      entry({ id: `a-${i}`, name: `Clip ${i}` }),
    )
    response = body(page, { total: 60 })
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())

    expect(screen.getByTestId('trash-range')).toHaveTextContent('1–25 of 60')
    expect(screen.getByTestId('trash-prev-page')).toBeDisabled()

    await user.click(screen.getByTestId('trash-next-page'))
    await waitFor(() => expect(lastPath()).toContain('offset=25'))
    // `skip` is deprecated in §240; nothing here may send it.
    expect(lastPath()).not.toContain('skip=')
    expect(screen.getByTestId('trash-range')).toHaveTextContent('26–50 of 60')
  })

  it('does not page at all when everything fits', async () => {
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByTestId('trash-next-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('trash-range')).toHaveTextContent('1–1 of 1')
  })

  it('returns to the first page when the filters change', async () => {
    const user = userEvent.setup()
    response = body(
      Array.from({ length: 25 }, (_, i) => entry({ id: `a-${i}` })),
      { total: 60 },
    )
    renderView()
    await waitFor(() => expect(get).toHaveBeenCalled())
    await user.click(screen.getByTestId('trash-next-page'))
    await waitFor(() => expect(lastPath()).toContain('offset=25'))

    await user.selectOptions(
      within(screen.getByTestId('trash-controls-bar')).getByTestId('trash-kind'),
      'asset',
    )
    await waitFor(() => expect(lastPath()).toContain('kind=asset'))
    expect(lastPath()).not.toContain('offset=')
  })
})

// ─── What a row says ─────────────────────────────────────────────────────

describe('a row', () => {
  it('shows the original location, the deleter, the size and the days left', async () => {
    renderView()
    const row = await screen.findByTestId('trash-row-a-1')
    expect(row).toHaveTextContent('Opening shot.mov')
    expect(row).toHaveTextContent('in Day 1 / Selects')
    expect(within(row).getByTestId('trash-deleter-a-1')).toHaveTextContent(
      'Deleted by Mathias',
    )
    expect(within(row).getByTestId('trash-size-a-1')).toHaveTextContent(/MB|MiB/)
    expect(within(row).getByTestId('trash-expiry-a-1')).toHaveTextContent(/day/)
  })

  it('says "Unknown" for a row deleted before the deleter was recorded', async () => {
    response = body([entry({ deleted_by: null })])
    renderView()
    expect(await screen.findByTestId('trash-deleter-a-1')).toHaveTextContent(
      'Deleted by Unknown',
    )
  })

  it('says the project root when there was no folder', async () => {
    response = body([entry({ original_path: '', original_folder_id: null })])
    renderView()
    expect(await screen.findByTestId('trash-row-a-1')).toHaveTextContent(
      'in the project root',
    )
  })

  it('colours the countdown amber from a week out and red in the last days', () => {
    const now = Date.parse('2026-10-20T00:00:00Z')
    const at = (days: number) =>
      new Date(now + days * 24 * 60 * 60 * 1000).toISOString()

    expect(expiryState(at(20), now)?.className).toMatch(/text-text-tertiary/)
    expect(expiryState(at(8), now)?.className).toMatch(/text-text-tertiary/)
    expect(expiryState(at(7), now)?.className).toMatch(/status-warning/)
    expect(expiryState(at(4), now)?.className).toMatch(/status-warning/)
    expect(expiryState(at(3), now)?.className).toMatch(/status-error/)
    expect(expiryState(at(1), now)?.className).toMatch(/status-error/)
    expect(expiryState(at(-1), now)?.label).toBe('expiring shortly')
    expect(expiryState(null, now)).toBeNull()
  })

  it('reads a folder as a folder, with what is inside it', async () => {
    response = body([
      entry({
        id: 'f-9',
        kind: 'folder',
        name: 'Day 2',
        child_count: 14,
        asset_type: null,
      }),
    ])
    renderView()
    const row = await screen.findByTestId('trash-row-f-9')
    expect(row).toHaveTextContent('Folder')
    expect(within(row).getByTestId('trash-child-count-f-9')).toHaveTextContent(
      '14 items inside',
    )
  })

  it('reads a version as a version OF a file, with a way to that file', async () => {
    response = body([
      entry({
        id: 'v-3',
        kind: 'version',
        name: 'Opening shot.mov',
        version_number: 3,
        asset_id: 'a-77',
      }),
    ])
    renderView()
    const row = await screen.findByTestId('trash-row-v-3')
    expect(row).toHaveTextContent('Version 3 of “Opening shot.mov”')
    expect(within(row).getByTestId('trash-version-badge-v-3')).toHaveTextContent(
      /version/i,
    )
    expect(within(row).getByTestId('trash-go-to-asset-v-3')).toHaveAttribute(
      'href',
      `/projects/${PROJECT}/assets/a-77`,
    )
    expect(trashEntryTitle({ ...entry(), kind: 'asset' })).toBe('Opening shot.mov')
  })
})

// ─── The two actions, from the server's flags ────────────────────────────

describe('the row’s actions', () => {
  it('offers Restore only where can_restore is true', async () => {
    response = body([
      entry({ id: 'mine', can_restore: true }),
      entry({ id: 'theirs', can_restore: false }),
    ])
    renderView()
    expect(await screen.findByTestId('trash-restore-mine')).toBeInTheDocument()
    expect(screen.queryByTestId('trash-restore-theirs')).not.toBeInTheDocument()
  })

  it('offers Delete Permanently only where can_purge is true', async () => {
    response = body([
      entry({ id: 'purgeable', can_purge: true }),
      entry({ id: 'not-purgeable', can_purge: false }),
    ])
    renderView()
    expect(await screen.findByTestId('trash-purge-purgeable')).toBeInTheDocument()
    expect(screen.queryByTestId('trash-purge-not-purgeable')).not.toBeInTheDocument()
  })

  it('restores by kind, and says so', async () => {
    const user = userEvent.setup()
    response = body([
      entry({ id: 'a-1' }),
      entry({ id: 'f-1', kind: 'folder', name: 'Day 2' }),
      entry({
        id: 'v-1',
        kind: 'version',
        name: 'Clip.mov',
        version_number: 2,
        asset_id: 'a-77',
      }),
    ])
    const view = renderView()
    await user.click(await screen.findByTestId('trash-restore-a-1'))
    await waitFor(() => expect(view.onRestoreAsset).toHaveBeenCalledWith('a-1'))

    await user.click(screen.getByTestId('trash-restore-f-1'))
    await waitFor(() => expect(view.onRestoreFolder).toHaveBeenCalledWith('f-1'))

    await user.click(screen.getByTestId('trash-restore-v-1'))
    await waitFor(() =>
      expect(view.onRestoreVersion).toHaveBeenCalledWith('a-77', 'v-1'),
    )
    // One toast per restore, each naming what came back.
    expect((await screen.findAllByText(/restored/)).length).toBeGreaterThan(0)
  })

  it('shows the server’s refusal when a restore fails', async () => {
    const user = userEvent.setup()
    const view = renderView({
      onRestoreAsset: vi
        .fn()
        .mockRejectedValue(new Error('Only the person who deleted this can restore it')),
    })
    await user.click(await screen.findByTestId('trash-restore-a-1'))
    expect(
      await screen.findByText(/Only the person who deleted this can restore it/),
    ).toBeInTheDocument()
    expect(view.onRestoreFolder).not.toHaveBeenCalled()
  })

  it('hands a permanent delete to the caller’s own confirm', async () => {
    const user = userEvent.setup()
    response = body([entry({ can_purge: true })])
    const view = renderView()
    await user.click(await screen.findByTestId('trash-purge-a-1'))
    expect(view.onPurge).toHaveBeenCalledWith({
      id: 'a-1',
      name: 'Opening shot.mov',
      kind: 'asset',
    })
  })
})

// ─── Nothing to show ─────────────────────────────────────────────────────

describe('the empty states', () => {
  it('explains an empty trash the way §240’s visibility rule makes it true', async () => {
    response = body([])
    renderView()
    const empty = await screen.findByTestId('trash-empty')
    expect(empty).toHaveTextContent('Nothing you deleted is here.')
    expect(empty).toHaveTextContent(
      'Items others deleted can be restored by the project owner.',
    )
  })

  it('says something different when it is the FILTER that matches nothing', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByTestId('trash-row-a-1')
    response = body([])

    await user.selectOptions(
      within(screen.getByTestId('trash-controls-bar')).getByTestId('trash-kind'),
      'version',
    )
    const none = await screen.findByTestId('trash-no-results')
    expect(none).toHaveTextContent('Nothing matches those filters.')
    expect(screen.queryByTestId('trash-empty')).not.toBeInTheDocument()

    // And clearing them puts the list back.
    response = body([entry()])
    await user.click(within(none).getByText('Clear filters'))
    await waitFor(() => expect(lastPath()).not.toContain('kind='))
  })
})

describe('the retention number', () => {
  it('comes from the API’s retention_days, not the web’s constant', async () => {
    response = body([entry()], { retention_days: 14 })
    renderView()
    expect(
      await screen.findByText(/permanently deleted 14 days after they were removed/i),
    ).toBeInTheDocument()
  })

  it('falls back to the web’s constant when the API does not send one', async () => {
    response = { items: [entry()], total: 1, folders: [], assets: [] }
    renderView()
    expect(
      await screen.findByText(/permanently deleted 30 days after they were removed/i),
    ).toBeInTheDocument()
  })
})

describe('a pre-§240 response', () => {
  it('renders the empty state rather than throwing on a missing items[]', async () => {
    response = { folders: [], assets: [] }
    renderView()
    expect(await screen.findByTestId('trash-empty')).toBeInTheDocument()
  })
})
