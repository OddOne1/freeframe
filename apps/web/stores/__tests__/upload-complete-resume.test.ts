/**
 * A `parts_incomplete` answer sends the uploader back for the missing
 * parts (§236).
 *
 * `/upload/complete` builds its part list from storage now, so it can
 * answer 409 `parts_incomplete`: every PUT in this tab returned 200 and
 * the local parts array is full, yet the store does not hold the whole
 * file. That happens — a part a proxy acknowledged and the store never
 * kept, a stale listing on a resumed session, a retry that landed short.
 *
 * Before §236 that answer had nowhere to go: it fell out of
 * `runChunkedUpload`'s catch as a generic failure and the user was told
 * their upload had failed with every byte still sitting in the bucket.
 * The required behaviour is that it re-enters the §213 resume path —
 * `GET /upload/parts`, send only what is missing, complete again — and
 * that it never aborts.
 *
 * Driven through the REAL store against a fake `api` and a fake
 * IndexedDB, for the same reason `upload-resume.test.ts` is: what matters
 * is which parts were PUT the second time round, and that is invisible
 * from the store's own state.
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
const PART = 24 * MIB
const FILE_SIZE = 72 * MIB
const fake = createFakeIndexedDB()

async function freshStore() {
  vi.resetModules()
  const mod = await import('../upload-store')
  return mod.useUploadStore
}

function makeFile(bytes = FILE_SIZE, name = 'A001C002.MXF') {
  const file = new File([new Uint8Array(1)], name, {
    type: 'video/quicktime',
    lastModified: 1_760_000_000_000,
  })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

interface Listing {
  PartNumber: number
  ETag: string
  Size: number
}

/** The three 24 MiB parts of a whole 72 MiB file, as the store would list them. */
function wholeFile(): Listing[] {
  return [1, 2, 3].map((n) => ({ PartNumber: n, ETag: `"etag-${n}"`, Size: PART }))
}

/**
 * A FreeFrame whose `/upload/complete` answers from `completeAnswers`, one
 * per call, and whose `/upload/parts` answers from `listings`, one per
 * call (the last entry repeats).
 */
function wireApi({
  completeAnswers,
  listings = [],
}: {
  completeAnswers: Array<'ok' | ApiError>
  listings?: Listing[][]
}) {
  const calls = {
    initiate: 0,
    complete: 0,
    abort: 0,
    parts: 0,
    completeBodies: [] as Array<{ parts: Array<{ PartNumber: number; ETag: string }> }>,
    puts: [] as number[],
  }

  ;(api.post as ReturnType<typeof vi.fn>).mockImplementation(
    async (url: string, body: Record<string, unknown>) => {
      if (url.includes('/upload/initiate')) {
        calls.initiate += 1
        return {
          upload_id: 'u-1',
          s3_key: 'raw/p/a/v/original.mov',
          asset_id: 'a-1',
          version_id: 'v-1',
          part_size: PART,
          total_parts: 3,
        }
      }
      if (url.includes('/upload/presign-part')) {
        return { presigned_url: `https://s3.invalid/put?part=${body.part_number}` }
      }
      if (url.includes('/upload/complete')) {
        const answer = completeAnswers[Math.min(calls.complete, completeAnswers.length - 1)]
        calls.complete += 1
        calls.completeBodies.push(body as never)
        if (answer !== 'ok') throw answer
        return { status: 'processing', asset_id: 'a-1', version_id: 'v-1' }
      }
      if (url.includes('/upload/abort')) {
        calls.abort += 1
        return undefined
      }
      return {}
    },
  )

  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (url.includes('/upload/parts')) {
      const listing = listings[Math.min(calls.parts, listings.length - 1)] ?? []
      calls.parts += 1
      return { parts: listing }
    }
    return {}
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const partNumber = Number(new URL(String(url)).searchParams.get('part'))
      calls.puts.push(partNumber)
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === 'ETag' ? `"etag-${partNumber}"` : null) },
      }
    }),
  )

  return calls
}

