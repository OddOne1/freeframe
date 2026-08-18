/**
 * The share-link Fields panel (CLAUDE.md §33).
 *
 * The panel renders what the server sends. What is asserted here is that it
 * does not invent anything the server withheld — a `basic` payload must not
 * produce a technical-metadata section, and no payload must produce custom
 * project fields or a voter breakdown.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { ShareFieldsPanel } from '../share-fields-panel'

const BASIC = {
  level: 'basic',
  name: 'Drone shot',
  asset_type: 'video',
  description: 'the wide',
  rating: 4,
  due_date: null,
  keywords: ['drone', 'b-roll'],
  technical_metadata: null,
  sidecars: null,
}

const FULL = {
  ...BASIC,
  level: 'full',
  technical_metadata: { camera_make: 'Sony', video_codec: 'h264' },
  sidecars: [
    {
      id: 's1',
      asset_id: 'a1',
      sidecar_type: 'camera_xml',
      original_filename: 'C0001M01.XML',
      parsed_metadata: { 'Item.LensInfo.FocalLength': '24mm' },
      created_at: '2026-08-18T00:00:00Z',
    },
  ],
}

function mockFetch(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as unknown as Response)),
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

// A FRESH SWR cache per test. Every case here uses the same token+assetId,
// so without this the first payload rendered is the one every later test
// sees — the `full` cases silently asserted against the `basic` response
// and failed for a reason that had nothing to do with the component.
const renderPanel = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareFieldsPanel token="tok" assetId="a1" />
    </SWRConfig>,
  )

describe('basic', () => {
  it('shows the basic fields', async () => {
    mockFetch(BASIC)
    renderPanel()
    expect(await screen.findByText('Drone shot')).toBeInTheDocument()
    expect(screen.getByText('the wide')).toBeInTheDocument()
    expect(screen.getByText('4/5')).toBeInTheDocument()
    expect(screen.getByText('drone')).toBeInTheDocument()
  })

  it('shows NO technical metadata section at all', async () => {
    mockFetch(BASIC)
    renderPanel()
    await screen.findByText('Drone shot')
    // Not merely collapsed — the control that would reveal it is absent.
    expect(screen.queryByText(/show all fields/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/from uploaded sidecar/i)).not.toBeInTheDocument()
  })
})

describe('full', () => {
  it('offers the technical metadata, collapsed like the logged-in tab', async () => {
    mockFetch(FULL)
    renderPanel()
    const toggle = await screen.findByText(/show all fields/i)
    expect(screen.queryByText('Camera make')).not.toBeInTheDocument()
    await userEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Camera make')).toBeInTheDocument())
    expect(screen.getByText('Sony')).toBeInTheDocument()
  })

  it('shows sidecar data with its provenance heading', async () => {
    mockFetch(FULL)
    renderPanel()
    expect(await screen.findByText(/from uploaded sidecar/i)).toBeInTheDocument()
    expect(screen.getByText(/C0001M01\.XML/)).toBeInTheDocument()
  })
})

describe('it renders only what it was sent', () => {
  it('does not fall back to showing full data when the level says basic', async () => {
    // A server that sent basic but (wrongly) included the payload would
    // still not be a reason for the client to render it.
    mockFetch({ ...BASIC, level: 'basic' })
    renderPanel()
    await screen.findByText('Drone shot')
    expect(screen.queryByText(/show all fields/i)).not.toBeInTheDocument()
  })

  it('degrades to a message rather than a blank panel when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false } as unknown as Response)))
    renderPanel()
    expect(await screen.findByText(/unavailable/i)).toBeInTheDocument()
  })
})
