/**
 * The web uploader after §213: the server's part size, and an upload that
 * survives the tab closing.
 *
 * Driven through the REAL store against a fake `api` and a fake
 * IndexedDB, because both properties that matter are invisible from the
 * store's own state: which part size the PUTs were cut to, and whether a
 * resumed upload re-sent bytes the server already had.
 *
 * Fresh module instance per test — `upload-store.ts` keeps the initiate
 * gate's counter, the abort controllers and the speed samplers in module
 * state, and a test that leaves any of them dirty changes the next one's
 * result (the note in upload-initiate-gate.test.ts is the full account).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'

vi.mock('@/lib/api', async () => {
  const actual = await import('@/lib/api')
  return {
    ApiError: actual.ApiError,
    api: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn() },
  }
})

import { api, ApiError } from '@/lib/api'

const MIB = 1024 * 1024
const fake = createFakeIndexedDB()

async function freshStore() {
  vi.resetModules()
  const mod = await import('../upload-store')
  return mod.useUploadStore
}

/** A file of `bytes`, with a stable identity a session can be matched to. */
function makeFile(bytes: number, name = 'A001C002.MXF', lastModified = 1_760_000_000_000) {
  const file = new File([new Uint8Array(1)], name, { type: 'video/quicktime', lastModified })
  // Patched rather than allocated: a 40 MiB Uint8Array per test is pure
  // cost, and nothing here reads the bytes — `slice` is recorded, not run.
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

interface Put {
  partNumber: number
  start: number
  end: number
}

/**
 * A fake FreeFrame.
 *
 * `puts` records every part the store asked to upload AND the byte range
 * it cut — which is how "it used the server's part size" is asserted as
 * behaviour rather than by reading a constant.
 */
function wireApi({
  partSize,
  omitPartSize = false,
  initiateError = null as unknown,
  listed = null as null | Array<{ PartNumber: number; ETag: string; Size: number }>,
  listError = null as unknown,
}: {
  partSize?: number
  omitPartSize?: boolean
  initiateError?: unknown
  listed?: null | Array<{ PartNumber: number; ETag: string; Size: number }>
  listError?: unknown
}) {
  const calls = {
    initiate: 0,
    complete: 0,
    abort: 0,
    presign: 0,
    parts: 0,
    completeBody: null as null | { parts: Array<{ PartNumber: number; ETag: string }> },
    abortBody: null as unknown,
    puts: [] as Put[],
  }

  ;(api.post as ReturnType<typeof vi.fn>).mockImplementation(
    async (url: string, body: Record<string, unknown>) => {
      if (url.includes('/upload/initiate') || url.includes('/versions')) {
        calls.initiate += 1
        if (initiateError) throw initiateError
        return {
          upload_id: 'u-1',
          s3_key: 'raw/p/a/v/original.mov',
          asset_id: 'a-1',
          version_id: 'v-1',
          ...(omitPartSize ? {} : { part_size: partSize, total_parts: null }),
        }
      }
      if (url.includes('/upload/presign-part')) {
        calls.presign += 1
        return { presigned_url: `https://s3.invalid/put?part=${body.part_number}` }
      }
      if (url.includes('/upload/complete')) {
        calls.complete += 1
        calls.completeBody = body as never
        return { status: 'processing' }
      }
      if (url.includes('/upload/abort')) {
        calls.abort += 1
        calls.abortBody = body
        return undefined
      }
      return {}
    },
  )

  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (url.includes('/upload/parts')) {
      calls.parts += 1
      if (listError) throw listError
      return { parts: listed ?? [] }
    }
    return {}
  })

  // The part PUT goes straight to fetch, not through `api`.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts: { body?: unknown }) => {
      const partNumber = Number(new URL(String(url)).searchParams.get('part'))
      const blob = opts.body as { __start?: number; __end?: number; size?: number }
      calls.puts.push({
        partNumber,
        start: blob.__start ?? -1,
        end: blob.__end ?? -1,
      })
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'ETag' ? `"etag-${partNumber}"` : null) },
      }
    }),
  )

  return calls
}

/** Records the ranges `Blob.slice` was asked for without copying bytes. */
function recordSlices() {
  const original = File.prototype.slice
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(File.prototype as any).slice = function (start: number, end: number) {
    return { __start: start, __end: end, size: end - start }
  }
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(File.prototype as any).slice = original
  }
}

let restoreSlice: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  fake.data.clear()
  fake.failing = false
  fake.install()
  restoreSlice = recordSlices()
  // jsdom reports online by default; made explicit so a test that flips it
  // starts from a known value.
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  restoreSlice?.()
  fake.uninstall()
  vi.unstubAllGlobals()
})

