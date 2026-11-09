/**
 * The rules behind the SocialSnippet clip cards, without React: autosave
 * (debounce, merging, undo), the keyboard shortcuts, the one-player-at-a-time
 * rule, topic editing and which track a clip is on. Each is tested in
 * lib/__tests__/snippet-card.test.ts.
 */

// ─── Autosave ────────────────────────────────────────────────────────────────

/** How long a card waits after the last change before it saves. */
export const AUTOSAVE_DELAY_MS = 600

/** Later values win; arrays (topics) are replaced, never concatenated. */
export function mergePatch<P extends object>(a: P | null, b: P): P {
  return { ...(a ?? ({} as P)), ...b }
}

/**
 * The patch that puts back what `patch` changed: each of its keys with the
 * value it had in `before`. Keys whose value does not change are left out.
 */
export function inversePatch<P extends object>(before: P, patch: Partial<P>): Partial<P> {
  const out: Partial<P> = {}
  for (const k of Object.keys(patch) as (keyof P)[]) {
    if (!sameValue(before[k], patch[k])) out[k] = before[k]
  }
  return out
}

/** Undo across a burst of changes goes back to before the FIRST of them:
 *  the earliest "before" value of each key wins. */
export function mergeInverse<P extends object>(earlier: Partial<P> | null, later: Partial<P>): Partial<P> {
  return { ...later, ...(earlier ?? {}) }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

export function isEmptyPatch(p: object | null | undefined): boolean {
  return !p || Object.keys(p).length === 0
}

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export interface AutosaveStatus {
  state: AutosaveState
  error?: unknown
}

export interface AutosaveOptions<P extends object, R> {
  save: (patch: P) => Promise<R>
  delayMs?: number
  /** Every state change. */
  onStatus?: (s: AutosaveStatus) => void
  /** A save went through: what was sent, what the server answered, and the
   *  patch that undoes it (empty when the save was itself an undo). */
  onSaved?: (result: R, sent: P, inverse: Partial<P>) => void
  /** Injected in tests; setTimeout/clearTimeout otherwise. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/**
 * Debounced saving that merges every change made in the wait into one PATCH.
 *
 * - `queue(patch, inverse)` merges the patch into what is pending and
 *   restarts the wait; the inverse is merged so undo goes back to before the
 *   first change of the burst.
 * - Only one save runs at a time. Changes made while it runs wait and are
 *   sent after it, so the server always ends on the newest values.
 * - A failed save keeps its patch (under anything newer) for `flush()` to
 *   retry; nothing is lost on screen.
 */
export function createAutosaver<P extends object, R = unknown>(opts: AutosaveOptions<P, R>) {
  const delay = opts.delayMs ?? AUTOSAVE_DELAY_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))

  let pending: P | null = null
  let pendingInverse: Partial<P> | null = null
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let status: AutosaveStatus = { state: 'idle' }
  let disposed = false

  const setStatus = (s: AutosaveStatus) => {
    status = s
    if (!disposed) opts.onStatus?.(s)
  }

  function schedule() {
    if (timer != null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void run()
    }, delay)
  }

  async function run(): Promise<void> {
    if (inFlight) {
      // Sent after the current save finishes (see the end of the loop).
      await inFlight
      return
    }
    if (isEmptyPatch(pending)) return
    const sent = pending as P
    const inverse = pendingInverse ?? {}
    pending = null
    pendingInverse = null
    setStatus({ state: 'saving' })
    let failed = false
    inFlight = (async () => {
      try {
        const result = await opts.save(sent)
        if (!disposed) opts.onSaved?.(result, sent, inverse)
      } catch (error) {
        failed = true
        // Keep what failed, under anything changed since.
        pending = mergePatch(sent, pending ?? ({} as P))
        pendingInverse = mergeInverse(inverse, pendingInverse ?? {})
        setStatus({ state: 'error', error })
      }
    })()
    await inFlight
    inFlight = null
    if (failed) return
    if (!isEmptyPatch(pending)) {
      // Changed while saving: if its wait is over, send it now.
      if (timer == null) await run()
      else setStatus({ state: 'pending' })
    } else {
      setStatus({ state: 'saved' })
    }
  }

  return {
    queue(patch: Partial<P>, inverse: Partial<P> = {}) {
      if (disposed || isEmptyPatch(patch)) return
      pending = mergePatch(pending, patch as P)
      pendingInverse = mergeInverse(pendingInverse, inverse)
      if (status.state !== 'saving') setStatus({ state: 'pending' })
      schedule()
    },
    /** Save what is pending now (Enter in a field, Retry, leaving the page). */
    async flush() {
      if (timer != null) {
        clearTimer(timer)
        timer = null
      }
      await run()
    },
    /** Forget unsaved changes (used before an undo replaces them). */
    cancel() {
      if (timer != null) clearTimer(timer)
      timer = null
      pending = null
      pendingInverse = null
      if (status.state === 'pending' || status.state === 'error') setStatus({ state: 'idle' })
    },
    /** What is waiting to be sent. */
    pending: () => pending,
    pendingInverse: () => pendingInverse,
    status: () => status,
    /** True while something is waiting or being sent. */
    busy: () => timer != null || inFlight != null || !isEmptyPatch(pending),
    dispose() {
      disposed = true
      if (timer != null) clearTimer(timer)
      timer = null
    },
  }
}

