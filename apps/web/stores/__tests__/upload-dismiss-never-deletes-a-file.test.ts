/**
 * §238 — dismissing an upload row must never delete someone's file.
 *
 * What `removeFile` did: for ANY failed or cancelled entry with an
 * `assetId`, it called `DELETE /assets/{assetId}`. For a first upload that
 * is the intended cleanup — the asset was created by that upload, and
 * `fetchHistory()` would otherwise pull the leftover straight back. For a
 * NEW-VERSION upload the `assetId` is the EXISTING asset, so dismissing a
 * cancelled new version soft-deleted the whole file: every other version,
 * every comment, every approval. Found in production by the owner, on the
 * same upload §238 is about.
 *
 * The fix is one flag set where the entry is created (`createdAsset`), and
 * the tests that matter are about the three readings of it: true, false,
 * and ABSENT — a row persisted by an older build, where "we do not know"
 * has to mean "do not delete".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const del = vi.fn(async (_url: string) => ({}))
const post = vi.fn(async (_url: string, _body?: unknown) => ({}))
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: (u: string, b?: unknown) => post(u, b), delete: (u: string) => del(u) },
  ApiError: class extends Error {},
}))

const deleteSession = vi.fn(async (_id: string) => {})
vi.mock('@/lib/upload-sessions', () => ({
  deleteSession: (id: string) => deleteSession(id),
  listSessions: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}),
  fileMatchesSession: () => true,
  canStoreFileHandles: () => false,
}))

import { useUploadStore, type UploadFile } from '../upload-store'

const BASE: UploadFile = {
  id: 'f1',
  fileName: 'AdobeStock_1393846473.mov',
  fileSize: 77_700_000,
  fileType: 'video/quicktime',
  projectId: 'p1',
  assetName: 'AdobeStock_1393846473.mov',
  progress: 0,
  processingProgress: 0,
  status: 'cancelled',
  assetId: 'asset-1',
  createdAt: Date.now(),
}

function seed(patch: Partial<UploadFile>) {
  useUploadStore.setState({
    files: [{ ...BASE, ...patch }],
    dismissedHistoryIds: [],
  } as never)
}

beforeEach(() => {
  del.mockClear()
  post.mockClear()
  deleteSession.mockClear()
})

describe('dismissing a NEW-VERSION upload', () => {
  it('never deletes the asset', () => {
    seed({ createdAsset: false, status: 'cancelled' })

    useUploadStore.getState().removeFile('f1')

    expect(del).not.toHaveBeenCalled()
    expect(useUploadStore.getState().files).toHaveLength(0)
  })

  it('is just as safe when the upload FAILED rather than being cancelled', () => {
    seed({ createdAsset: false, status: 'failed' })

    useUploadStore.getState().removeFile('f1')

    expect(del).not.toHaveBeenCalled()
  })

  it('asks the server to clear the empty version it left behind', () => {
    seed({
      createdAsset: false,
      status: 'cancelled',
      versionId: 'v6',
      s3Key: 'raw/2026-10-26_shoot_p1/asset-1/v6/original.mov',
      uploadId: 'upl-6',
    })

    useUploadStore.getState().removeFile('f1')

    expect(post).toHaveBeenCalledWith('/upload/abort', {
      s3_key: 'raw/2026-10-26_shoot_p1/asset-1/v6/original.mov',
      upload_id: 'upl-6',
      version_id: 'v6',
    })
    // And the resume record goes with it: the user has said they are done.
    expect(deleteSession).toHaveBeenCalledWith('upl-6')
  })

  it('sends nothing at all when the row no longer carries the three ids', () => {
    // A row persisted before §238 has no `s3Key`, and /upload/abort binds
    // the key to the version (§236) — so there is nothing safe to send.
    // The version list is the way back: it shows "Upload incomplete" with
    // a Delete.
    seed({ createdAsset: false, status: 'cancelled', versionId: 'v6' })

    useUploadStore.getState().removeFile('f1')

    expect(post).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('remembers the dismissal so it does not come back on the next reload', () => {
    seed({ createdAsset: false, status: 'cancelled' })

    useUploadStore.getState().removeFile('f1')

    // The same mechanism a finished upload's dismissal uses, and the
    // reason this is not a delete: nothing on the server changes.
    expect(useUploadStore.getState().dismissedHistoryIds).toEqual(['asset-1'])
  })
})

describe('dismissing a FIRST upload', () => {
  it('still deletes the asset that upload created', () => {
    seed({ createdAsset: true, status: 'failed' })

    useUploadStore.getState().removeFile('f1')

    expect(del).toHaveBeenCalledWith('/assets/asset-1')
  })

  it('does so for a cancelled one too', () => {
    seed({ createdAsset: true, status: 'cancelled' })

    useUploadStore.getState().removeFile('f1')

    expect(del).toHaveBeenCalledWith('/assets/asset-1')
  })
})

describe('a row from before this change', () => {
  it('defaults to the SAFE side and deletes nothing', () => {
    // No `createdAsset` at all — a failed/cancelled entry rehydrated from
    // localStorage, written by a build that did not have the flag. It may
    // be either kind, and the cost of guessing wrong in one direction is
    // a leftover asset row while the other is somebody's file.
    seed({ status: 'failed' })

    useUploadStore.getState().removeFile('f1')

    expect(del).not.toHaveBeenCalled()
    expect(useUploadStore.getState().dismissedHistoryIds).toEqual(['asset-1'])
  })

  it('is not confused by an explicit false either', () => {
    seed({ status: 'failed', createdAsset: false })
    useUploadStore.getState().removeFile('f1')
    expect(del).not.toHaveBeenCalled()
  })
})

describe('everything else about removeFile', () => {
  it('a finished upload is still only dismissed, never deleted', () => {
    seed({ status: 'complete', createdAsset: true })

    useUploadStore.getState().removeFile('f1')

    expect(del).not.toHaveBeenCalled()
    expect(useUploadStore.getState().dismissedHistoryIds).toEqual(['asset-1'])
  })

  it('an entry with no asset id touches the network at all', () => {
    seed({ status: 'failed', assetId: undefined, createdAsset: true })

    useUploadStore.getState().removeFile('f1')

    expect(del).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})

describe('the flag is set where the entry is born', () => {
  it('a discovered history row has none, so it is read as unknown', async () => {
    // `fetchProcessing`/`fetchHistory` build entries from /me/assets: this
    // tab did not make those uploads and cannot know whether they created
    // their asset. They therefore land on the safe side by construction.
    const { api } = await import('@/lib/api')
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'asset-9',
        project_id: 'p1',
        name: 'found.mov',
        asset_type: 'video',
        created_at: new Date().toISOString(),
        latest_version: {
          id: 'v1',
          asset_id: 'asset-9',
          version_number: 1,
          processing_status: 'failed',
          created_at: new Date().toISOString(),
          files: [],
        },
      },
    ])
    useUploadStore.setState({ files: [], dismissedHistoryIds: [] } as never)

    await useUploadStore.getState().fetchProcessing()
    const found = useUploadStore.getState().files.find((f) => f.assetId === 'asset-9')
    expect(found).toBeDefined()
    expect(found!.createdAsset).toBeUndefined()

    useUploadStore.getState().removeFile(found!.id)
    expect(del).not.toHaveBeenCalled()
  })
})
