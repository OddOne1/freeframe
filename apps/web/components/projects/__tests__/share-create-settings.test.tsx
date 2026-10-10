/**
 * The share-link popup offers every setting except Appearance and Sort by
 * (§223 B).
 *
 * The list is derived from `share-link-detail.tsx`'s settings tab, which is
 * the full panel. Everything there that is not under Appearance or Sort by
 * has to be offered at creation too — and, the part that is invisible
 * without inspecting the request, has to actually REACH the server on all
 * four create paths. The dialog takes two different shapes: a multi-item
 * selection POSTs one body to /share/multi, while a single asset, a single
 * folder and the project root each POST a bare title and then PATCH the
 * settings on. A field added to one and not the other silently does
 * nothing on three paths out of four.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AssetResponse, Folder, ShareLink } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { api } from '@/lib/api'
import { ShareCreateDialog } from '../share-create-dialog'

const PROJECT = 'p-1'
const TOKEN = 'tok-abc123'

const ASSETS = [
  { id: 'a-1', name: 'Clip One', asset_type: 'video', thumbnail_url: null },
  { id: 'a-2', name: 'Clip Two', asset_type: 'video', thumbnail_url: null },
] as unknown as AssetResponse[]

const FOLDERS = [{ id: 'f-1', name: 'Day 1' }] as unknown as Folder[]

function renderDialog(props: Record<string, unknown> = {}) {
  render(
    <ShareCreateDialog
      open
      onOpenChange={vi.fn()}
      projectId={PROJECT}
      currentFolderId={null}
      assets={ASSETS}
      folders={FOLDERS}
      onShareCreated={vi.fn()}
      {...props}
    />,
  )
}

/** Straight into Configure, on a single asset. */
function configureAsset() {
  renderDialog({ preselectedItem: { type: 'asset', id: 'a-1', name: 'Clip One' } })
}

function toggle(name: string) {
  return screen.getByRole('switch', { name })
}

async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^create$/i }))
}

/** The body of the one POST that carried settings, or the PATCH's. */
function postBody(urlPart: string) {
  const call = (api.post as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
    String(c[0]).includes(urlPart),
  )
  if (!call) throw new Error(`no POST to ${urlPart}`)
  return call[1] as Record<string, unknown>
}

function patchBody() {
  const call = (api.patch as ReturnType<typeof vi.fn>).mock.calls.find(
    (c) => String(c[0]) === `/share/${TOKEN}`,
  )
  if (!call) throw new Error('no PATCH')
  return call[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ token: TOKEN, title: 'X' })
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
  ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
    token: TOKEN,
    permission: 'view',
    appearance: null,
  } as unknown as ShareLink)
})

// ─── B.1/B.5 — what the popup offers, and what it must not ────────────────

describe('§223 B.1 — the settings the popup offers', () => {
  it('offers both of the settings §223 adds', () => {
    configureAsset()
    expect(toggle('Show comments')).toBeTruthy()
    expect(toggle('Show all versions')).toBeTruthy()
  })

  it('still offers everything it already did', () => {
    configureAsset()
    expect(screen.getByText('Link name')).toBeTruthy()
    expect(screen.getByText('Visibility')).toBeTruthy()
    expect(toggle('Allow comments')).toBeTruthy()
    expect(screen.getByText('Downloads')).toBeTruthy()
    expect(screen.getByText('Fields')).toBeTruthy()
    expect(toggle('Passphrase')).toBeTruthy()
    expect(screen.getByText('Expiration date')).toBeTruthy()
    expect(toggle('Watermark')).toBeTruthy()
  })

  it('does NOT offer "Enabled" — a link is always on at creation', () => {
    configureAsset()
    expect(screen.queryByRole('switch', { name: 'Enabled' })).toBeNull()
  })

  it('does NOT offer the invite search, which needs a token first', () => {
    configureAsset()
    // ShareInviteInput's own placeholder, which only LinkCreatedPhase shows.
    expect(screen.queryByPlaceholderText(/name or email/i)).toBeNull()
  })
})

