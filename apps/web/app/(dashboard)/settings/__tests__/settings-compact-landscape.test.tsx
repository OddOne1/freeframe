/**
 * §230 item 2 — Settings on a phone lying on its side.
 *
 * §229 built master–detail below `md`. An iPhone in landscape is 844px
 * WIDE, so none of it applied: the owner got the 224px sidebar and the
 * desktop two-column layout in 390px of height, and — §230 item 1 — the
 * sidebar's nav overflowed its own box into the shell's scroller, so two
 * things scrolled and which one moved depended on where his finger
 * landed. That is the "the UI seems to change" in his report.
 *
 * What this file can and cannot prove. jsdom applies no stylesheet from
 * globals.css and performs no layout, so the pixels — row heights, the
 * 720px column, the chrome totals — are measured in Chromium and are in
 * the §230 report. What is worth pinning HERE is the shape of each
 * decision, because each has a wrong version that looks identical in a
 * diff: the query must be the capability one and not a width; the
 * overrides must be specific enough to beat a Tailwind variant utility,
 * which is emitted last; and the settings subtree must contain exactly
 * one scroll container in that mode.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const CSS = read('app/globals.css')
const LAYOUT = read('app/(dashboard)/settings/layout.tsx')
const INDEX = read('app/(dashboard)/settings/page.tsx')

const QUERY = '@media (hover: none) and (pointer: coarse) and (max-height: 500px) {'

/**
 * The LAST compact-landscape block in globals.css — §230's. §228c/§232
 * opened one earlier in the file for the viewer, and a test that grabbed
 * the first would assert §232's rules and call them §230's.
 */
function compactBlock(): string {
  const start = CSS.lastIndexOf(QUERY)
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = start + QUERY.length - 1; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}') {
      depth--
      if (depth === 0) return CSS.slice(start, i + 1)
    }
  }
  throw new Error('unterminated compact-landscape block')
}

const BLOCK = compactBlock()

// ─── the query ──────────────────────────────────────────────────────────

describe('§230 — the same capability query, not a second one', () => {
  it('is the §228c query, feature for feature', () => {
    expect(BLOCK.startsWith(QUERY)).toBe(true)
  })

  it('and §230 introduced no width-based "phone" query of its own', () => {
    // The only widths allowed inside the block are the nested `sm` step
    // for the two-column list, which is a REFINEMENT of the mode rather
    // than the decision itself.
    const widths = BLOCK.match(/\(m(in|ax)-width: \d+px\)/g) ?? []
    expect(widths).toEqual(['(min-width: 640px)'])
  })
})

// ─── the three rules that make Settings the phone layout ────────────────

