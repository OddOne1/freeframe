import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOSAVE_DELAY_MS,
  addTopic,
  cardKeyOf,
  createAutosaver,
  createPlayerGroup,
  describeChange,
  dominantTrack,
  inversePatch,
  mergeInverse,
  mergePatch,
  removeTopic,
  shortcutFor,
  targetKind,
} from '../snippet-card'

type Patch = { title?: string | null; topics?: string[]; start_ms?: number; end_ms?: number; status?: string }

// ─── Patch merging ───────────────────────────────────────────────────────────

describe('mergePatch / inversePatch / mergeInverse', () => {
  it('later values win and arrays are replaced', () => {
    expect(mergePatch<Patch>({ title: 'a', topics: ['x'] }, { topics: ['y'] })).toEqual({ title: 'a', topics: ['y'] })
    expect(mergePatch<Patch>(null, { start_ms: 1 })).toEqual({ start_ms: 1 })
  })

  it('the inverse holds the old value of each changed key only', () => {
    const before = { title: 'Old', topics: ['a'], start_ms: 0, end_ms: 5000 }
    expect(inversePatch(before, { title: 'New', start_ms: 0 })).toEqual({ title: 'Old' })
    expect(inversePatch(before, { topics: ['a'] })).toEqual({})
    expect(inversePatch(before, { topics: ['a', 'b'] })).toEqual({ topics: ['a'] })
  })

  it('undo of a burst goes back to before its first change', () => {
    const first = { start_ms: 1000 }
    const second = { start_ms: 1100, end_ms: 9000 }
    expect(mergeInverse<Patch>(first, second)).toEqual({ start_ms: 1000, end_ms: 9000 })
  })
})

// ─── Autosave ────────────────────────────────────────────────────────────────