describe('§223 B.5 — Appearance and Sort by are absent from the DOM', () => {
  it('shows no Appearance control', () => {
    configureAsset()
    for (const label of [
      /appearance/i,
      /open in viewer/i,
      /theme/i,
      /accent/i,
      /card size/i,
      /aspect ratio/i,
      /thumbnail/i,
      /show card info/i,
    ]) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it('shows no Sort by control', () => {
    configureAsset()
    expect(screen.queryByText(/sort by/i)).toBeNull()
  })

  it('sends no appearance at all, so the server defaults stand', async () => {
    const user = userEvent.setup()
    configureAsset()
    await create(user)
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBody()).not.toHaveProperty('appearance')
    expect(postBody('/assets/a-1/share')).not.toHaveProperty('appearance')
  })
})

// ─── B.4 — every included setting reaches the server on every path ────────

/** The fields §223 requires on every path, with a non-default value chosen
 *  for each, so a dropped field cannot pass by coinciding with a default. */
async function setEverything(user: ReturnType<typeof userEvent.setup>) {
  await user.click(toggle('Allow comments')) // → permission 'comment'
  await user.click(toggle('Show all versions')) // → false
  await user.click(toggle('Watermark')) // → true
}

function expectEverythingPresent(body: Record<string, unknown>) {
  expect(body.permission).toBe('comment')
  expect(body.show_comments).toBe(true)
  expect(body.show_versions).toBe(false)
  expect(body.show_watermark).toBe(true)
  expect(body.visibility).toBe('public')
  expect(body.allowed_download_variants).toEqual([])
  expect(body.fields_visibility).toBe('disabled')
}

describe('§223 B.4 — path 1 of 4: a single asset', () => {
  it('PATCHes every setting onto the created link', async () => {
    const user = userEvent.setup()
    configureAsset()
    await setEverything(user)
    await create(user)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.post).toHaveBeenCalledWith('/assets/a-1/share', { title: 'Clip One' })
    expectEverythingPresent(patchBody())
  })
})

describe('§223 B.4 — path 2 of 4: a single folder', () => {
  it('PATCHes every setting onto the created link', async () => {
    const user = userEvent.setup()
    renderDialog({ preselectedItem: { type: 'folder', id: 'f-1', name: 'Day 1' } })
    await setEverything(user)
    await create(user)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.post).toHaveBeenCalledWith('/folders/f-1/share', { title: 'Day 1' })
    expectEverythingPresent(patchBody())
  })
})

describe('§223 B.4 — path 3 of 4: the project root', () => {
  it('PATCHes every setting onto the created link', async () => {
    const user = userEvent.setup()
    // No preselection and no current folder: the dialog opens on selection,
    // and "Next" with nothing picked shares the project root. (Next is
    // gated on the view HAVING items, not on any being selected — which is
    // what makes this branch reachable at all.)
    renderDialog({ preselectedItems: [] })
    await user.click(await screen.findByRole('button', { name: /^next$/i }))
    await setEverything(user)
    await create(user)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.post).toHaveBeenCalledWith(`/projects/${PROJECT}/share`, {
      title: 'Shared Project',
    })
    expectEverythingPresent(patchBody())
  })

  it('and the same for the open folder, the fourth single-item branch', async () => {
    const user = userEvent.setup()
    renderDialog({ preselectedItems: [], currentFolderId: 'f-1' })
    await user.click(await screen.findByRole('button', { name: /^next$/i }))
    await setEverything(user)
    await create(user)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.post).toHaveBeenCalledWith('/folders/f-1/share', { title: 'Day 1' })
    expectEverythingPresent(patchBody())
  })
})

