import { create } from 'zustand'

interface Crumb {
  label: string
  href?: string
}

/**
 * What the Header shows between the hamburger and the search box (§227).
 *
 * The crumbs are written by the PAGE — a project name against its UUID
 * segment, a folder path, an asset name — because only the page knows
 * them. The Header, which renders them, outlives every page in the app:
 * it is mounted by the dashboard layout and never unmounts on a route
 * change.
 *
 * That is the whole reason this store carries a `pathname`. §224's version
 * did not, and nothing ever cleared it, so the crumbs an asset page wrote
 * stayed in the bar on every page after it: the owner's phone showed
 * `Settings › … › A010C030…MXF` on the Settings page and `› Fabio_close`
 * on the Projects list. `clearLabels` existed and had no caller.
 *
 * Adding `clear()` calls to the pages would have been the same design with
 * more places to forget it. Instead the crumbs are stored TOGETHER WITH the
 * pathname they describe, and `useBreadcrumbsFor` hands them back only to
 * the page they were written for. A stale entry is then not a bug that
 * shows, it is an entry nobody asks for — and a page that forgets to clean
 * up, a route this file has never heard of, or a write that lands a tick
 * after the route changed all end up showing nothing rather than something
 * wrong.
 *
 * The writes take the pathname as their first argument rather than reading
 * it from a router, so the store stays a plain store: no hook, no
 * Next-only import, testable by calling it.
 */
interface BreadcrumbStore {
  /**
   * The pathname `labels` and `extraCrumbs` below belong to, or null when
   * nothing is stored. Writing for a DIFFERENT pathname replaces both:
   * crumbs never accumulate across pages.
   */
  pathname: string | null
  /** Map of path segments (e.g. UUID) → display label */
  labels: Record<string, string>
  /** Extra crumbs injected after the URL-based crumbs (e.g. folder path) */
  extraCrumbs: Crumb[]
  setLabel: (pathname: string, segment: string, label: string) => void
  setExtraCrumbs: (pathname: string, crumbs: Crumb[]) => void
  /**
   * Drop what is stored. With a pathname, only if the entry still belongs
   * to it — so a page unmounting AFTER its successor has already written
   * cannot wipe the new page's crumbs. That ordering happens on every
   * client-side navigation in React 18.
   */
  clear: (pathname?: string) => void
}

const EMPTY = { labels: {} as Record<string, string>, extraCrumbs: [] as Crumb[] }

export const useBreadcrumbStore = create<BreadcrumbStore>((set) => ({
  pathname: null,
  labels: {},
  extraCrumbs: [],
  setLabel: (pathname, segment, label) =>
    set((s) =>
      s.pathname === pathname
        ? { labels: { ...s.labels, [segment]: label } }
        : { pathname, labels: { [segment]: label }, extraCrumbs: [] },
    ),
  setExtraCrumbs: (pathname, extraCrumbs) =>
    set((s) =>
      s.pathname === pathname
        ? { extraCrumbs }
        : { pathname, labels: {}, extraCrumbs },
    ),
  clear: (pathname) =>
    set((s) =>
      pathname !== undefined && s.pathname !== pathname
        ? s
        : { pathname: null, labels: {}, extraCrumbs: [] },
    ),
}))

/**
 * The crumbs for THIS page, and nothing else.
 *
 * Read by the Header, which is the only consumer: it passes the pathname it
 * is currently rendering, and an entry written for any other page is
 * ignored rather than appended. Removing that comparison is what brings the
 * reported bug back, which is what `header-breadcrumbs.test.tsx` asserts.
 */
export function useBreadcrumbsFor(pathname: string): {
  labels: Record<string, string>
  extraCrumbs: Crumb[]
} {
  const stored = useBreadcrumbStore()
  return stored.pathname === pathname
    ? { labels: stored.labels, extraCrumbs: stored.extraCrumbs }
    : EMPTY
}
