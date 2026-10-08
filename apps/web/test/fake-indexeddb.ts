/**
 * A minimal in-memory IndexedDB, for §213's upload-session tests.
 *
 * Deliberately NOT a mock of `@/lib/upload-sessions`: that module IS the
 * thing under test — the keyPath, the upgrade path, the swallow-everything
 * error handling — and mocking it would leave all of that unasserted while
 * the tests still passed.
 *
 * Only what `upload-sessions.ts` actually calls is implemented. Every
 * request resolves on a microtask rather than synchronously, because the
 * real API does and the code under test attaches its handlers AFTER making
 * the call — a synchronous fake would never fire them.
 */

interface FakeRequest<T> {
  result: T
  onsuccess: ((this: unknown, ev: unknown) => void) | null
  onerror: ((this: unknown, ev: unknown) => void) | null
  onupgradeneeded?: ((this: unknown, ev: unknown) => void) | null
  onblocked?: ((this: unknown, ev: unknown) => void) | null
}

function request<T>(produce: () => T, fail?: () => boolean): FakeRequest<T> {
  const req: FakeRequest<T> = { result: undefined as T, onsuccess: null, onerror: null }
  queueMicrotask(() => {
    if (fail && fail()) {
      req.onerror?.call(req, {})
      return
    }
    req.result = produce()
    req.onsuccess?.call(req, {})
  })
  return req
}

export interface FakeIndexedDB {
  /** Every store's rows, so a test can inspect or seed what is persisted. */
  data: Map<string, Map<unknown, unknown>>
  /** Make the next operations fail, the way a private window does. */
  failing: boolean
  install: () => void
  uninstall: () => void
}

export function createFakeIndexedDB(): FakeIndexedDB {
  const data = new Map<string, Map<unknown, unknown>>()
  const state = { failing: false }
  const original = (globalThis as Record<string, unknown>).indexedDB

  const makeStore = (name: string, keyPath: string) => {
    if (!data.has(name)) data.set(name, new Map())
    const rows = data.get(name)!
    return {
      put: (value: Record<string, unknown>) =>
        request(() => {
          rows.set(value[keyPath], value)
          return value[keyPath]
        }, () => state.failing),
      get: (key: unknown) => request(() => rows.get(key), () => state.failing),
      getAll: () => request(() => Array.from(rows.values()), () => state.failing),
      delete: (key: unknown) =>
        request(() => {
          rows.delete(key)
          return undefined
        }, () => state.failing),
    }
  }

  const keyPaths = new Map<string, string>()

  const db = {
    objectStoreNames: { contains: (name: string) => keyPaths.has(name) },
    createObjectStore: (name: string, opts: { keyPath: string }) => {
      keyPaths.set(name, opts.keyPath)
      data.set(name, new Map())
      return makeStore(name, opts.keyPath)
    },
    transaction: (name: string, _mode: string) => ({
      objectStore: (storeName: string) => makeStore(storeName, keyPaths.get(storeName) ?? 'id'),
      onabort: null,
    }),
  }

  const fake = {
    open: (_name: string, _version: number) => {
      // Built by hand rather than through `request()`: the upgrade must
      // fire BEFORE success, exactly as the real API does, so the object
      // store is created by the code under test rather than by this fake
      // pretending it already exists. Two separate microtasks would run in
      // the wrong order.
      const req: FakeRequest<typeof db> = {
        result: db,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      }
      queueMicrotask(() => {
        if (state.failing) {
          req.onerror?.call(req, {})
          return
        }
        req.onupgradeneeded?.call(req, {})
        req.onsuccess?.call(req, {})
      })
      return req
    },
  }

  return {
    data,
    get failing() {
      return state.failing
    },
    set failing(v: boolean) {
      state.failing = v
    },
    install() {
      ;(globalThis as Record<string, unknown>).indexedDB = fake
    },
    uninstall() {
      ;(globalThis as Record<string, unknown>).indexedDB = original
    },
  } as FakeIndexedDB
}