describe('§223 B.4 — path 4 of 4: a multi-item link', () => {
  it('puts every setting in the /share/multi body', async () => {
    const user = userEvent.setup()
    renderDialog({
      preselectedItems: [
        { type: 'asset', id: 'a-1', name: 'Clip One' },
        { type: 'asset', id: 'a-2', name: 'Clip Two' },
      ],
    })
    // Several preselected items go straight to Configure — no Next step.
    await setEverything(user)
    await create(user)

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = postBody('/share/multi')
    expect(body.asset_ids).toEqual(['a-1', 'a-2'])
    expectEverythingPresent(body)
    // The multi path creates in one shot — nothing is PATCHed after it.
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('carries a chosen "comments visible, posting off" through as well', async () => {
    const user = userEvent.setup()
    renderDialog({
      preselectedItems: [
        { type: 'asset', id: 'a-1', name: 'Clip One' },
        { type: 'folder', id: 'f-1', name: 'Day 1' },
      ],
    })
    await create(user)

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = postBody('/share/multi')
    expect(body.folder_ids).toEqual(['f-1'])
    // The §188 configuration, and the default: read without joining.
    expect(body.permission).toBe('view')
    expect(body.show_comments).toBe(true)
  })
})

// ─── B.2 — the §189 rule, in both directions ─────────────────────────────

describe('§223 B.2 / §189 — permission and show_comments stay consistent', () => {
  it('turning posting ON forces the panel visible', async () => {
    const user = userEvent.setup()
    configureAsset()
    // Start from the one state that could contradict: comments hidden.
    await user.click(toggle('Show comments'))
    expect(toggle('Show comments')).toHaveAttribute('data-state', 'unchecked')

    await user.click(toggle('Allow comments'))
    expect(toggle('Show comments')).toHaveAttribute('data-state', 'checked')

    await create(user)
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    const body = patchBody()
    expect(body.permission).toBe('comment')
    expect(body.show_comments).toBe(true)
  })

  it('hiding the panel withdraws posting', async () => {
    const user = userEvent.setup()
    configureAsset()
    await user.click(toggle('Allow comments'))
    expect(toggle('Allow comments')).toHaveAttribute('data-state', 'checked')

    await user.click(toggle('Show comments'))
    expect(toggle('Allow comments')).toHaveAttribute('data-state', 'unchecked')

    await create(user)
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    const body = patchBody()
    expect(body.permission).toBe('view')
    expect(body.show_comments).toBe(false)
  })

  it('never sends the dead-end pair, in either order of clicks', async () => {
    // Both orders, because each is collapsed by a DIFFERENT rule: "allow
    // then hide" is caught on the way down, "hide then allow" on the way
    // up. One sequence only ever exercises one of the two.
    for (const order of [
      ['Allow comments', 'Show comments'],
      ['Show comments', 'Allow comments'],
    ] as const) {
      vi.clearAllMocks()
      ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ token: TOKEN, title: 'X' })
      ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
      const user = userEvent.setup()
      const view = render(
        <ShareCreateDialog
          open
          onOpenChange={vi.fn()}
          projectId={PROJECT}
          currentFolderId={null}
          assets={ASSETS}
          folders={FOLDERS}
          preselectedItem={{ type: 'asset', id: 'a-1', name: 'Clip One' }}
          onShareCreated={vi.fn()}
        />,
      )
      for (const name of order) await user.click(toggle(name))
      await create(user)

      await waitFor(() => expect(api.patch).toHaveBeenCalled())
      const body = patchBody()
      const dead = body.permission === 'comment' && body.show_comments === false
      expect(dead, `order: ${order.join(' then ')}`).toBe(false)
      view.unmount()
    }
  })

  it('keeps the asymmetric combination §188 exists for', async () => {
    const user = userEvent.setup()
    configureAsset()
    // Untouched: posting off, reading on.
    expect(toggle('Allow comments')).toHaveAttribute('data-state', 'unchecked')
    expect(toggle('Show comments')).toHaveAttribute('data-state', 'checked')
    await create(user)

    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(patchBody().permission).toBe('view')
    expect(patchBody().show_comments).toBe(true)
  })
})

describe('§223 B.2 — the defaults match what the server would have used', () => {
  it('an untouched create sends show_comments/show_versions true', async () => {
    const user = userEvent.setup()
    configureAsset()
    await create(user)
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    // Both server schemas default these to True, so the dialog's arrival
    // changes nothing for someone who does not touch them.
    expect(patchBody().show_comments).toBe(true)
    expect(patchBody().show_versions).toBe(true)
  })
})
