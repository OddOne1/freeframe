/**
 * The folder shown must follow the URL (CLAUDE.md §29).
 *
 * The bug was that `currentFolderId` came from a useState initializer, so a
 * breadcrumb click — a same-route, query-only transition that never
 * remounts the page — changed the address bar and nothing else. Back and
 * forward were broken for the same reason, plus the only writer used
 * window.history.replaceState, which the Next router never observes.
 *
 * These assert the derivation itself rather than rendering the whole
 * project page, which pulls in SWR, the upload store and a dozen dialogs.
 * What regressed was one rule: read the param every render, and navigate
 * rather than set local state. A structural assertion pins exactly that,
 * and says so rather than pretending to be a behavioural test.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const PAGE = fs.readFileSync(
  path.join(process.cwd(), 'app/(dashboard)/projects/[id]/page.tsx'),
  'utf8',
)

describe('§29 — the URL is the source of truth for the open folder', () => {
  it('derives currentFolderId from searchParams on every render', () => {
    expect(PAGE).toMatch(/const currentFolderId = searchParams\.get\("folder"\) \|\| null/)
  })

  it('no longer seeds it into useState, which only ran once', () => {
    expect(PAGE).not.toMatch(/useState<string \| null>\(\s*searchParams\.get\("folder"\)/)
    expect(PAGE).not.toMatch(/setCurrentFolderId/)
  })

  it('writes the folder through the router, not window.history', () => {
    // replaceState changes the URL without telling Next, so nothing
    // re-renders and the back button has nothing to restore.
    // The call, not the word — the comment above the fix names it too.
    expect(PAGE).not.toMatch(/window\.history\.replaceState\(/)
    expect(PAGE).toMatch(/router\.push\(url, \{ scroll: false \}\)/)
    expect(PAGE).toMatch(/router\.replace\(url, \{ scroll: false \}\)/)
  })

  it('pushes for folder navigation, so Back walks folder history', () => {
    const at = PAGE.indexOf('const handleSelectFolder')
    const handler = PAGE.slice(at, at + 600)
    expect(handler).toMatch(/goToFolder\(folderId\)/)
    // Not the replace variant — that would make Back skip past folders.
    expect(handler).not.toMatch(/goToFolder\(folderId, \{ replace/)
  })

  it('replaces for Trash and Share Links, which the URL does not encode', () => {
    // A push here would let Back restore the folder while leaving the
    // Trash/Share view open — a state the URL cannot describe.
    const replaces = PAGE.match(/goToFolder\(null, \{ replace: true \}\)/g) ?? []
    expect(replaces.length).toBe(3)
  })

  it('still opens straight into ?folder= on a cold load', () => {
    // Derivation covers this for free, which is the point: the behaviour
    // the old useState initializer existed for is preserved by the very
    // line that fixes the bug.
    expect(PAGE).toMatch(/searchParams\.get\("folder"\)/)
  })
})
