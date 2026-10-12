/**
 * §228d item 3 — "up one level" at the top of the folder/asset view.
 *
 * The owner: "in the folder/assets window there needs to be a back button
 * right above the first text or item. This button needs to be viewable for
 * every size window, not just mobile. For mobile it needs to be smaller
 * though."
 *
 * Two halves, tested separately because they fail separately:
 *
 *  - `folderBackTarget`, which answers "what is the parent" from the SAME
 *    `folderTrail` the breadcrumb and the folder navigator read (§227).
 *    A pure function, so the three depths are three assertions rather than
 *    three page renders.
 *  - the button itself, rendered by the real `AssetGrid` in grid, in list
 *    and with nothing in the folder at all.
 *
 * What jsdom cannot show, as everywhere else in this app: that 28px is
 * 28px, that `md:` applies at 768, or that the invisible `tap-target-44`
 * box is 44 CSS px. Those are asserted here as the classes that encode the
 * decision and measured for real in Chromium — the numbers are in the
 * §228d report.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Asset, Folder } from '@/types'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const push = vi.fn()
const back = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/projects/p-1',
}))

// `next/link` needs an app-router context to be CLICKED; the href it
// renders is the whole point here, so it is a plain anchor in these tests.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

import { AssetGrid } from '../asset-grid'
import { folderBackTarget } from '../folder-back-button'
import { useViewStore } from '@/stores/view-store'

const PROJECT = 'p-1'
const TRAIL = [
  { id: 'f-a', name: 'Rope Challenge' },
  { id: 'f-b', name: 'Day 2' },
  { id: 'f-c', name: 'Rushes' },
]

function asset(id: string, name: string): Asset {
  return {
    id, project_id: PROJECT, name, status: 'in_review', asset_type: 'video',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    folder_id: null,
  } as unknown as Asset
}
function folder(id: string, name: string): Folder {
  return {
    id, name, project_id: PROJECT, parent_id: null, item_count: 0,
    total_size_bytes: 0, created_at: new Date().toISOString(),
  } as unknown as Folder
}

const ASSETS = [asset('a-1', 'A One'), asset('a-2', 'B Two')]
const FOLDERS = [folder('f-1', 'Day 1')]

function renderGrid(
  { layout = 'grid' as 'grid' | 'list', assets = ASSETS, folders = FOLDERS, backTo = undefined as
    | { href: string; parentName: string }
    | undefined,
    handlers = {} as Record<string, unknown> },
) {
  useViewStore.setState({ layout, flattenFolders: false, sortKey: 'name', sortDirection: 'asc' })
  return render(
    <AssetGrid
      assets={assets}
      folders={folders}
      projectId={PROJECT}
      projectName="Proj"
      backTo={backTo}
      {...handlers}
    />,
  )
}

const backLink = () => screen.getByTestId('folder-back') as HTMLAnchorElement

beforeEach(() => {
  push.mockClear()
  back.mockClear()
})

// ─── where it goes ──────────────────────────────────────────────────────

describe('§228d item 3 — the parent, from the trail the breadcrumb uses', () => {
  it('a folder two levels down goes to ITS parent, not to the root', () => {
    expect(folderBackTarget(PROJECT, 'Proj', TRAIL)).toEqual({
      href: `/projects/${PROJECT}?folder=f-b`,
      parentName: 'Day 2',
    })
  })

  it('a top-level folder goes to the project root, named after the project', () => {
    expect(folderBackTarget(PROJECT, 'Just Ride 2026', TRAIL.slice(0, 1))).toEqual({
      href: `/projects/${PROJECT}`,
      parentName: 'Just Ride 2026',
    })
  })

  it('the project root itself goes to the Projects list', () => {
    // Which is why the button is never hidden: "up" always has somewhere
    // to go, and a control that comes and goes as you walk the tree is one
    // you cannot learn.
    expect(folderBackTarget(PROJECT, 'Proj', [])).toEqual({
      href: '/projects',
      parentName: 'Projects',
    })
  })

  it('the href is the same shape the viewer and the crumbs already build', () => {
    // `?folder={id}` — the project page derives `currentFolderId` from that
    // param on every render, so landing on it cold renders the folder (§29,
    // §179). A different shape would still look right in a link test and
    // break the cold load.
    expect(folderBackTarget(PROJECT, 'Proj', TRAIL).href).toMatch(
      /^\/projects\/[^?]+\?folder=[^&]+$/,
    )
  })
})

// ─── what it is ─────────────────────────────────────────────────────────

describe('§228d item 3 — the control itself', () => {
  const backTo = { href: `/projects/${PROJECT}?folder=f-b`, parentName: 'Day 2' }

  it('is the first interactive element in the content column', () => {
    const { container } = renderGrid({ backTo })
    const first = container.querySelector(
      'button, a[href], input, select, textarea, [role="button"]',
    )
    expect(first).toBe(backLink())
  })

  it('is a real link to the parent, never a history instruction', async () => {
    /* `router.back()` would pass a click test and fail the cases this page
       is opened in most — a shared link, a refresh, a new tab, a deep
       `?folder=` link. An <a href> is also exactly ONE history entry; a
       push on top of a navigation would be two. */
    renderGrid({ backTo })
    expect(backLink().tagName).toBe('A')
    expect(backLink().getAttribute('href')).toBe(backTo.href)

    await userEvent.click(backLink())
    expect(push).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
  })

  it('names the parent to a screen reader at every width', () => {
    renderGrid({ backTo })
    expect(backLink().getAttribute('aria-label')).toBe('Back to Day 2')
    expect(screen.getByLabelText('Back to Day 2')).toBe(backLink())
  })

  it('shows the parent name only where it fits, and the word always', () => {
    renderGrid({ backTo })
    expect(backLink().textContent).toContain('Back')
    const name = [...backLink().querySelectorAll('span')].find((s) =>
      s.textContent?.trim().startsWith('to '),
    )
    // Below `md` the name is hidden: at 320px "Back to Reaction_watchparty"
    // is the whole row. The aria-label above keeps it for a screen reader.
    expect(name?.className).toContain('hidden')
    expect(name?.className).toContain('md:inline')
  })

  it('is smaller on a phone than on a desktop, as asked', () => {
    renderGrid({ backTo })
    // 28px below `md`, 32px at `md`+. Tailwind rather than `useIsPhone()`:
    // a purely visual difference, and the server and the client agree on a
    // class (see hooks/use-media-query.ts).
    expect(backLink().className).toContain('h-7')
    expect(backLink().className).toContain('md:h-8')
    expect(backLink().className).toContain('text-xs')
    expect(backLink().className).toContain('md:text-sm')
    // "viewable for every size window, not just mobile" — and the other
    // way round: `hidden md:inline-flex` would be a desktop-only control,
    // which is the shape the owner was complaining about on his phone.
    expect(backLink().className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })

  it('carries the invisible 44px hit area, and the position it needs', () => {
    renderGrid({ backTo })
    // §227b's `.tap-target-44::before` is absolutely positioned and
    // declares no `position` of its own, so the control must establish the
    // containing block itself or the box anchors to an ancestor.
    expect(backLink().className).toContain('tap-target-44')
    expect(backLink().className).toContain('relative')
  })

  it('has a visible focus ring', () => {
    renderGrid({ backTo })
    expect(backLink().className).toContain('focus-visible:ring-2')
  })

  it('carries the arrow, not a chevron and not a folder glyph', () => {
    renderGrid({ backTo })
    const icon = backLink().querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('lucide-arrow-left')
  })

  it('is there in list layout too', () => {
    renderGrid({ layout: 'list', backTo })
    expect(backLink()).toBeTruthy()
  })

  it('is there in an empty folder, above the empty state', () => {
    const { container } = renderGrid({ assets: [], folders: [], backTo })
    expect(backLink()).toBeTruthy()
    expect(screen.getByText('No assets')).toBeTruthy()
    const first = container.querySelector('a[href], button')
    expect(first).toBe(backLink())
  })

  it('does not open or select the item under it', async () => {
    const onAssetOpen = vi.fn()
    const onAssetSelect = vi.fn()
    const onFolderOpen = vi.fn()
    renderGrid({ backTo, handlers: { onAssetOpen, onAssetSelect, onFolderOpen } })

    await userEvent.click(backLink())
    expect(onAssetOpen).not.toHaveBeenCalled()
    expect(onAssetSelect).not.toHaveBeenCalled()
    expect(onFolderOpen).not.toHaveBeenCalled()
  })

  it('is absent where there is no folder to be above', () => {
    // The /assets page renders this same grid as one flat list of every
    // asset in every project; it passes no `backTo` and is unchanged.
    renderGrid({})
    expect(screen.queryByTestId('folder-back')).toBeNull()
  })
})
