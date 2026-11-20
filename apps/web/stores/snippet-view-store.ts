import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import {
  type ClipGridSize,
  type ClipTextSize,
  isClipGridSize,
  isClipTextSize,
} from '@/components/snippets/clip-display'

/**
 * The SocialSnippet Clips tab's display settings: grid size and text size.
 * Stored like the project view's card size (stores/view-store.ts,
 * stores/project-view-store.ts): a zustand store persisted to localStorage,
 * under a key of its own so it never moves another view's settings.
 *
 * Unlike those, every storage call is wrapped: with storage blocked (private
 * mode, site data off) a read is "nothing stored" and a write is dropped, so
 * the controls still work for the visit instead of throwing on click.
 */
export const SNIPPET_VIEW_STORAGE_KEY = 'freeframe-snippet-view-settings'

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return window.localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    try {
      window.localStorage.setItem(name, value)
    } catch {
      // Blocked or full: keep the choice for this visit only.
    }
  },
  removeItem: (name) => {
    try {
      window.localStorage.removeItem(name)
    } catch {
      // As above.
    }
  },
}

interface SnippetViewStore {
  clipGridSize: ClipGridSize
  clipTextSize: ClipTextSize
  setClipGridSize: (size: ClipGridSize) => void
  setClipTextSize: (size: ClipTextSize) => void
}

export const useSnippetViewStore = create<SnippetViewStore>()(
  persist(
    (set) => ({
      // Today's sizes, so nobody's view changes on upgrade.
      clipGridSize: 'small',
      clipTextSize: 'normal',
      setClipGridSize: (clipGridSize) => set({ clipGridSize }),
      setClipTextSize: (clipTextSize) => set({ clipTextSize }),
    }),
    {
      name: SNIPPET_VIEW_STORAGE_KEY,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ clipGridSize: s.clipGridSize, clipTextSize: s.clipTextSize }),
      // A stored value this version does not know falls back to the default.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SnippetViewStore>
        return {
          ...current,
          clipGridSize: isClipGridSize(p.clipGridSize) ? p.clipGridSize : current.clipGridSize,
          clipTextSize: isClipTextSize(p.clipTextSize) ? p.clipTextSize : current.clipTextSize,
        }
      },
    },
  ),
)