/** Wait until the store's entry for `id` reaches one of `statuses`. */
async function settle(
  store: { getState: () => { files: Array<{ id: string; status: string }> } },
  id: string,
  statuses: string[],
  limit = 200,
) {
  for (let i = 0; i < limit; i++) {
    const f = store.getState().files.find((x) => x.id === id)
    if (f && statuses.includes(f.status)) return f
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  return store.getState().files.find((x) => x.id === id)
}

// ── the server decides the part size ──────────────────────────────────────

describe("the part size is the server's", () => {
  it('cuts the file into the parts the server asked for', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 24 * MIB })

    const id = useUploadStore.getState().startUpload(makeFile(72 * MIB), 'p-1', 'A001C002')
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    // 72 MiB at the server's 24 MiB = 3 parts. At the old hardcoded 10 MiB
    // it would have been 8, so this cannot pass by accident.
    expect(calls.puts).toHaveLength(3)
    expect(calls.puts.map((p) => p.partNumber)).toEqual([1, 2, 3])
    expect(calls.puts.map((p) => p.end - p.start)).toEqual([24 * MIB, 24 * MIB, 24 * MIB])
    expect(calls.complete).toBe(1)
  })

  it('falls back to 10 MiB when the api is too old to say', async () => {
    // A rolling deploy: web is rebuilt before api, so for a while the
    // field simply is not there. The old value is what that server
    // expects — just with the old ceiling.
    const useUploadStore = await freshStore()
    const calls = wireApi({ omitPartSize: true })

    const id = useUploadStore.getState().startUpload(makeFile(25 * MIB), 'p-1', 'A001C002')
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(calls.puts.map((p) => p.end - p.start)).toEqual([10 * MIB, 10 * MIB, 5 * MIB])
  })

  it('a part size larger than the file is one part, not a negative slice', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 90 * MIB })

    const id = useUploadStore.getState().startUpload(makeFile(1024), 'p-1', 'tiny')
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(calls.puts).toEqual([{ partNumber: 1, start: 0, end: 1024 }])
  })
})

// ── a refusal before anything was created ────────────────────────────────

describe('a file the server will not accept', () => {
  it('surfaces the 413 text and aborts nothing, because nothing started', async () => {
    const useUploadStore = await freshStore()
    const detail =
      'This file is 1000.00 GiB (1,073,741,824,000 bytes). The maximum upload size is ' +
      '878.91 GiB (943,718,400,000 bytes), which is 10,000 parts of 90 MiB — the part ' +
      'size is capped by the upload route, not by storage.'
    const calls = wireApi({ initiateError: new ApiError(413, detail) })

    const id = useUploadStore.getState().startUpload(makeFile(1000 * 1024 * MIB), 'p-1', 'huge')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    expect((entry as { error?: string }).error).toContain('878.91 GiB')
    // THE assertion. An abort needs an upload_id, and there is none —
    // calling it with undefined would 422, and the row would then say
    // something about a validation error instead of the real limit.
    expect(calls.abort).toBe(0)
    expect(calls.puts).toHaveLength(0)
    // Nothing to resume: this upload never existed.
    expect(useUploadStore.getState().interrupted).toEqual([])
  })
})

// ── sessions, and resuming one ───────────────────────────────────────────