export type Autosaver<P extends object, R = unknown> = ReturnType<typeof createAutosaver<P, R>>

/** The words of the Undo toast, from what a save changed. */
export function describeChange(patch: {
  title?: unknown
  topics?: unknown
  status?: string
  start_ms?: unknown
  end_ms?: unknown
}): string {
  const parts: string[] = []
  if ('start_ms' in patch || 'end_ms' in patch) parts.push('in/out')
  if ('title' in patch) parts.push('title')
  if ('topics' in patch) parts.push('topics')
  if ('status' in patch) {
    const word =
      patch.status === 'approved' ? 'Approved' : patch.status === 'rejected' ? 'Rejected' : 'Back to suggested'
    if (parts.length === 0) return word
    parts.push('status')
  }
  if (parts.length === 0) return 'Saved'
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const list = [first, ...parts.slice(1)]
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `${text} saved`
}

// ─── Topics ──────────────────────────────────────────────────────────────────

/** The longest topic the card accepts. */
export const MAX_TOPIC_LENGTH = 64

/** Adds a topic typed by a person: trimmed, a leading "#" dropped, inner
 *  whitespace collapsed, and not added twice (case-insensitively). Returns
 *  the same array when nothing changes. */
export function addTopic(topics: readonly string[], raw: string): string[] {
  const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC_LENGTH)
  if (!t) return topics as string[]
  if (topics.some((x) => x.toLowerCase() === t.toLowerCase())) return topics as string[]
  return [...topics, t]
}

export function removeTopic(topics: readonly string[], topic: string): string[] {
  return topics.filter((x) => x.toLowerCase() !== topic.toLowerCase())
}

// ─── Which track a clip is on ────────────────────────────────────────────────

/**
 * The track that speaks most of [start, end): a clip's speaker is its
 * track's speaker, and the clip itself does not name the track. Null when no
 * segment overlaps.
 */
export function dominantTrack(
  segments: readonly { track_index: number; start_ms: number; end_ms: number }[],
  range: { start_ms: number; end_ms: number },
): number | null {
  const overlap = new Map<number, number>()
  for (const s of segments) {
    const o = Math.min(s.end_ms, range.end_ms) - Math.max(s.start_ms, range.start_ms)
    if (o > 0) overlap.set(s.track_index, (overlap.get(s.track_index) ?? 0) + o)
  }
  let best: number | null = null
  let bestMs = 0
  overlap.forEach((ms, track) => {
    if (ms > bestMs || (ms === bestMs && best != null && track < best)) {
      best = track
      bestMs = ms
    }
  })
  return best
}

// ─── One player at a time ────────────────────────────────────────────────────

export interface GroupPlayer {
  pause: () => void
}

/**
 * The clip grid's player rule: at most ONE card has a player, and at most one
 * plays. `activate(key)` makes a card the one with the player (the page
 * mounts the <video> only there); `playing(key)` is called when a player
 * actually starts and pauses every other registered player, which covers a
 * player that has not unmounted yet. Unregistering does not clear the active
 * key: a card that is only re-rendering must not lose its player.
 */
