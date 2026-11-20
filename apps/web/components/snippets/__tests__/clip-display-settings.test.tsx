/**
 * The Clips tab's grid size and text size, on the real snippets page
 * (answered by the dev fixtures, lib/snippet-fixtures.ts): each setting
 * writes its own CSS variable on the Clips container and never the other's,
 * both survive a reload, neither reaches anything outside the Clips tab, and
 * the grid still opens a card in place at the column counts each grid size
 * gives. jsdom has no layout, so the grid's computed columns are stubbed from
 * the container's `--clip-scale`, as a 1920 px window gives them.
 */
import * as React from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/types'

const PROJECT_ID = 'p1'
const USER_ID = 'u1'
let search = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PROJECT_ID }),
  usePathname: () => `/projects/${PROJECT_ID}/snippets`,
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}))

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn() },
  }
})

import { ClipGrid } from '../clip-grid'

// Every module the page shares with the test is imported when needed, not at
// the top: the reload test resets the module registry, and the page then
// runs against fresh copies (its stores included).
const SNIPPET_VIEW_STORAGE_KEY = 'freeframe-snippet-view-settings'
const stores = async () => ({
  auth: (await import('@/stores/auth-store')).useAuthStore,
  view: (await import('@/stores/view-store')).useViewStore,
  projectView: (await import('@/stores/project-view-store')).useProjectViewStore,
  snippetView: (await import('@/stores/snippet-view-store')).useSnippetViewStore,
})

type PageModule = typeof import('@/app/(dashboard)/projects/[id]/snippets/page')

async function loadPage(): Promise<PageModule['default']> {
  return (await import('@/app/(dashboard)/projects/[id]/snippets/page')).default
}

async function renderPage(Page?: PageModule['default']) {
  const P = Page ?? (await loadPage())
  const utils = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <P />
    </SWRConfig>,
  )
  // The fixtures answer after 250 ms; the owner's tabs come with the members list.
  await screen.findAllByRole('article', {}, { timeout: 3000 })
  await screen.findByRole('tablist', { name: 'SocialSnippet views' }, { timeout: 3000 })
  return utils
}

const container = () => screen.getByTestId('clips-view')
const scaleVar = () => container().style.getPropertyValue('--clip-scale')
const textVar = () => container().style.getPropertyValue('--clip-text')
const firstGridOrder = () =>
  Array.from(document.querySelector('[data-clip-grid]')!.querySelectorAll<HTMLElement>(':scope > [data-clip-key]')).map(
    (el) => el.dataset.clipKey!,
  )

