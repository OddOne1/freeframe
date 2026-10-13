/**
 * §230 — Branding is two columns on a wide Admin tab, one on a narrow one.
 *
 * What is actually at stake is not "does it look like two columns": it is
 * that the SECOND column costs nothing. The sections were split into two
 * wrappers, so the two things that could silently break are
 *
 *   - the DOM order, which is tab order and screen-reader order. Left
 *     column first, so the stacked single column is the order it has
 *     always been: name, logo, login logo, favicon, theme, preview, reset.
 *   - the Save/Discard bar, which is `position: sticky`. A sticky box is
 *     clamped to its containing block, and for a grid item that is a grid
 *     row exactly as tall as the bar — no room to stick in. It therefore
 *     has to stay a direct child of the section, after the grid.
 *
 * The switch itself is a container query, read out of globals.css here
 * rather than measured: jsdom implements neither container queries nor
 * grid, so a layout assertion in this file would assert nothing. The
 * measurements are in the report; this is the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SWRConfig } from 'swr'
import fs from 'node:fs'
import path from 'node:path'

const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    patch: vi.fn(),
    upload: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { email: 'admin@example.com' }, isSuperAdmin: true }),
}))
vi.mock('@/stores/theme-store', () => ({ useThemeStore: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

import { BrandingSection } from '../branding-section'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
const SRC = fs.readFileSync(
  path.join(process.cwd(), 'components/settings/branding-section.tsx'),
  'utf8',
)

/** Defaults: name "FreeFrame", nothing uploaded, no custom palette — so the
 *  Reset section is NOT rendered, which is the shape the page has on a
 *  fresh instance. `withReset` is the other shape. */
function settings(withReset = false) {
  return {
    org_name: withReset ? 'Acme Studio' : 'FreeFrame',
    logo_dark_url: null,
    logo_light_url: null,
    logo_login_url: null,
    favicon_url: null,
    theme_colors: null,
  }
}

async function renderSection(withReset = false) {
  get.mockImplementation(async () => settings(withReset))
  const r = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BrandingSection />
    </SWRConfig>,
  )
  await screen.findByText('Workspace name')
  return r
}

/** The Save/Discard bar only exists while the draft differs from what is
 *  committed, so every test about it has to make one change first. */
function makeDirty() {
  fireEvent.change(screen.getByPlaceholderText('e.g. Acme Studio'), {
    target: { value: 'Acme Studio' },
  })
}

const left = () => document.querySelector('[data-testid="branding-col-left"]')!
const right = () => document.querySelector('[data-testid="branding-col-right"]')!
const headings = (root: ParentNode) =>
  Array.from(root.querySelectorAll('h2')).map((h) => h.textContent!.trim())

beforeEach(() => {
  get.mockReset()
})

describe('the two column wrappers', () => {
  it('exist, and are the only two children of the grid', async () => {
    await renderSection()
    const cols = document.querySelector('.branding-cols')!
    expect(cols).toBeTruthy()
    expect(Array.from(cols.children)).toEqual([left(), right()])
  })

  it('holds name, logo and login logo on the left', async () => {
    await renderSection()
    expect(headings(left())).toEqual(['Workspace name', 'Logo', 'Login page logo'])
  })

  it('holds favicon, theme colors and preview on the right', async () => {
    await renderSection()
    expect(headings(right())).toEqual(['Favicon', 'Theme colors', 'Preview'])
  })

  it('puts Reset in the right column, with the rest of what it resets', async () => {
    // The Reset button only exists when there IS something to reset — a
    // custom name or palette (§178). It is the last thing in the right
    // column, and must not drift to the left one.
    await renderSection(true)
    const reset = screen.getByRole('button', { name: /reset name and colors/i })
    expect(right().contains(reset)).toBe(true)
    expect(left().contains(reset)).toBe(false)
    expect(right().lastElementChild!.contains(reset)).toBe(true)
  })
})

describe('the DOM order, which is the tab order', () => {
  it('is what it was before the split, left column first', async () => {
    await renderSection()
    // Reading order, tab order and the stacked single column are all this
    // list. Column 2 before column 1 in the DOM would read correctly on a
    // wide screen and wrongly on every narrow one.
    expect(headings(document.body)).toEqual([
      'Workspace name',
      'Logo',
      'Login page logo',
      'Favicon',
      'Theme colors',
      'Preview',
    ])
  })

  it('walks the form fields left column first', async () => {
    await renderSection()
    const order = Array.from(
      document.querySelectorAll('input, button'),
    ).filter((el) => !el.closest('[hidden]'))
    const name = screen.getByPlaceholderText('e.g. Acme Studio')
    const firstColour = document.querySelector('input[type="color"]')!
    expect(order.indexOf(name)).toBeLessThan(order.indexOf(firstColour as HTMLElement))
  })
})