describe('createAutosaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(save = vi.fn(async (p: Patch) => p)) {
    const statuses: string[] = []
    const saved: { sent: Patch; inverse: Partial<Patch> }[] = []
    const a = createAutosaver<Patch, Patch>({
      save,
      onStatus: (s) => statuses.push(s.state),
      onSaved: (_r, sent, inverse) => saved.push({ sent, inverse }),
    })
    return { a, save, statuses, saved }
  }

  it('waits 600 ms after the LAST change and sends one merged PATCH', async () => {
    const { a, save, saved } = setup()
    a.queue({ start_ms: 1000 }, { start_ms: 500 })
    await vi.advanceTimersByTimeAsync(400)
    a.queue({ start_ms: 1100 }, { start_ms: 1000 })
    a.queue({ title: 'T' }, { title: 'Old' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ start_ms: 1100, title: 'T' })
    expect(saved[0].inverse).toEqual({ start_ms: 500, title: 'Old' })
  })

  it('reports pending, saving, saved', async () => {
    const { a, statuses } = setup()
    a.queue({ title: 'x' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(statuses).toEqual(['pending', 'saving', 'saved'])
    expect(a.busy()).toBe(false)
  })

  it('ignores an empty patch', async () => {
    const { a, save, statuses } = setup()
    a.queue({})
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(save).not.toHaveBeenCalled()
    expect(statuses).toEqual([])
  })

  it('changes made during a save are sent after it, never in parallel', async () => {
    let release!: () => void
    const save = vi.fn(
      (p: Patch) =>
        new Promise<Patch>((r) => {
          release = () => r(p)
        }),
    )
    const { a } = setup(save)
    a.queue({ title: 'one' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(save).toHaveBeenCalledTimes(1)
    a.queue({ title: 'two' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    // The second wait is over, but the first save is still running.
    expect(save).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toEqual({ title: 'two' })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.status().state).toBe('saved')
  })

  it('flush sends at once', async () => {
    const { a, save } = setup()
    a.queue({ title: 'now' })
    await a.flush()
    expect(save).toHaveBeenCalledWith({ title: 'now' })
  })

  it('a failed save keeps its patch, under newer changes, for a retry', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('nope')).mockImplementation(async (p: Patch) => p)
    const { a, statuses } = setup(save)
    a.queue({ title: 'a', start_ms: 1 }, { title: 'orig' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(statuses.at(-1)).toBe('error')
    expect(a.pending()).toEqual({ title: 'a', start_ms: 1 })
    a.queue({ title: 'b' }, { title: 'a' })
    await a.flush()
    expect(save).toHaveBeenLastCalledWith({ title: 'b', start_ms: 1 })
  })

  it('keeps the earliest undo value when a failed save is retried', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('nope')).mockImplementation(async (p: Patch) => p)
    const { a, saved } = setup(save)
    a.queue({ title: 'a' }, { title: 'orig' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    a.queue({ title: 'b' }, { title: 'a' })
    await a.flush()
    expect(saved[0].inverse).toEqual({ title: 'orig' })
  })

  it('cancel drops what is pending', async () => {
    const { a, save } = setup()
    a.queue({ title: 'gone' })
    a.cancel()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(save).not.toHaveBeenCalled()
    expect(a.busy()).toBe(false)
  })

  it('reports nothing after dispose', async () => {
    const { a, statuses } = setup()
    a.dispose()
    a.queue({ title: 'x' })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(statuses).toEqual([])
  })
})

describe('describeChange', () => {
  it('names what was saved', () => {
    expect(describeChange({ start_ms: 1 })).toBe('In/out saved')
    expect(describeChange({ title: 'x' })).toBe('Title saved')
    expect(describeChange({ title: 'x', topics: [] })).toBe('Title and topics saved')
    expect(describeChange({ start_ms: 1, title: 'x', topics: [] })).toBe('In/out, title and topics saved')
    expect(describeChange({ status: 'approved' })).toBe('Approved')
    expect(describeChange({ status: 'rejected' })).toBe('Rejected')
    expect(describeChange({ status: 'suggested' })).toBe('Back to suggested')
    expect(describeChange({})).toBe('Saved')
  })
})

// ─── Topics ──────────────────────────────────────────────────────────────────

describe('addTopic / removeTopic', () => {
  it('trims, drops "#", collapses spaces', () => {
    expect(addTopic(['a'], '  #Climate   change ')).toEqual(['a', 'Climate change'])
  })
  it('does not add a topic twice, ignoring case', () => {
    const t = ['Climate']
    expect(addTopic(t, 'climate')).toBe(t)
    expect(addTopic(t, '   ')).toBe(t)
    expect(addTopic(t, '#')).toBe(t)
  })
  it('removes case-insensitively', () => {
    expect(removeTopic(['Climate', 'ice'], 'climate')).toEqual(['ice'])
  })
})

// ─── Track of a clip ─────────────────────────────────────────────────────────

describe('dominantTrack', () => {
  const seg = (track_index: number, start_ms: number, end_ms: number) => ({ track_index, start_ms, end_ms })
  it('picks the track that speaks most of the clip', () => {
    expect(dominantTrack([seg(0, 0, 3000), seg(1, 3000, 10_000)], { start_ms: 1000, end_ms: 9000 })).toBe(1)
  })
  it('adds up several segments of one track', () => {
    expect(
      dominantTrack([seg(0, 0, 2000), seg(1, 2000, 5000), seg(0, 5000, 7000)], { start_ms: 0, end_ms: 7000 }),
    ).toBe(0)
  })
  it('is null without overlap, and the lower track wins a tie', () => {
    expect(dominantTrack([seg(0, 0, 1000)], { start_ms: 2000, end_ms: 3000 })).toBeNull()
    expect(dominantTrack([seg(1, 0, 1000), seg(0, 1000, 2000)], { start_ms: 0, end_ms: 2000 })).toBe(0)
  })
})

// ─── One player at a time ────────────────────────────────────────────────────

describe('createPlayerGroup', () => {
  it('activating a card pauses the one that was playing', () => {
    const g = createPlayerGroup()
    const a = { pause: vi.fn() }
    const b = { pause: vi.fn() }
    g.register('a', a)
    g.activate('a')
    g.register('b', b)
    g.activate('b')
    expect(a.pause).toHaveBeenCalledTimes(1)
    expect(b.pause).not.toHaveBeenCalled()
    expect(g.active()).toBe('b')
  })

  it('a player that starts pauses every other one and becomes active', () => {
    const g = createPlayerGroup()
    const players = ['a', 'b', 'c'].map((k) => ({ k, p: { pause: vi.fn() } }))
    players.forEach(({ k, p }) => g.register(k, p))
    g.playing('c')
    expect(players[0].p.pause).toHaveBeenCalled()
    expect(players[1].p.pause).toHaveBeenCalled()
    expect(players[2].p.pause).not.toHaveBeenCalled()
    expect(g.active()).toBe('c')
  })

  it('tells subscribers when the active card changes, and only then', () => {
    const g = createPlayerGroup()
    const l = vi.fn()
    const off = g.subscribe(l)
    g.activate('a')
    g.activate('a')
    g.playing('a')
    expect(l).toHaveBeenCalledTimes(1)
    g.release('b')
    expect(l).toHaveBeenCalledTimes(1)
    g.release('a')
    expect(l).toHaveBeenCalledTimes(2)
    expect(g.active()).toBeNull()
    off()
    g.activate('z')
    expect(l).toHaveBeenCalledTimes(2)
  })

  it('unregistering keeps the active key and a stale unregister is harmless', () => {
    const g = createPlayerGroup()
    const first = { pause: vi.fn() }
    const second = { pause: vi.fn() }
    const offFirst = g.register('a', first)
    g.activate('a')
    g.register('a', second) // re-render registered a new player
    offFirst()
    expect(g.active()).toBe('a')
    g.playing('b')
    expect(second.pause).toHaveBeenCalled()
    expect(first.pause).not.toHaveBeenCalled()
  })
})

// ─── Shortcuts ───────────────────────────────────────────────────────────────

describe('targetKind', () => {
  function el(html: string, selector?: string): Element {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return selector ? host.querySelector(selector)! : host.firstElementChild!
  }
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('classifies what a key was pressed on', () => {
    expect(targetKind(el('<input />'))).toBe('typing')
    expect(targetKind(el('<input type="number" />'))).toBe('typing')
    expect(targetKind(el('<textarea></textarea>'))).toBe('typing')
    expect(targetKind(el('<select><option>a</option></select>'))).toBe('typing')
    expect(targetKind(el('<div contenteditable="true"></div>'))).toBe('typing')
    expect(targetKind(el('<button role="combobox"></button>'))).toBe('typing')
    expect(targetKind(el('<input type="range" />'))).toBe('slider')
    expect(targetKind(el('<div role="slider" tabindex="0"></div>'))).toBe('slider')
    expect(targetKind(el('<button role="tab"></button>'))).toBe('composite')
    expect(targetKind(el('<button>x</button>'))).toBe('control')
    expect(targetKind(el('<input type="checkbox" />'))).toBe('control')
    expect(targetKind(el('<div role="dialog"><button>x</button></div>', 'button'))).toBe('overlay')
    expect(targetKind(el('<div tabindex="-1"></div>'))).toBe('other')
    expect(targetKind(null)).toBe('other')
    expect(targetKind(window)).toBe('other')
  })
})

describe('shortcutFor', () => {
  const k = (key: string, extra: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
    key,
    ...extra,
  })

  it('maps the keys', () => {
    expect(shortcutFor(k(' '), 'other')).toEqual({ type: 'toggle-play' })
    expect(shortcutFor(k('i'), 'other')).toEqual({ type: 'set-in' })
    expect(shortcutFor(k('I'), 'other')).toEqual({ type: 'set-in' })
    expect(shortcutFor(k('o'), 'control')).toEqual({ type: 'set-out' })
    expect(shortcutFor(k('e'), 'slider')).toEqual({ type: 'toggle-expand' })
    expect(shortcutFor(k('ArrowLeft'), 'other')).toEqual({ type: 'seek', deltaMs: -1000 })
    expect(shortcutFor(k('ArrowRight'), 'control')).toEqual({ type: 'seek', deltaMs: 1000 })
    expect(shortcutFor(k('ArrowLeft', { shiftKey: true }), 'other')).toEqual({ type: 'seek', deltaMs: -100 })
    expect(shortcutFor(k('ArrowRight', { shiftKey: true }), 'other')).toEqual({ type: 'seek', deltaMs: 100 })
  })

  it('is ignored while typing or inside a dialog', () => {
    for (const key of [' ', 'i', 'o', 'e', 'ArrowLeft']) {
      expect(shortcutFor(k(key), 'typing')).toBeNull()
      expect(shortcutFor(k(key), 'overlay')).toBeNull()
    }
  })

  it('leaves Space to buttons and arrows to sliders and tabs', () => {
    expect(shortcutFor(k(' '), 'control')).toBeNull()
    expect(shortcutFor(k(' '), 'slider')).toBeNull()
    expect(shortcutFor(k('ArrowLeft'), 'slider')).toBeNull()
    expect(shortcutFor(k('ArrowRight'), 'composite')).toBeNull()
  })

  it('leaves modified keys and other keys alone', () => {
    expect(shortcutFor(k('i', { metaKey: true }), 'other')).toBeNull()
    expect(shortcutFor(k('e', { ctrlKey: true }), 'other')).toBeNull()
    expect(shortcutFor(k('ArrowLeft', { altKey: true }), 'other')).toBeNull()
    expect(shortcutFor(k('I', { shiftKey: true }), 'other')).toBeNull()
    expect(shortcutFor(k('x'), 'other')).toBeNull()
    expect(shortcutFor(k('Enter'), 'other')).toBeNull()
  })
})

describe('cardKeyOf', () => {
  it('is stable and attribute-safe', () => {
    expect(cardKeyOf('all', 'moment:abc-1:188000')).toBe('all::moment:abc-1:188000')
    expect(cardKeyOf('climate change', 'x')).toBe('climate_change::x')
  })
})