function partsIncomplete(missing: number[]): ApiError {
  return new ApiError(
    409,
    `This upload is missing ${missing.length} part(s), starting at part ${missing[0]}.`,
    'parts_incomplete',
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  fake.data.clear()
  fake.failing = false
  fake.install()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterEach(() => {
  fake.uninstall()
  vi.unstubAllGlobals()
})

interface Entry {
  id: string
  status: string
  progress?: number
  error?: string
}

async function settle(
  store: { getState: () => { files: Entry[] } },
  id: string,
  statuses: string[],
  limit = 400,
): Promise<Entry | undefined> {
  for (let i = 0; i < limit; i++) {
    const f = store.getState().files.find((x) => x.id === id)
    if (f && statuses.includes(f.status)) return f
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  return store.getState().files.find((x) => x.id === id)
}

describe('a completion the server says is short', () => {
  it('re-lists, sends only the missing part, and completes', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [partsIncomplete([2]), 'ok'],
      // The store kept parts 1 and 3 but not 2.
      listings: [wholeFile().filter((p) => p.PartNumber !== 2)],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    expect(entry?.status).toBe('processing')
    // 1, 2, 3 on the first pass, then ONLY 2 again.
    expect(calls.puts).toEqual([1, 2, 3, 2])
    expect(calls.parts).toBe(1)
    expect(calls.complete).toBe(2)
    // THE assertion that it is not an abort: §236 leaves the upload open
    // precisely so this can happen.
    expect(calls.abort).toBe(0)
  })

  it('completes the second time with the whole, merged list', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [partsIncomplete([2]), 'ok'],
      listings: [wholeFile().filter((p) => p.PartNumber !== 2)],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    const second = calls.completeBodies[1]
    expect(second.parts.map((p) => p.PartNumber)).toEqual([1, 2, 3])
    // No holes: a sparse array would serialise its gaps as `null` and a
    // server that still reads this field would reject the body.
    expect(second.parts.every((p) => Boolean(p && p.ETag))).toBe(true)
  })

  it('does not trust a listed part of the wrong size, even here', async () => {
    const useUploadStore = await freshStore()
    const short = wholeFile().map((p) =>
      p.PartNumber === 2 ? { ...p, Size: PART - 17 } : p,
    )
    const calls = wireApi({
      completeAnswers: [partsIncomplete([2]), 'ok'],
      listings: [short],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    // Part 2 is listed, but short — a partial write. Re-sent, not reused.
    expect(calls.puts).toEqual([1, 2, 3, 2])
  })

  it('leaves nothing to resume once it finally completes', async () => {
    const useUploadStore = await freshStore()
    wireApi({
      completeAnswers: [partsIncomplete([3]), 'ok'],
      listings: [wholeFile().filter((p) => p.PartNumber !== 3)],
    })

    const id = useUploadStore.getState().startUpload(
      makeFile(), 'p-1', 'A001C002', 'Project', null,
    )
    await settle(useUploadStore, id, ['processing', 'complete', 'failed'])
    await new Promise((r) => setTimeout(r, 0))

    await useUploadStore.getState().loadInterrupted()
    expect(useUploadStore.getState().interrupted).toEqual([])
  })

  it('a second /complete answering 200 is harmless', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [partsIncomplete([2]), 'ok'],
      listings: [wholeFile().filter((p) => p.PartNumber !== 2)],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['processing', 'complete', 'failed'])

    // The upload is reported as processing and nothing is retried further:
    // the idempotent 200 ends the loop rather than starting another round.
    expect(entry?.status).toBe('processing')
    expect(entry?.progress).toBe(100)
    expect(calls.complete).toBe(2)
    expect(calls.abort).toBe(0)
  })

  it('stops after a bounded number of rounds rather than grinding', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      // The server never changes its mind.
      completeAnswers: [partsIncomplete([2])],
      listings: [wholeFile().filter((p) => p.PartNumber !== 2)],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    // The first attempt plus COMPLETE_RESUME_ROUNDS more. Pinned as a
    // number because "it stops" is the property: an unbounded loop here
    // would re-PUT a 97 GiB file forever.
    expect(calls.complete).toBe(3)
    // Still resumable, still not aborted.
    expect(calls.abort).toBe(0)
    expect(entry?.error).toContain('reopen this file')
  })

  it('does not loop when the store already holds every part', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      // 409 forever, but the listing says everything is there — so there is
      // nothing to re-send and re-sending nothing would spin.
      completeAnswers: [partsIncomplete([])],
      listings: [wholeFile()],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    expect(calls.complete).toBe(1)
    expect(calls.parts).toBe(1)
    expect(calls.puts).toEqual([1, 2, 3])
    expect(calls.abort).toBe(0)
  })
})

describe('other 409s are not a reason to re-send parts', () => {
  it('upload_failed is surfaced, not resumed', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [
        new ApiError(409, 'This upload was already marked failed.', 'upload_failed'),
      ],
      listings: [wholeFile()],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    expect(entry?.error).toContain('already marked failed')
    // No re-list, no re-sent parts, no abort.
    expect(calls.parts).toBe(0)
    expect(calls.puts).toEqual([1, 2, 3])
    expect(calls.complete).toBe(1)
    expect(calls.abort).toBe(0)
  })

  it('parts_rejected is surfaced, not resumed', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [
        new ApiError(409, "Storage refused this upload's parts (InvalidPart).",
          'parts_rejected'),
      ],
      listings: [wholeFile()],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    expect(calls.parts).toBe(0)
    expect(calls.complete).toBe(1)
    expect(calls.abort).toBe(0)
  })

  it('a 502 from the storage layer is surfaced, not resumed', async () => {
    const useUploadStore = await freshStore()
    const calls = wireApi({
      completeAnswers: [
        new ApiError(502, 'Storage could not finish this upload.', 'storage_error'),
      ],
      listings: [wholeFile()],
    })

    const id = useUploadStore.getState().startUpload(makeFile(), 'p-1', 'A001C002')
    const entry = await settle(useUploadStore, id, ['failed'])

    expect(entry?.status).toBe('failed')
    expect(calls.parts).toBe(0)
    expect(calls.abort).toBe(0)
  })
})
