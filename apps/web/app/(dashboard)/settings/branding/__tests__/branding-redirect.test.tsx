/**
 * §229 B — `/settings/branding` is a redirect to the Admin tab now.
 *
 * Two halves, and both matter:
 *
 *   - the ROUTE still exists and sends an old bookmark to
 *     `?tab=branding`, rather than 404ing somebody who had it saved;
 *   - nothing in the app still LINKS there, which is the owner's actual
 *     ask ("only one Admin setting to hide"). A redirect that works while
 *     the sidebar keeps pointing at it is a second Admin entry with an
 *     extra hop in it.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`)
})
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }))

import BrandingRedirectPage from '../page'

describe('/settings/branding', () => {
  it('redirects to the Branding tab of Admin, with the tab param', () => {
    expect(() => BrandingRedirectPage()).toThrow(
      'REDIRECT:/settings/admin?tab=branding',
    )
    expect(redirect).toHaveBeenCalledWith('/settings/admin?tab=branding')
  })

  it('is a server redirect — no client bundle for a route that renders nothing', () => {
    const SRC = fs.readFileSync(
      path.join(process.cwd(), 'app/(dashboard)/settings/branding/page.tsx'),
      'utf8',
    )
    expect(SRC).not.toMatch(/'use client'/)
  })
})

describe('nothing in the app links to /settings/branding any more', () => {
  /** Every .ts/.tsx under the app, minus node_modules and this file. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) sources(full, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('not the settings nav, not the sidebar, not anywhere', () => {
    const root = process.cwd()
    const offenders: string[] = []
    for (const file of sources(root)) {
      // The redirect itself and this test are the two places the string
      // is allowed to appear.
      if (file.endsWith('branding/page.tsx')) continue
      if (file.endsWith('branding-redirect.test.tsx')) continue
      const src = fs.readFileSync(file, 'utf8')
      // A QUOTED path — a link, a push, a redirect — and not the prose
      // mentions in the comments that explain where Branding went, which
      // are written in backticks.
      if (/['"]\/settings\/branding/.test(src)) {
        offenders.push(path.relative(root, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('and the nav list itself has no Branding entry', async () => {
    const { settingsNavGroups } = await import('@/lib/settings-nav')
    const labels = settingsNavGroups.flat().map((i) => i.label)
    expect(labels).not.toContain('Branding')
    expect(labels).toContain('Admin')
  })
})
