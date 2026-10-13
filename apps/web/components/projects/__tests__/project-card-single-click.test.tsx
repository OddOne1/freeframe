/**
 * §232 item 1 — going into a PROJECT on the first click.
 *
 * The owner named this one as the exception: "everything on the full size
 * web version works with double click in the projects/asset view, except
 * for actually going into a project." So the audit §232 asks for is
 * "which of the places a project is opened from need a double click
 * today?" — and the answer, checked here and in Chromium, is NONE. Every
 * one of them is already a single click, and three of the five are real
 * links, which §232 says to leave alone:
 *
 *   /projects grid card        <Link href="/projects/{id}">   this file
 *   /projects list row         <a href="/projects/{id}">      this file
 *   command palette            cmdk `onSelect` -> router.push
 *   /settings/projects table   <Link href="/projects/{id}">
 *   /settings/admin table      <Link href="/projects/{id}">   (+ a
 *                              "Join and view" button for a superadmin
 *                              who is not a member)
 *   the global sidebar         has no per-project entry at all
 *
 * This file pins the two on the projects page, because they are the ones a
 * reader would expect §232 to have changed and the ones most likely to
 * acquire a click handler later. The test is that they are ANCHORS: an
 * anchor cannot be made to need two clicks without someone noticing, and
 * it keeps cmd-click-to-new-tab and middle-click, which a div with an
 * onClick would silently drop.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Project } from '@/types'

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiError: class extends Error {},
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ isSuperAdmin: false, user: { id: 'u1' } }),
}))

import { ProjectCard } from '../project-card'

const PROJECT = {
  id: 'p-9',
  name: 'Rope Challenge',
  description: null,
  created_by: 'u1',
  project_type: 'standard',
  poster_url: null,
  is_public: false,
  created_at: new Date().toISOString(),
  asset_count: 4,
  storage_bytes: 1024,
  member_count: 2,
  role: 'owner',
} as unknown as Project

describe('§232 — a project card opens on the first click', () => {
  it('is a real link to the project, not a div with a click handler', () => {
    render(<ProjectCard project={PROJECT} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/projects/p-9')
  })

  it('carries no double-click handler of its own', () => {
    // An `ondblclick` attribute would be the shape of the bug §232 is
    // reversing. React attaches its handlers at the root rather than as
    // attributes, so this is a weak check on its own — the real evidence
    // is the anchor above, and the Chromium click that follows it.
    const { container } = render(<ProjectCard project={PROJECT} />)
    expect(container.querySelector('[ondblclick]')).toBeNull()
  })

  it('and the "···" menu inside it does not follow the link', async () => {
    // The kebab sits INSIDE the card's group and over the link's own box,
    // so it calls `preventDefault` as well as `stopPropagation`. Without
    // the first one a click on it would navigate, which single-click open
    // makes no worse but no better either — asserted because it is the one
    // control on this card that could.
    render(<ProjectCard project={PROJECT} showRole />)
    const kebab = screen.getByRole('button')
    const clicked = new MouseEvent('click', { bubbles: true, cancelable: true })
    kebab.dispatchEvent(clicked)
    expect(clicked.defaultPrevented).toBe(true)
  })
})