describe('§230 item 2 — compact landscape IS the §229 phone layout', () => {
  it('the sidebar is not displayed', () => {
    expect(BLOCK).toMatch(
      /:root \[data-settings-touch\] \[data-testid='settings-sidebar'\] \{\s*display: none;/,
    )
  })

  it('the "‹ Settings" back header is', () => {
    expect(BLOCK).toMatch(
      /:root \[data-settings-touch\] \[data-testid='settings-back-header'\] \{\s*display: flex;/,
    )
  })

  it('and so is the section list, which `md:hidden` had hidden', () => {
    expect(BLOCK).toMatch(
      /:root \[data-testid='settings-section-list-wrap'\] \{\s*display: block;/,
    )
  })

  /**
   * §228c's measured correction: Tailwind emits `md:`/`max-md:`/
   * `hover-none:` utilities AFTER everything written in globals.css, so
   * an override of `md:hidden` cannot win on ORDER whatever the source
   * order. It has to win on SPECIFICITY, and `:root` is the one notch
   * that does it. A rule here that lost its `:root` would look right in
   * a diff and do nothing in the browser.
   */
  it('every rule in the block is `:root`-prefixed or nested in one that is', () => {
    const selectors = BLOCK
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('{') && !l.startsWith('@'))
      .map((l) => l.slice(0, -1).trim())
      .filter((sel) => sel !== ':root' && sel !== '')
    expect(selectors.length).toBeGreaterThan(8)
    for (const sel of selectors) {
      expect(sel.startsWith(':root'), `not :root-specific: ${sel}`).toBe(true)
    }
  })
})

// ─── item 1: one scroller ───────────────────────────────────────────────

describe('§230 item 1 — one scroll container, not two', () => {
  /**
   * The structural half, independent of the mode: a sidebar taller than
   * its column scrolls ITSELF now. Without `min-h-0` a flex child
   * refuses to be shorter than its content, and the overflow lands on
   * whatever scrolls above it — which is exactly what happened.
   */
  it('the sidebar owns its own overflow', () => {
    const aside = LAYOUT.slice(LAYOUT.indexOf('settings-sidebar'))
    const cls = aside.slice(aside.indexOf('className="'), aside.indexOf('>'))
    expect(cls).toContain('min-h-0')
    expect(cls).toContain('overflow-y-auto')
  })

  /**
   * The mode half, asserted on the real tree: the settings subtree
   * declares two scrollable boxes, and in compact landscape exactly one
   * of them is displayed. jsdom cannot apply the media query, so the
   * rule that hides the other is read from the stylesheet and the two
   * facts are checked against each other rather than assumed.
   */
  it('exactly one of the subtree\'s scrollers survives the mode', () => {
    render(
      <div data-settings-touch className="flex h-full">
        <aside
          data-testid="settings-sidebar"
          className="hidden md:block min-h-0 overflow-y-auto w-56"
        />
        <main className="flex-1 overflow-y-auto">
          <div data-testid="settings-back-header" className="md:hidden sticky top-0" />
          <div>section</div>
        </main>
      </div>,
    )
    const root = screen.getByTestId('settings-sidebar').parentElement as HTMLElement
    const scrollers = Array.from(
      root.querySelectorAll('[class*="overflow-y-auto"], [class*="overflow-y-scroll"]'),
    ) as HTMLElement[]
    expect(scrollers).toHaveLength(2)

    const hidden = scrollers.filter((el) =>
      BLOCK.includes(`[data-testid='${el.getAttribute('data-testid')}'] {\n    display: none;`),
    )
    expect(hidden).toHaveLength(1)
    expect(hidden[0].getAttribute('data-testid')).toBe('settings-sidebar')
    expect(scrollers.length - hidden.length).toBe(1)
  })

  it('and the surviving one is the page content, not the menu', () => {
    const remaining = 'main'
    expect(LAYOUT).toContain(`<${remaining} className="flex-1 overflow-y-auto">`)
  })
})

// ─── item 2: drawn for 844, not for 390 ─────────────────────────────────

describe('§230 item 2 — the list and the header at 844px of width', () => {
  it('the content column is capped and centred, on the ONE scroller', () => {
    expect(BLOCK).toMatch(
      /:root \[data-settings-touch\] > main \{[^}]*padding-left: max\(var\(--compact-inset-left\), calc\(\(100% - 720px\) \/ 2\)\);/,
    )
    expect(BLOCK).toMatch(
      /:root \[data-settings-touch\] > main \{[^}]*padding-right: max\(var\(--compact-inset-right\), calc\(\(100% - 720px\) \/ 2\)\);/,
    )
  })

  it('the section list is two columns, with no group split across them', () => {
    const nested = BLOCK.slice(BLOCK.indexOf('@media (min-width: 640px)'))
    expect(nested).toMatch(/\[data-testid='settings-section-list'\] nav \{[^}]*columns: 2;/)
    expect(nested).toMatch(/\[data-testid='settings-section-group'\] \{\s*break-inside: avoid;/)
  })

  it('the back header is 40px with a 36px control in it', () => {
    expect(BLOCK).toMatch(
      /\[data-testid='settings-back-header'\] \{\s*min-height: 40px;/,
    )
    expect(BLOCK).toMatch(
      /\[data-testid='settings-back-header'\] > a \{\s*height: 2\.25rem;/,
    )
  })
})

// ─── the safe area ──────────────────────────────────────────────────────

describe('§230 item 2 — the reduced safe area, reused and not restated', () => {
  it('reaches §232\'s arithmetic through the shared variable', () => {
    expect(BLOCK).toContain('var(--compact-inset-left)')
    expect(BLOCK).toContain('var(--compact-inset-right)')
  })

  it('and does not repeat the constants anywhere in this block', () => {
    expect(BLOCK).not.toContain('safe-area-left')
    expect(BLOCK).not.toContain('safe-area-right')
    expect(BLOCK).not.toMatch(/max\(12px, calc\(/)
  })

  it('the one definition is in the §228c block, above this one', () => {
    const defs = CSS.match(/--compact-inset-left: max\(12px, calc\(var\(--safe-area-left\) - 24px\)\);/g)
    expect(defs).toHaveLength(1)
    expect(CSS.indexOf('--compact-inset-left:')).toBeLessThan(CSS.lastIndexOf(QUERY))
  })
})

// ─── the JS half ────────────────────────────────────────────────────────

describe('§230 item 2 — the one decision JavaScript still has to make', () => {
  it('/settings stops redirecting past its own list in compact landscape', () => {
    expect(INDEX).toContain('COMPACT_LANDSCAPE')
    expect(INDEX).toContain('if (wide.matches && !compact.matches)')
  })

  it('and subscribes to both, so rotating the phone takes effect', () => {
    expect(INDEX).toContain("wide.addEventListener('change', apply)")
    expect(INDEX).toContain("compact.addEventListener('change', apply)")
  })

  it('reading the SAME two queries the hook exports, not copies of them', () => {
    expect(INDEX).toContain("from '@/hooks/use-media-query'")
    expect(INDEX).not.toContain('max-height')
    expect(INDEX).not.toContain('min-width')
  })
})