export function createPlayerGroup() {
  let active: string | null = null
  const players = new Map<string, GroupPlayer>()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())

  function pauseOthers(key: string | null) {
    players.forEach((p, k) => {
      if (k !== key) p.pause()
    })
  }

  return {
    active: () => active,
    activate(key: string) {
      if (active === key) return
      pauseOthers(key)
      active = key
      emit()
    },
    playing(key: string) {
      pauseOthers(key)
      if (active !== key) {
        active = key
        emit()
      }
    },
    /** The card closed its player (or went away while active). */
    release(key: string) {
      if (active !== key) return
      players.get(key)?.pause()
      active = null
      emit()
    },
    register(key: string, player: GroupPlayer) {
      players.set(key, player)
      return () => {
        if (players.get(key) === player) players.delete(key)
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type PlayerGroup = ReturnType<typeof createPlayerGroup>

// ─── Keyboard shortcuts ──────────────────────────────────────────────────────

export type ShortcutAction =
  | { type: 'toggle-play' }
  | { type: 'seek'; deltaMs: number }
  | { type: 'set-in' }
  | { type: 'set-out' }
  | { type: 'toggle-expand' }

/**
 * What the key was pressed on:
 *  - typing     a text field, select or editable region: no shortcuts at all
 *  - overlay    inside a dialog, popover, listbox or menu: theirs, not ours
 *  - slider     an in/out handle: it uses the arrows itself
 *  - composite  tabs, radios, options: arrows move between them
 *  - control    a button or link: Space presses it
 *  - other      anything else
 */
export type TargetKind = 'typing' | 'overlay' | 'slider' | 'composite' | 'control' | 'other'

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color'])

export function targetKind(target: EventTarget | null): TargetKind {
  const el = target as (Element & { isContentEditable?: boolean }) | null
  if (!el || typeof (el as Element).closest !== 'function') return 'other'
  const tag = el.tagName.toLowerCase()
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (type === 'range') return 'slider'
    if (!NON_TEXT_INPUTS.has(type)) return 'typing'
  }
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) return 'typing'
  if (el.closest('[contenteditable]:not([contenteditable="false"])')) return 'typing'
  const role = el.getAttribute('role')
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return 'typing'
  if (el.closest('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return 'overlay'
  if (role === 'slider') return 'slider'
  if (role === 'tab' || role === 'radio' || role === 'option' || role === 'menuitem') return 'composite'
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'input' || role === 'button' || role === 'switch' || role === 'checkbox') {
    return 'control'
  }
  return 'other'
}

export interface KeyLike {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/** The shortcut a key press means, or null to leave the key alone. */
export function shortcutFor(e: KeyLike, kind: TargetKind): ShortcutAction | null {
  if (kind === 'typing' || kind === 'overlay') return null
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const key = e.key
  if (key === ' ' || key === 'Spacebar') {
    return kind === 'control' || kind === 'slider' || kind === 'composite' ? null : { type: 'toggle-play' }
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (kind === 'slider' || kind === 'composite') return null
    const step = e.shiftKey ? 100 : 1000
    return { type: 'seek', deltaMs: key === 'ArrowLeft' ? -step : step }
  }
  if (e.shiftKey) return null
  switch (key.toLowerCase()) {
    case 'i':
      return { type: 'set-in' }
    case 'o':
      return { type: 'set-out' }
    case 'e':
      return { type: 'toggle-expand' }
    default:
      return null
  }
}

/** The help popover's rows. */
export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Space'], label: 'Play / pause the active clip' },
  { keys: ['I'], label: 'Set the in point at the playhead' },
  { keys: ['O'], label: 'Set the out point at the playhead' },
  { keys: ['←', '→'], label: 'Seek 1 second' },
  { keys: ['Shift', '←', '→'], label: 'Seek 0.1 second' },
  { keys: ['E'], label: 'Open / close the focused clip' },
]

/** A clip key usable in a DOM attribute and a CSS selector. */
export function cardKeyOf(groupKey: string, clipId: string): string {
  return `${groupKey}::${clipId}`.replace(/[^A-Za-z0-9_:-]/g, '_')
}
