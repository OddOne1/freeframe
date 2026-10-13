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
 * §228e moved it: at `md`+ Back now sits BELOW the toolbar row and its
 * divider and directly above the first label; on a phone it is still the
 * first thing in the column, because the toolbar row is `hidden md:flex`
 * and paints nothing there. One component, one render site, so the two
 * cases are one DOM order read under two different sets of CSS — which is
 * exactly what the order tests below assert.
 *
 * What jsdom cannot show, as everywhere else in this app: that 28px is
 * 28px, that `md:` applies at 768, or that the invisible `tap-target-44`
 * box is 44 CSS px. jsdom also loads no stylesheet, so `hidden md:flex` is
 * an inert string here and the toolbar row is in the tree at every width:
 * the phone case is therefore asserted as "first among what is NOT
 * phone-hidden", and the real pixels are measured in Chromium — the
 * numbers are in the §228e report.
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
const toolbar = () => screen.getByTestId('navigator-bar') as HTMLElement

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"]'

/** Does `a` come before `b` in DOM order? That is also tab order here:
 *  nothing in the column carries a tabindex. */
const precedes = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

/** Is this element inside something Tailwind hides below `md`? jsdom
 *  applies no stylesheet, so the class is the only evidence there is. */
const phoneHidden = (el: Element) => {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const cls = n.className?.toString?.() ?? ''
    if (/(^|\s)hidden(\s|$)/.test(cls) && /\bmd:(flex|block|inline|contents|grid|inline-flex)\b/.test(cls)) {
      return true
    }
  }
  return false
}

/** "N FOLDERS" — the first label of the content, the thing the owner
 *  asked Back to sit directly above. */
const foldersLabel = () =>
  Array.from(document.querySelectorAll('span')).find((s) =>
    /^\d+\s+folders?$/i.test((s.textContent || '').trim()),
  )!

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

  it('at md+ it comes AFTER the toolbar row and BEFORE the first label', () => {
    /* §228e. The owner wants it under the toolbar's divider line and
       directly above "N FOLDERS", and DOM order is what delivers that at
       `md`+ — the column is a plain `flex-col` with no `order` anywhere,
       so DOM order, tab order and visual order are one order. */
    renderGrid({ backTo })
    expect(precedes(toolbar(), backLink())).toBe(true)
    expect(precedes(backLink(), foldersLabel())).toBe(true)
  })

  it('at md+ nothing else sits between the toolbar and Back', () => {
    // "directly below", not "somewhere below".
    const { container } = renderGrid({ backTo })
    const col = container.firstElementChild!
    const kids = Array.from(col.children)
    expect(kids.indexOf(backLink())).toBe(kids.indexOf(toolbar()) + 1)
  })

  it('is rendered ONCE, so there is one tab stop and one test id', () => {
    /* The alternative placement — two buttons, `md:hidden` and
       `hidden md:inline-flex` — would read identically in a screenshot
       and leave a second node, a second tab stop and a duplicate
       `data-testid` behind. */
    renderGrid({ backTo })
    expect(screen.getAllByTestId('folder-back')).toHaveLength(1)
    expect(screen.getAllByLabelText('Back to Day 2')).toHaveLength(1)
  })

  it('on a phone it is still the first thing in the column', () => {
    /* Unchanged from §228d, and unchanged to the pixel: below `md` the
       toolbar row is `hidden md:flex`, so it paints nothing and a
       `gap-3` column collapses its gap too. Back is therefore the first
       element a finger can reach, directly above "N FOLDERS". */
    const { container } = renderGrid({ backTo })
    const painted = Array.from(container.querySelectorAll(INTERACTIVE)).filter(
      (el) => !phoneHidden(el),
    )
    expect(painted[0]).toBe(backLink())
    expect(phoneHidden(toolbar())).toBe(true)
    expect(precedes(backLink(), foldersLabel())).toBe(true)
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
    const name = Array.from(backLink().querySelectorAll('span')).find((s) =>
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

  it('is there in list layout too, in the same place', () => {
    const { container } = renderGrid({ layout: 'list', backTo })
    expect(backLink()).toBeTruthy()
    // One placement for all four states: the list's rows hang off the
    // same column as the grid's cards.
    const kids = Array.from(container.firstElementChild!.children)
    expect(kids.indexOf(backLink())).toBe(kids.indexOf(toolbar()) + 1)
    const rows = container.querySelector('[data-folder-row], [data-asset-row]')!
    expect(precedes(backLink(), rows)).toBe(true)
  })

  it('is there in an empty folder, under the toolbar and above the empty state', () => {
    const { container } = renderGrid({ assets: [], folders: [], backTo })
    expect(backLink()).toBeTruthy()
    const empty = screen.getByText('No assets')
    const kids = Array.from(container.firstElementChild!.children)
    expect(kids.indexOf(backLink())).toBe(kids.indexOf(toolbar()) + 1)
    expect(precedes(backLink(), empty)).toBe(true)
    // and on a phone it is the first thing again, for the same reason
    const painted = Array.from(container.querySelectorAll(INTERACTIVE)).filter(
      (el) => !phoneHidden(el),
    )
    expect(painted[0]).toBe(backLink())
  })

  it('the loading skeleton puts it in the same place, so it does not jump', () => {
    /* §228d made the skeleton render Back so the first row did not move
       when the assets arrived; §228e has to keep that true of the new
       position, or Back itself would jump from above the toolbar to below
       it on load. Same `columnHead`, same order. */
    const { container } = renderGrid({ backTo, handlers: { isLoading: true } })
    expect(backLink()).toBeTruthy()
    const kids = Array.from(container.firstElementChild!.children)
    expect(kids.indexOf(backLink())).toBe(kids.indexOf(toolbar()) + 1)
    // it really is the skeleton, not the loaded grid
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
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
