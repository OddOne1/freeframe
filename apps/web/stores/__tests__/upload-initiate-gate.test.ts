/**
 * The bounded initiate gate (CLAUDE.md §27).
 *
 * Dropping a batch fired one POST /upload/initiate per file in the same
 * synchronous loop, unbounded. Asserted here through the real store, by
 * watching the order and overlap of the api.post calls it makes — the two
 * properties that matter are invisible from the store's own state.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn() },
}))

import { api } from '@/lib/api'

/**
 * A FRESH module instance per test.
 *
 * The gate's in-flight counter and its wait queue are module state, and a
 * test that abandons a parked initiate leaves both dirty — which made the
 * different-projects assertion fail only when run after the others, with
 * the counter already at 2. Draining in afterEach was not enough: a waiter
 * still queued for a slot never settles, so nothing decrements it.
 *
 * Resetting modules is the honest fix. Exporting a reset from the store
 * purely for tests would have papered over the cause and added production
 * API for no production reason.
 */
async function freshStore() {
  vi.resetModules()
  const mod = await import('../upload-store')
  return mod.useUploadStore
}

/** A file small enough that the part loop is one chunk. */
function tinyFile(name: string) {
  return new File([new Uint8Array(8)], name, { type: 'video/quicktime' })
}

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

let inFlight = 0
let maxInFlight = 0
let initiateOrder: string[] = []
let pending: Deferred[] = []

beforeEach(() => {
  vi.clearAllMocks()
  inFlight = 0
  maxInFlight = 0
  initiateOrder = []
  pending = []
  // Every initiate hangs until the test releases it, so overlap is
  // observable rather than a matter of timing luck.
  ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string, body: Record<string, unknown>) => {
    if (!url.includes('/upload/initiate')) return Promise.resolve({})
    initiateOrder.push(String(body.original_filename))
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise((resolve, reject) => {
      pending.push({
        resolve: (v) => { inFlight -= 1; resolve(v) },
        reject: (e) => { inFlight -= 1; reject(e) },
      })
    })
  })
})

afterEach(async () => {
  // Drain, and then WAIT. The gate's in-flight counter is module state and
  // only decrements when a call settles, so rejecting without giving the
  // microtasks a turn leaves the next test starting from a non-zero count —
  // which is what made the different-projects test fail only when run
  // alongside the others. Production can't hit this: the finally always
  // runs. A test-only reset export would have hidden the real cause.
  for (const p of pending) p.reject(new Error('test teardown'))
  pending = []
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
})

const settle = () => new Promise((r) => setTimeout(r, 0))

async function drop(store: Awaited<ReturnType<typeof freshStore>>, project: string, names: string[]) {
  for (const n of names) {
    store.getState().startUpload(tinyFile(n), project, n, 'Proj', null)
  }
  await settle()
}

describe('the first initiate for a project runs alone', () => {
  it('holds every other file in the batch until it resolves', async () => {
    const store = await freshStore()
    await drop(store, 'p-fresh', ['a.mov', 'b.mov', 'c.mov', 'd.mov', 'e.mov'])

    // Only the leader has been sent. This is the rule that protects a
    // project whose storage prefix is not yet locked.
    expect(initiateOrder).toEqual(['a.mov'])
    expect(inFlight).toBe(1)

    pending[0].resolve({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_id: 'v' })
    await settle()
    await settle()

    // Now the rest go, but capped rather than all four at once.
    expect(initiateOrder.length).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('does not strand the batch when the first initiate FAILS', async () => {
    const store = await freshStore()
    await drop(store, 'p-fails', ['a.mov', 'b.mov', 'c.mov'])
    expect(initiateOrder).toEqual(['a.mov'])

    pending[0].reject(new Error('500'))
    await settle()
    await settle()

    // A rejected leader still settles the prefix question, so the others
    // must be released rather than waiting forever behind it.
    expect(initiateOrder.length).toBeGreaterThan(1)
  })
})

describe('after the first, concurrency is capped not unbounded', () => {
  it('never exceeds the cap across a large batch', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.mov`)
    const store = await freshStore()
    await drop(store, 'p-cap', names)

    pending[0].resolve({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_id: 'v' })
    // Release greedily; the cap must hold the whole way through.
    for (let round = 0; round < 30; round++) {
      await settle()
      const next = pending.find((p) => p)
      if (!next) break
      const p = pending.shift()
      if (!p) break
      p.resolve({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_id: 'v' })
      expect(maxInFlight).toBeLessThanOrEqual(3)
    }
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(maxInFlight).toBeGreaterThan(0)
  })
})

describe('different projects are not held behind each other', () => {
  it('lets each project run its own first initiate immediately', async () => {
    const store = await freshStore()
    store.getState().startUpload(tinyFile('x.mov'), 'proj-A', 'x.mov', 'A', null)
    store.getState().startUpload(tinyFile('y.mov'), 'proj-B', 'y.mov', 'B', null)
    store.getState().startUpload(tinyFile('z.mov'), 'proj-C', 'z.mov', 'C', null)
    // Two turns: the gate is async, so a leader's api.post can land on the
    // microtask after the call rather than during it.
    await settle()
    await settle()

    // Three different rows in the DB — nothing for them to contend on, so
    // the gate must not serialise them. This is the check that a global
    // lock has not been introduced by mistake.
    expect(initiateOrder.sort()).toEqual(['x.mov', 'y.mov', 'z.mov'])
    expect(maxInFlight).toBe(3)
  })
})