describe('an upload that outlives the page', () => {
  it('records a session before the first part, and clears it on completion', async () => {
    const useUploadStore = await freshStore()
    wireApi({ partSize: 24 * MIB })

    const id = useUploadStore.getState().startUpload(
      makeFile(72 * MIB), 'p-1', 'A001C002', 'Project', 'folder-9',
    )
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])
    // The finally hook writes, then deletes. Let both land.
    await new Promise((r) => setTimeout(r, 0))

    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toEqual([])
  })

  it('a failed upload is kept as resumable rather than aborted', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 24 * MIB })
    // The PUT refuses permanently once, which the store's own retry loop
    // treats as gone-session; what matters here is what it does NOT do.
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ parts: [] }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new ApiError(404, 'gone', 'no_such_upload')
      }),
    )

    const id = useUploadStore.getState().startUpload(makeFile(72 * MIB), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    // §213 — the parts that landed are kept, and nothing is aborted. The
    // pre-§213 store aborted on every failure to make the history page
    // read tidily, which threw away every transferred byte.
    expect(calls.abort).toBe(0)
    expect((entry as { error?: string }).error).toContain('reopen this file')
  })

  it('cancel DOES abort, and leaves nothing to resume', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 24 * MIB })
    // The PUT honours the abort signal, as a real one does: that is what
    // ends the in-flight part instead of waiting it out.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Upload cancelled', 'AbortError')),
              { once: true },
            )
          }),
      ),
    )

    const id = useUploadStore.getState().startUpload(makeFile(72 * MIB), 'p-1', 'A001C002')
    // Wait until the session exists (it is written before the first part).
    for (let i = 0; i < 100; i++) {
      if (useUploadStore.getState().files.find((f) => f.id === id)?.uploadId) break
      await new Promise((r) => setTimeout(r, 0))
    }
    useUploadStore.getState().cancelUpload(id)

    // Waited on the ABORT CALL, not on the row's status: `cancelUpload`
    // writes 'cancelled' into the store immediately (it is optimistic), so
    // the status says nothing about whether the upload itself has been
    // disposed of yet.
    for (let i = 0; i < 200 && calls.abort === 0; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(calls.abort).toBe(1)
    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toEqual([])
  })

  it('resumes from the parts the server lists, re-sending only what is missing', async () => {
    const useUploadStore = await freshStore()
    const file = makeFile(72 * MIB)
    const calls = wireApi({
      partSize: 24 * MIB,
      listed: [
        { PartNumber: 1, ETag: '"had-1"', Size: 24 * MIB },
        { PartNumber: 2, ETag: '"had-2"', Size: 24 * MIB },
      ],
    })

    const { saveSession } = await import('@/lib/upload-sessions')
    await saveSession({
      uploadId: 'u-old', s3Key: 'raw/p/a/v/original.mov', assetId: 'a-1', versionId: 'v-1',
      partSize: 24 * MIB, projectId: 'p-1', folderId: null, versionOf: null,
      assetName: 'A001C002', fileName: file.name, fileSize: file.size,
      lastModified: file.lastModified, fileType: file.type,
      createdAt: 1000, uploadedBytes: 48 * MIB,
    })

    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toHaveLength(1)

    const id = await useUploadStore.getState().resumeInterrupted('u-old', file)
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(calls.initiate).toBe(0)
    expect(calls.parts).toBe(1)
    expect(calls.puts.map((p) => p.partNumber)).toEqual([3])
    // The merged list, in order, reusing the ETags the server reported.
    expect(calls.completeBody?.parts.map((p) => p.PartNumber)).toEqual([1, 2, 3])
    expect(calls.completeBody?.parts[0].ETag).toBe('"had-1"')
    expect(calls.completeBody?.parts[2].ETag).toBe('"etag-3"')
  })

  it('a listed part of the wrong size is re-sent, never trusted', async () => {
    const useUploadStore = await freshStore()
    const file = makeFile(72 * MIB)
    const calls = wireApi({
      partSize: 24 * MIB,
      listed: [
        { PartNumber: 1, ETag: '"had-1"', Size: 24 * MIB },
        // Short: a partial write. Completing around it produces a corrupt
        // object that passes every other check there is.
        { PartNumber: 2, ETag: '"had-2"', Size: 24 * MIB - 17 },
        { PartNumber: 3, ETag: '"had-3"', Size: 24 * MIB },
      ],
    })

    const { saveSession } = await import('@/lib/upload-sessions')
    await saveSession({
      uploadId: 'u-old', s3Key: 'raw/p/a/v/original.mov', assetId: 'a-1', versionId: 'v-1',
      partSize: 24 * MIB, projectId: 'p-1', folderId: null, versionOf: null,
      assetName: 'A001C002', fileName: file.name, fileSize: file.size,
      lastModified: file.lastModified, fileType: file.type,
      createdAt: 1000, uploadedBytes: 72 * MIB,
    })

    const id = await useUploadStore.getState().resumeInterrupted('u-old', file)
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(calls.puts.map((p) => p.partNumber)).toEqual([2])
    expect(calls.completeBody?.parts[1].ETag).toBe('"etag-2"')
  })

  it('a different file is refused, not uploaded into the session', async () => {
    const useUploadStore = await freshStore()
    const file = makeFile(72 * MIB)
    const calls = wireApi({ partSize: 24 * MIB, listed: [] })

    const { saveSession } = await import('@/lib/upload-sessions')
    await saveSession({
      uploadId: 'u-old', s3Key: 'raw/p/a/v/original.mov', assetId: 'a-1', versionId: 'v-1',
      partSize: 24 * MIB, projectId: 'p-1', folderId: null, versionOf: null,
      assetName: 'A001C002', fileName: file.name, fileSize: file.size,
      lastModified: file.lastModified, fileType: file.type,
      createdAt: 1000, uploadedBytes: 0,
    })

    // Same name and size, a different modification time: the same card
    // re-exported. The outcome has to be a refusal, not a corrupt asset.
    const other = makeFile(72 * MIB, 'A001C002.MXF', file.lastModified + 60_000)
    await expect(useUploadStore.getState().resumeInterrupted('u-old', other)).rejects.toThrow(
      /not the same file/i,
    )
    expect(calls.puts).toHaveLength(0)
    expect(calls.parts).toBe(0)
    // Still offered — refusing the wrong file must not discard the session.
    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toHaveLength(1)
  })

  it('a session the server has forgotten becomes a fresh upload of the same file', async () => {
    const useUploadStore = await freshStore()
    const file = makeFile(72 * MIB)
    const calls = wireApi({
      partSize: 24 * MIB,
      listError: new ApiError(404, 'gone', 'no_such_upload'),
    })

    const { saveSession } = await import('@/lib/upload-sessions')
    await saveSession({
      uploadId: 'u-old', s3Key: 'raw/p/a/v/original.mov', assetId: 'a-1', versionId: 'v-1',
      partSize: 24 * MIB, projectId: 'p-1', folderId: 'folder-9', versionOf: null,
      assetName: 'A001C002', fileName: file.name, fileSize: file.size,
      lastModified: file.lastModified, fileType: file.type,
      createdAt: 1000, uploadedBytes: 24 * MIB,
    })

    const id = await useUploadStore.getState().resumeInterrupted('u-old', file)
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(calls.initiate).toBe(1)
    expect(calls.puts.map((p) => p.partNumber)).toEqual([1, 2, 3])
    expect(calls.complete).toBe(1)
  })

  it('discarding one aborts the multipart upload rather than leaking its parts', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 24 * MIB })

    const { saveSession } = await import('@/lib/upload-sessions')
    await saveSession({
      uploadId: 'u-old', s3Key: 'raw/p/a/v/original.mov', assetId: 'a-1', versionId: 'v-1',
      partSize: 24 * MIB, projectId: 'p-1', folderId: null, versionOf: null,
      assetName: 'A001C002', fileName: 'A001C002.MXF', fileSize: 72 * MIB,
      lastModified: 1, fileType: 'video/quicktime', createdAt: 1, uploadedBytes: 0,
    })
    await useUploadStore.getState().loadInterrupted()

    await useUploadStore.getState().discardInterrupted('u-old')

    expect(calls.abort).toBe(1)
    expect(calls.abortBody).toMatchObject({ upload_id: 'u-old', version_id: 'v-1' })
    expect(useUploadStore.getState().interrupted).toEqual([])
    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toEqual([])
  })

  it('an upload running in this tab is not offered as interrupted', async () => {
    const useUploadStore = await freshStore()
    wireApi({ partSize: 24 * MIB })
    // A ref rather than a bare `let`: TypeScript narrows a let assigned
    // only inside a callback to `never` and then refuses the call.
    const release: { fn: (() => void) | null } = { fn: null }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release.fn = () => resolve({ ok: true, status: 200, headers: { get: () => '"e"' } })
          }),
      ),
    )

    const id = useUploadStore.getState().startUpload(makeFile(72 * MIB), 'p-1', 'A001C002')
    for (let i = 0; i < 100; i++) {
      if (useUploadStore.getState().files.find((f) => f.id === id)?.uploadId) break
      await new Promise((r) => setTimeout(r, 0))
    }

    await useUploadStore.getState().loadInterrupted()
    // Its session is on disk — it is written before the first part — but
    // offering to "resume" something that is running would be nonsense.
    expect(useUploadStore.getState().interrupted).toEqual([])
    release.fn?.()
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])
  })
})

