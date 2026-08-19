import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CardSize } from './view-store'

/**
 * Card size on the Projects overview — deliberately separate from the
 * in-project grid's `cardSize` (CLAUDE.md §51, the user's explicit
 * decision): changing one must not move the other.
 *
 * Its own store rather than a second field on view-store, so it also gets
 * its own localStorage key. A shared key would make "independent" true only
 * until someone reads the wrong field.
 */
interface ProjectViewStore {
  projectCardSize: CardSize
  setProjectCardSize: (size: CardSize) => void
}

export const useProjectViewStore = create<ProjectViewStore>()(
  persist(
    (set) => ({
      // Matches the density the overview shipped with, so nobody's existing
      // view changes on upgrade.
      projectCardSize: 'S',
      setProjectCardSize: (projectCardSize) => set({ projectCardSize }),
    }),
    { name: 'freeframe-project-view-settings' },
  ),
)
