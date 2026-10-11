/**
 * The crumb bar across a sequence of route changes (§227).
 *
 * The owner's report, from a real phone: after opening an asset and then
 * Settings, the bar read
 *
 *   Settings › Admin › src › Video › Reaction_watchparty › Cam_B › A010C030….MXF
 *
 * and on the Projects list — which below `sm` shows only the LAST crumb —
 * it read `› Fabio_close`, the name of an asset two pages ago.
 *
 * Cause: `stores/breadcrumb-store.ts` is global and the Header never
 * unmounts, so whatever the last project or asset page wrote stayed there.
 * `clearLabels` existed and had no caller.
 *
 * These tests drive the REAL Header against the REAL store and assert the
 * text the bar renders, not the store's contents — the store could hold
 * anything as long as the bar is right, and the bar being right is the
 * whole report. Each `navigate()` below writes exactly what the page at
 * that route writes, in the order its effects run.
 *
 * Deliberately, `navigate()` does NOT clear on the way out: the fix has to
 * be the pathname the crumbs are stored against, not a cleanup call that
 * the next route can forget to make. The unmount clear is asserted
 * separately, as the second layer it is.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'

const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const ASSET = '33333333-3333-4333-8333-333333333333'

let pathname = '/projects'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))

import { Header } from '../header'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'

let rerender: () => void

function mountHeader() {
  const r = render(<Header onSearchOpen={() => {}} />)
  // The Header is mounted once by the dashboard layout and survives every
  // route change — which is exactly why a stale entry showed at all. The
  // same instance is re-rendered below rather than re-mounted.
  rerender = () => r.rerender(<Header onSearchOpen={() => {}} />)
  return r
}

/** The crumb elements, in order, chevrons excluded. */
function crumbEls(): HTMLElement[] {
  const nav = document.querySelector('header nav') as HTMLElement
  return Array.from(nav.children).filter(
    (el) => el.tagName === 'A' || el.tagName === 'SPAN',
  ) as HTMLElement[]
}

/** What the bar says at `sm`+, where every crumb shows. */
function crumbs(): (string | null)[] {
  return crumbEls().map((el) => el.textContent)
}

/**
 * What a PHONE shows. Derived from the classes the Header actually puts on
 * each crumb (`hidden sm:block` on all but the last) rather than from an
 * assumption that it is the last one — jsdom applies no media queries, so
 * this is the only honest way to ask.
 */
function phoneCrumbs(): (string | null)[] {
  return crumbEls()
    .filter((el) => !el.className.split(/\s+/).includes('hidden'))
    .map((el) => el.textContent)
}

// ─── The pages, as the store sees them ──────────────────────────────────

/** projects/[id]/page.tsx: the project name, then the folder path. */
function projectPage(projectId: string, name: string, folders: { id: string; name: string }[] = []) {
  const path = `/projects/${projectId}`
  const s = useBreadcrumbStore.getState()
  s.setLabel(path, projectId, name)
  s.setExtraCrumbs(
    path,
    folders.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` })),
  )
}

/** assets/[assetId]/page.tsx: the folder path and the asset name, then the label. */
function assetPage(
  projectId: string,
  assetId: string,
  projectName: string,
  folders: { id: string; name: string }[],
  assetName: string,
) {
  const path = `/projects/${projectId}/assets/${assetId}`
  const s = useBreadcrumbStore.getState()
  s.setExtraCrumbs(path, [
    ...folders.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` })),
    { label: assetName },
  ])
  s.setLabel(path, projectId, projectName)
}

/** A route change. The page at the new route writes what it knows. */
function navigate(to: string, write?: () => void) {
  pathname = to
  write?.()
  rerender()
}

beforeEach(() => {
  pathname = '/projects'
  useBreadcrumbStore.setState({ pathname: null, labels: {}, extraCrumbs: [] })
})

// ─── The reported sequence ──────────────────────────────────────────────

describe('§227 — project → asset → settings, the owner’s sequence', () => {
  it('shows each page’s own crumbs and no previous page’s', () => {
    mountHeader()
    expect(crumbs()).toEqual(['Projects'])

    navigate(`/projects/${PROJECT_A}`, () =>
      projectPage(PROJECT_A, 'Admin_Project', [
        { id: 'f1', name: 'src' },
        { id: 'f2', name: 'Video' },
      ]),
    )
    expect(crumbs()).toEqual(['Projects', 'Admin_Project', 'src', 'Video'])

    navigate(`/projects/${PROJECT_A}/assets/${ASSET}`, () =>
      assetPage(
        PROJECT_A,
        ASSET,
        'Admin_Project',
        [
          { id: 'f1', name: 'src' },
          { id: 'f2', name: 'Video' },
          { id: 'f3', name: 'Reaction_watchparty' },
          { id: 'f4', name: 'Cam_B' },
        ],
        'A010C030_250101_R1AB.MXF',
      ),
    )
    expect(crumbs()).toEqual([
      'Projects',
      'Admin_Project',
      'src',
      'Video',
      'Reaction_watchparty',
      'Cam_B',
      'A010C030_250101_R1AB.MXF',
    ])

    // Settings writes nothing at all, so this is the exact state the bug
    // was reported in: the asset page's crumbs are still in the store.
    navigate('/settings/admin')
    expect(crumbs()).toEqual(['Settings', 'Admin'])
  })

  it('and on a phone, Settings is not labelled with a clip name', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}/assets/${ASSET}`, () =>
      assetPage(PROJECT_A, ASSET, 'Admin_Project', [{ id: 'f4', name: 'Cam_B' }], 'Fabio_close'),
    )
    expect(phoneCrumbs()).toEqual(['Fabio_close'])

    navigate('/settings/admin')
    expect(phoneCrumbs()).toEqual(['Admin'])

    // The reported one: `› Fabio_close` on the Projects list.
    navigate('/projects')
    expect(phoneCrumbs()).toEqual(['Projects'])
  })

  it('clearing on unmount as well changes nothing about the outcome', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}`, () => projectPage(PROJECT_A, 'Admin_Project', [{ id: 'f1', name: 'src' }]))
    // The page's cleanup runs as React unmounts it, before the next route's
    // effects. Both layers active must give the same bar as either alone.
    navigate('/settings/admin', () => useBreadcrumbStore.getState().clear(`/projects/${PROJECT_A}`))
    expect(crumbs()).toEqual(['Settings', 'Admin'])
  })
})