// ── offline, then online ─────────────────────────────────────────────────

describe('losing the connection', () => {
  it('continues when the browser comes back, with no user action', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({ partSize: 24 * MIB })

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    let attempts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts: { body?: unknown }) => {
        attempts += 1
        const partNumber = Number(new URL(String(url)).searchParams.get('part'))
        // Offline for the first attempt at each part.
        if (attempts <= 3) throw new TypeError('Failed to fetch')
        const blob = opts.body as { __start?: number; __end?: number }
        calls.puts.push({ partNumber, start: blob.__start ?? -1, end: blob.__end ?? -1 })
        return {
          ok: true,
          status: 200,
          headers: { get: (k: string) => (k === 'ETag' ? `"etag-${partNumber}"` : null) },
        }
      }),
    )

    const id = useUploadStore.getState().startUpload(makeFile(72 * MIB), 'p-1', 'A001C002')

    // Parked on the offline wait, which is the point: the row says why,
    // and nothing has failed.
    for (let i = 0; i < 100; i++) {
      const f = useUploadStore.getState().files.find((x) => x.id === id)
      if (f?.status === 'paused') break
      await new Promise((r) => setTimeout(r, 0))
    }
    const parked = useUploadStore.getState().files.find((x) => x.id === id)
    expect(parked?.status).toBe('paused')
    expect(parked?.pauseReason).toBe('retrying')
    expect(parked?.error).toContain('Offline')

    // The connection returns. NO user action.
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))

    const done = await settle(useUploadStore, id, ['processing', 'complete', 'failed'], 2000)
    expect(done?.status).not.toBe('failed')
    expect(calls.complete).toBe(1)
    expect(calls.abort).toBe(0)
  })
})