/** Column tracks a wide Clips tab gets: 3 at Small (31rem), 2 at Large (45rem). */
function stubGridColumns() {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    if (!el.hasAttribute('data-clip-grid')) return real(el, pseudo)
    const host = el.closest<HTMLElement>('[data-testid="clips-view"]')
    const scale = Number(host?.style.getPropertyValue('--clip-scale') || '1')
    return { gridTemplateColumns: scale > 1 ? '780px 780px' : '520px 520px 520px' } as CSSStyleDeclaration
  })
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_SNIPPET_FIXTURES', '1')
  search = new URLSearchParams()
  const s = await stores()
  expect((await import('@/stores/snippet-view-store')).SNIPPET_VIEW_STORAGE_KEY).toBe(SNIPPET_VIEW_STORAGE_KEY)
  s.snippetView.setState({ clipGridSize: 'small', clipTextSize: 'normal' })
  window.localStorage.clear()
  s.auth.setState({ user: { id: USER_ID, role: 'user' } as User, isSuperAdmin: false })
  // The signed-in user owns the project, so the page shows its Clips and Files tabs.
  const { api } = await import('@/lib/api')
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === `/projects/${PROJECT_ID}/members`) return [{ user_id: USER_ID, role: 'owner' }]
    if (path === `/projects/${PROJECT_ID}`) return { id: PROJECT_ID, name: 'Demo' }
    throw new Error(`unexpected GET ${path}`)
  })
  // Opening a card scrolls it into view; jsdom has no scrolling.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Clips tab display settings', () => {
  it('starts at Small and Normal: both variables at 1, the sizes the page had before', async () => {
    await renderPage()
    expect(scaleVar()).toBe('1')
    expect(textVar()).toBe('1')
    const grid = screen.getByRole('group', { name: 'Grid size' })
    const text = screen.getByRole('group', { name: 'Text size' })
    expect(within(grid).getByRole('button', { name: 'Small grid' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(text).getByRole('button', { name: 'Normal text' })).toHaveAttribute('aria-pressed', 'true')
    // Tooltips on every segment.
    for (const b of [...within(grid).getAllByRole('button'), ...within(text).getAllByRole('button')]) {
      expect(b).toHaveAttribute('title', b.getAttribute('aria-label'))
    }
  })

  it('grid size changes --clip-scale and nothing else', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    expect(scaleVar()).toBe('1.5')
    expect(textVar()).toBe('1')
    expect(screen.getByRole('button', { name: 'Large grid' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Small grid' }))
    expect(scaleVar()).toBe('1')
    expect(textVar()).toBe('1')
  })

  it('text size changes --clip-text and nothing else', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: 'Large text' }))
    expect(Number(textVar())).toBeCloseTo(7 / 6, 10)
    expect(scaleVar()).toBe('1')
    await user.click(screen.getByRole('button', { name: 'Extra large text' }))
    expect(textVar()).toBe('1.5')
    expect(scaleVar()).toBe('1')
    // And grid size after it leaves the text size where it was.
    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    expect(textVar()).toBe('1.5')
    expect(scaleVar()).toBe('1.5')
  })

  it('keeps both choices after a reload', async () => {
    const user = userEvent.setup()
    const first = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    await user.click(screen.getByRole('button', { name: 'Extra large text' }))
    first.unmount()
    expect(JSON.parse(window.localStorage.getItem(SNIPPET_VIEW_STORAGE_KEY)!).state).toEqual({
      clipGridSize: 'large',
      clipTextSize: 'xlarge',
    })

    // A reload: fresh modules, so the store is created again from storage.
    const before = (await stores()).snippetView
    vi.resetModules()
    const fresh = await stores()
    expect(fresh.snippetView).not.toBe(before)
    expect(fresh.snippetView.getState()).toMatchObject({ clipGridSize: 'large', clipTextSize: 'xlarge' })
    // The fresh page's signed-in owner, as beforeEach sets up for the old modules.
    fresh.auth.setState({ user: { id: USER_ID, role: 'user' } as User, isSuperAdmin: false })
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockImplementation(async (path: string) =>
      path.endsWith('/members') ? [{ user_id: USER_ID, role: 'owner' }] : { id: PROJECT_ID, name: 'Demo' },
    )
    await renderPage(await loadPage())
    expect(scaleVar()).toBe('1.5')
    expect(textVar()).toBe('1.5')
    expect(screen.getByRole('button', { name: 'Large grid' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Extra large text' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('still works with storage blocked: the choice holds for the visit and nothing throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    await user.click(screen.getByRole('button', { name: 'Large text' }))
    expect(scaleVar()).toBe('1.5')
    expect(Number(textVar())).toBeCloseTo(7 / 6, 10)
  })

  it('reaches nothing outside the Clips tab', async () => {
    const user = userEvent.setup()
    const { view, projectView } = await stores()
    const viewBefore = view.getState().cardSize
    const projectBefore = projectView.getState().projectCardSize
    const page = await renderPage()
    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    await user.click(screen.getByRole('button', { name: 'Extra large text' }))

    // Set on the Clips container only: not on the page, the document or the tab list.
    for (const el of [document.documentElement, document.body]) {
      expect(el.style.getPropertyValue('--clip-scale')).toBe('')
      expect(el.style.getPropertyValue('--clip-text')).toBe('')
    }
    const tabs = screen.getByRole('tablist', { name: 'SocialSnippet views' })
    expect(container().contains(tabs)).toBe(false)
    const styled = Array.from(document.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.getPropertyValue('--clip-scale') || el.style.getPropertyValue('--clip-text'),
    )
    expect(styled).toEqual([container()])

    // The Files tab (?tab=files) is not inside it: the container goes with the Clips tab.
    page.unmount()
    search = new URLSearchParams('tab=files')
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {React.createElement(await loadPage())}
      </SWRConfig>,
    )
    const files = await screen.findByRole('tabpanel', {}, { timeout: 3000 })
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(files.closest('[data-testid="clips-view"]')).toBeNull()
    expect(screen.queryByTestId('clips-view')).toBeNull()
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[style]')).filter((el) =>
        el.style.getPropertyValue('--clip-scale'),
      ),
    ).toEqual([])

    // The other views' settings and storage are untouched.
    expect(view.getState().cardSize).toBe(viewBefore)
    expect(projectView.getState().projectCardSize).toBe(projectBefore)
    const keys = Object.keys(window.localStorage).filter((k) => k !== SNIPPET_VIEW_STORAGE_KEY)
    for (const k of keys) expect(window.localStorage.getItem(k)).not.toMatch(/clipGridSize|clipTextSize/)
  })

  it('opens a card in place at the Large grid’s column count, and re-reads it when the size changes', async () => {
    stubGridColumns()
    const user = userEvent.setup()
    await renderPage()
    const keys = firstGridOrder()
    expect(keys.length).toBeGreaterThanOrEqual(5)

    await user.click(screen.getByRole('button', { name: 'Large grid' }))
    // Two columns: the fourth card ends the second row; opened, it starts it.
    const fourth = document.querySelector<HTMLElement>(`[data-clip-key="${CSS.escape(keys[3])}"]`)!
    await user.click(within(fourth).getByRole('button', { name: 'Expand clip' }))
    expect(firstGridOrder()).toEqual([keys[0], keys[1], keys[3], keys[2], ...keys.slice(4)])
    const opened = document.querySelector<HTMLElement>(`[data-clip-key="${CSS.escape(keys[3])}"]`)!
    expect(opened.className).toContain('col-span-full')
    // An opened card keeps today's sizes.
    expect(opened.className).toContain('[--clip-scale:1]')

    // Back to Small: three columns, where the fourth card already starts a row.
    // Nothing resizes the grid, so this is the column count being read again.
    await user.click(screen.getByRole('button', { name: 'Small grid' }))
    await waitFor(() => expect(firstGridOrder()).toEqual(keys))

    // And at Small, the third card (ending the first row) moves to its start.
    await user.click(within(opened).getByRole('button', { name: 'Collapse clip' }))
    const third = document.querySelector<HTMLElement>(`[data-clip-key="${CSS.escape(keys[2])}"]`)!
    await user.click(within(third).getByRole('button', { name: 'Expand clip' }))
    expect(firstGridOrder()).toEqual([keys[2], keys[0], keys[1], ...keys.slice(3)])
  })
})

describe('ClipGrid layoutKey', () => {
  it('reads the column count again when only the column minimum changed', () => {
    let template = '520px 520px 520px'
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) =>
      el.hasAttribute('data-clip-grid') ? ({ gridTemplateColumns: template } as CSSStyleDeclaration) : real(el, pseudo),
    )
    const items = ['a', 'b', 'c', 'd', 'e']
    const Grid = ({ layoutKey }: { layoutKey: string }) => (
      <ClipGrid items={items} keyOf={(k) => k} expandedKey="d" layoutKey={layoutKey}>
        {(k) => <article data-clip-key={k} />}
      </ClipGrid>
    )
    const order = () => Array.from(document.querySelectorAll<HTMLElement>('[data-clip-key]')).map((el) => el.dataset.clipKey)
    const { rerender } = render(<Grid layoutKey="small" />)
    expect(order()).toEqual(items) // 3 columns: d starts row 2
    template = '780px 780px'
    act(() => rerender(<Grid layoutKey="large" />))
    expect(order()).toEqual(['a', 'b', 'd', 'c', 'e']) // 2 columns: d ended row 2
  })
})