// ─── Project to project ─────────────────────────────────────────────────

describe('§227 — project A → project B', () => {
  it('shows nothing of A while B is still loading', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}`, () =>
      projectPage(PROJECT_A, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }]),
    )
    expect(crumbs()).toEqual(['Projects', 'Just Ride 2026', 'Podcast'])

    // B's name and folders arrive over the network; the bar renders first.
    navigate(`/projects/${PROJECT_B}`)
    expect(crumbs()).toEqual(['Projects'])

    navigate(`/projects/${PROJECT_B}`, () => projectPage(PROJECT_B, 'Second Project'))
    expect(crumbs()).toEqual(['Projects', 'Second Project'])
  })

  it('never shows A’s label or A’s folder path on B', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}`, () =>
      projectPage(PROJECT_A, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }]),
    )
    navigate(`/projects/${PROJECT_B}`, () => projectPage(PROJECT_B, 'Second Project'))
    const text = crumbs().join(' / ')
    expect(text).not.toMatch(/Just Ride 2026/)
    expect(text).not.toMatch(/Podcast/)
  })
})

// ─── Back out of an asset, and the history buttons ──────────────────────

describe('§227 — asset → back to the folder', () => {
  it('drops the asset name and keeps the folder path', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}/assets/${ASSET}`, () =>
      assetPage(PROJECT_A, ASSET, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }], 'Fabio_close'),
    )
    expect(crumbs()).toEqual(['Projects', 'Just Ride 2026', 'Podcast', 'Fabio_close'])

    navigate(`/projects/${PROJECT_A}`, () =>
      projectPage(PROJECT_A, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }]),
    )
    expect(crumbs()).toEqual(['Projects', 'Just Ride 2026', 'Podcast'])
  })

  it('survives Back and Forward, which are route changes like any other', () => {
    mountHeader()
    const toProject = () =>
      navigate(`/projects/${PROJECT_A}`, () =>
        projectPage(PROJECT_A, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }]),
      )
    const toAsset = () =>
      navigate(`/projects/${PROJECT_A}/assets/${ASSET}`, () =>
        assetPage(PROJECT_A, ASSET, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }], 'Fabio_close'),
      )

    toProject()
    toAsset()
    navigate('/settings/profile')
    expect(crumbs()).toEqual(['Settings', 'Profile'])

    // Back: to the asset. Forward again: to Settings.
    toAsset()
    expect(crumbs()).toEqual(['Projects', 'Just Ride 2026', 'Podcast', 'Fabio_close'])
    navigate('/settings/profile')
    expect(crumbs()).toEqual(['Settings', 'Profile'])

    // Back twice, landing on the project with its folder still open.
    toProject()
    expect(crumbs()).toEqual(['Projects', 'Just Ride 2026', 'Podcast'])
  })
})

// ─── Pages that write nothing ───────────────────────────────────────────

describe('§227 — pages with no crumbs of their own', () => {
  it('a direct load of /settings/admin shows only its URL crumbs', () => {
    pathname = '/settings/admin'
    mountHeader()
    expect(crumbs()).toEqual(['Settings', 'Admin'])
  })

  it('the collections page, which registers nothing, shows the URL only', () => {
    mountHeader()
    navigate(`/projects/${PROJECT_A}/assets/${ASSET}`, () =>
      assetPage(PROJECT_A, ASSET, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }], 'Fabio_close'),
    )
    // `collections` is in SKIP_SEGMENTS and the page registers no label for
    // the project UUID, so the UUID is skipped too — the bar is `Projects`
    // alone, not `Projects › … › Fabio_close`.
    navigate(`/projects/${PROJECT_A}/collections`)
    expect(crumbs()).toEqual(['Projects'])
  })
})

// ─── The second layer ───────────────────────────────────────────────────

describe('§227 — clearing on unmount', () => {
  it('empties the store, so nothing stale is even held', () => {
    projectPage(PROJECT_A, 'Just Ride 2026', [{ id: 'f1', name: 'Podcast' }])
    expect(useBreadcrumbStore.getState().extraCrumbs).toHaveLength(1)

    useBreadcrumbStore.getState().clear(`/projects/${PROJECT_A}`)
    expect(useBreadcrumbStore.getState()).toMatchObject({
      pathname: null,
      labels: {},
      extraCrumbs: [],
    })
  })

  it('a late unmount cannot wipe what the next page already wrote', () => {
    mountHeader()
    // React can commit the new page's effects before the old page's
    // cleanup in a transition; an unguarded clear would blank the bar.
    navigate(`/projects/${PROJECT_B}`, () => projectPage(PROJECT_B, 'Second Project'))
    useBreadcrumbStore.getState().clear(`/projects/${PROJECT_A}`)
    rerender()
    expect(crumbs()).toEqual(['Projects', 'Second Project'])
  })
})
