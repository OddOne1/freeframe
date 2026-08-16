/**
 * Share-link creation UX (CLAUDE.md §21a-c).
 *
 * Rendered for real rather than calling handlers directly, because all
 * three bugs are about what actually reaches the network and what the user
 * ends up looking at:
 *
 *   21a — creating a link closed the dialog instead of showing the popup
 *         with the copyable URL. The popup existed; nothing reached it.
 *   21b — "Show all versions" was a real, already-wired field missing from
 *         this dialog entirely.
 *   21c — the Layout toggle PATCHed a hardcoded appearance object, wiping
 *         six fields the user had set elsewhere. That one is invisible
 *         unless you inspect the request body, which is what this does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ShareLink, ShareLinkAppearance } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

import { api } from '@/lib/api'
import { ShareCreateDialog } from '../share-create-dialog'
import { DEFAULT_SHARE_APPEARANCE } from '../share-link-detail'

const PROJECT = 'p-1'
const TOKEN = 'tok-abc123'

/** An appearance a user has genuinely customised — every field different
 *  from the hardcoded object the Layout button used to send. */
const CUSTOMISED: ShareLinkAppearance = {
  layout: 'grid',
  theme: 'light',
  accent_color: '#ff0000',
  open_in_viewer: false,
  sort_by: 'file_size',
  card_size: 'l',
  aspect_ratio: 'portrait',
  thumbnail_scale: 'fill',
  show_card_info: false,
}

function detailsResponse(over: Partial<ShareLink> = {}): ShareLink {
  return {
    token: TOKEN,
    title: 'My Share',
    permission: 'view',
    allow_download: false,
    show_watermark: false,
    show_versions: false,
    visibility: 'public',
    expires_at: null,
    has_password: false,
    appearance: CUSTOMISED,
    ...over,
  } as unknown as ShareLink
}

function setup() {
  const onShareCreated = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <ShareCreateDialog
      open
      onOpenChange={onOpenChange}
      projectId={PROJECT}
      currentFolderId={null}
      assets={[]}
      folders={[]}
      preselectedItem={{ type: 'asset', id: 'a-1', name: 'Clip 1' }}
      onShareCreated={onShareCreated}
    />,
  )
  return { onShareCreated, onOpenChange }
}

/** Open the created link's inline settings panel.
 *  Matched on the disclosure's own heading rather than /settings/i, which
 *  also hits the "Advanced settings" footer button. */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  const heading = await screen.findByText('Settings')
  await user.click(heading.closest('button') as HTMLElement)
}

/** Walk the Configure step and press its create button. */
async function createLink(user: ReturnType<typeof userEvent.setup>) {
  const create = await screen.findByRole('button', { name: /create/i })
  await user.click(create)
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ token: TOKEN, title: 'Clip 1' })
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
  ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue(detailsResponse())
})

describe('§21a — creating a link shows the popup', () => {
  it('lands on the result phase with a copyable URL instead of closing', async () => {
    const user = userEvent.setup()
    const { onOpenChange, onShareCreated } = setup()

    await createLink(user)

    // The share URL is the thing the popup exists to hand over.
    await waitFor(() => {
      expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy()
    })
    // It must NOT have closed itself on top of that.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // The sidebar still needs telling, so this keeps firing.
    expect(onShareCreated).toHaveBeenCalled()
  })

  it('offers a copy control on the created link', async () => {
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())
    expect(screen.getAllByRole('button', { name: /copy/i }).length).toBeGreaterThan(0)
  })
})

describe('§21b — Show all versions', () => {
  it('is offered in the popup settings and patches show_versions', async () => {
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())

    await openSettings(user)
    const row = await screen.findByText('Show all versions')
    expect(row).toBeTruthy()

    const toggle = row.closest('div')?.parentElement?.querySelector('button')
    await user.click(toggle as HTMLElement)

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith(`/share/${TOKEN}`, { show_versions: true })
    })
  })

  it('reflects the value the server already has', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailsResponse({ show_versions: true }),
    )
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())
    await openSettings(user)

    const row = await screen.findByText('Show all versions')
    const toggle = row.closest('div')?.parentElement?.querySelector('button')
    // Radix reflects switch state through data-state.
    expect(toggle?.getAttribute('data-state')).toBe('checked')
  })
})

describe('§21c — the Layout toggle must merge, not replace', () => {
  it('keeps every other appearance field the link already had', async () => {
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())
    await openSettings(user)

    await user.click(await screen.findByRole('button', { name: 'list' }))

    await waitFor(() => {
      const call = (api.patch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[1] && typeof c[1] === 'object' && 'appearance' in (c[1] as object),
      )
      expect(call).toBeTruthy()
      // The whole point: only `layout` changed.
      expect((call as unknown[])[1]).toEqual({
        appearance: { ...CUSTOMISED, layout: 'list' },
      })
    })
  })

  it('falls back to the SHARED defaults when the link has no appearance', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailsResponse({ appearance: null } as Partial<ShareLink>),
    )
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())
    await openSettings(user)
    await user.click(await screen.findByRole('button', { name: 'list' }))

    await waitFor(() => {
      const call = (api.patch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[1] && typeof c[1] === 'object' && 'appearance' in (c[1] as object),
      )
      // Not a second, invented set of defaults — the same object
      // share-link-detail.tsx uses, which is why it is exported.
      expect((call as unknown[])[1]).toEqual({
        appearance: { ...DEFAULT_SHARE_APPEARANCE, layout: 'list' },
      })
    })
  })

  it('never sends the old hardcoded object', async () => {
    const user = userEvent.setup()
    setup()
    await createLink(user)
    await waitFor(() => expect(screen.getByText(new RegExp(TOKEN))).toBeTruthy())
    await openSettings(user)
    await user.click(await screen.findByRole('button', { name: 'list' }))

    await waitFor(() => {
      const calls = (api.patch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[1])
        .filter((b) => b && typeof b === 'object' && 'appearance' in (b as object))
      expect(calls.length).toBeGreaterThan(0)
      for (const body of calls) {
        const a = (body as { appearance: ShareLinkAppearance }).appearance
        // These four are what the hardcoded object got wrong or dropped.
        expect(a.open_in_viewer).toBe(CUSTOMISED.open_in_viewer)
        expect(a.sort_by).toBe(CUSTOMISED.sort_by)
        expect(a.card_size).toBeDefined()
        expect(a.show_card_info).toBeDefined()
      }
    })
  })
})