describe('the Save/Discard bar', () => {
  it('is a direct child of the section, not of a column', async () => {
    // `position: sticky` inside a grid item is clamped to that item's grid
    // area — one row as tall as the bar, which is no room to move. Out
    // here its containing block is the whole section, which is what makes
    // it pin to the bottom of the viewport.
    await renderSection()
    makeDirty()
    const bar = screen.getByRole('button', { name: /save changes/i }).closest('div.sticky')!
    const root = document.querySelector('.branding-root')!
    expect(bar.parentElement).toBe(root)
    expect(left().contains(bar)).toBe(false)
    expect(right().contains(bar)).toBe(false)
  })

  it('comes after both columns, so it sits below them', async () => {
    await renderSection()
    makeDirty()
    const bar = screen.getByRole('button', { name: /save changes/i }).closest('div.sticky')!
    const cols = document.querySelector('.branding-cols')!
    expect(
      cols.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the -mx-6 bleed it has always had', async () => {
    await renderSection()
    makeDirty()
    const bar = screen.getByRole('button', { name: /save changes/i }).closest('div.sticky')!
    expect(bar.className).toContain('-mx-6')
    expect(bar.className).toContain('sticky')
    expect(bar.className).toContain('bottom-0')
  })
})

describe('the switch is the container, not the window', () => {
  it('establishes a named container on the element that has the tab width', async () => {
    await renderSection()
    // On `.branding-area`, which has no max-width — a container on
    // `.branding-root` would query its own 672px cap and never fire.
    expect(document.querySelector('.branding-area')).toBeTruthy()
    expect(document.querySelector('.branding-area > .branding-root')).toBeTruthy()
    expect(CSS).toMatch(/\.branding-area \{[^}]*container-type: inline-size/)
    expect(CSS).toMatch(/\.branding-area \{[^}]*container-name: branding/)
  })

  it('switches at 992px of container width — 480 + 32 + 480', async () => {
    const m = /@container branding \(min-width: (\d+)px\)/.exec(CSS)
    expect(m).toBeTruthy()
    const threshold = Number(m![1])
    const gap = 32 // the 2rem `.branding-cols` gap, which is `space-y-8`
    expect(threshold).toBe(992)
    // The constraint the number comes from, stated so a re-tune has to
    // keep it: neither column may be narrower than 480px at the switch.
    expect((threshold - gap) / 2).toBeGreaterThanOrEqual(480)
  })

  it('is one column below the threshold and two above it', () => {
    expect(CSS).toMatch(
      /\.branding-cols \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*gap: 2rem/s,
    )
    const block = CSS.split('@container branding (min-width: 992px)')[1]
    expect(block).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)')
    // And the cap comes off only there, so the narrow layout is the old one.
    expect(block).toMatch(/\.branding-area > \.branding-root \{\s*max-width: none/)
    expect(SRC).toContain('max-w-2xl')
  })

  it('uses no viewport breakpoint to do it', async () => {
    await renderSection()
    // A `lg:`/`xl:` grid here would be the bug this replaces: the window is
    // 1440px wide whether or not the app rail and the settings sidebar have
    // taken 416px of it first.
    const cols = document.querySelector('.branding-cols')!
    // One class, no responsive prefixes: the column count is not in the
    // markup at all, so there is nothing here a viewport could drive.
    expect(cols.className).toBe('branding-cols')
    expect(SRC).not.toMatch(/(sm|md|lg|xl|2xl):grid-cols-2 [^"]*branding/)
    // And the rule that turns one column into two is a container query,
    // not a media one: the at-rule immediately before it is @container.
    const at = CSS.lastIndexOf(
      '@',
      CSS.indexOf('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'),
    )
    expect(CSS.slice(at, at + 20)).toContain('@container branding')
  })

  it('adds no dependency to get container queries', () => {
    const pkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    // Raw CSS on purpose (§13c, and the same choice §50 and §224b made).
    expect(pkg).not.toMatch(/container-queries/)
  })
})

describe('the inner Theme colors grid is untouched', () => {
  it('still stacks on a phone and pairs above md', async () => {
    await renderSection()
    const theme = screen.getByText('Theme colors').closest('section')!
    const grid = theme.querySelector('.grid')!
    // Measured at a pinned 480px column: 232px cards, one label
    // ("Background (secondary)") wrapping to two lines, nothing clipped
    // and no overflow until under ~400px. So it stays as it was.
    expect(grid.className).toContain('grid-cols-1')
    expect(grid.className).toContain('md:grid-cols-2')
  })
})
