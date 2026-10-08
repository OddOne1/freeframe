/**
 * Interrupted browser uploads, remembered across reloads (§213).
 *
 * The real module against a fake IndexedDB (test/fake-indexeddb.ts), not a
 * mock of the module: the keyPath, the upgrade path and the
 * swallow-everything error handling are the parts that can be silently
 * wrong, and mocking the module would leave all three unasserted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeIndexedDB } from '@/test/fake-indexeddb'
import {
  saveSession,
  listSessions,
  deleteSession,
  fileMatchesSession,
  canStoreFileHandles,
  fileFromHandle,
  type UploadSession,
} from '../upload-sessions'

const fake = createFakeIndexedDB()

function session(over: Partial<UploadSession> = {}): UploadSession {
  return {
    uploadId: 'u-1',
    s3Key: 'raw/p/a/v/original.mxf',
    assetId: 'a-1',
    versionId: 'v-1',
    partSize: 16 * 1024 * 1024,
    projectId: 'p-1',
    folderId: null,
    versionOf: null,
    assetName: 'A001C002',
    fileName: 'A001C002.MXF',
    fileSize: 104_680_120_320,
    lastModified: 1_760_000_000_000,
    fileType: 'application/mxf',
    createdAt: 1_760_000_111_000,
    uploadedBytes: 18_454_478_848,
    ...over,
  }
}

beforeEach(() => {
  fake.data.clear()
  fake.failing = false
  fake.install()
})

afterEach(() => {
  fake.uninstall()
})

describe('persisting an interrupted upload', () => {
  it('a saved session comes back', async () => {
    await saveSession(session())
    const all = await listSessions()
    expect(all).toHaveLength(1)
    expect(all[0].uploadId).toBe('u-1')
    expect(all[0].partSize).toBe(16 * 1024 * 1024)
    expect(all[0].fileSize).toBe(104_680_120_320)
  })

  it('is keyed by upload id, so re-saving the same session updates it', async () => {
    await saveSession(session({ uploadedBytes: 1 }))
    await saveSession(session({ uploadedBytes: 2 }))
    const all = await listSessions()
    expect(all).toHaveLength(1)
    expect(all[0].uploadedBytes).toBe(2)
  })

  it('two uploads of the same file do not collide', async () => {
    await saveSession(session({ uploadId: 'u-1' }))
    await saveSession(session({ uploadId: 'u-2' }))
    expect(await listSessions()).toHaveLength(2)
  })

  it('newest first, so a panel does not have to sort', async () => {
    await saveSession(session({ uploadId: 'old', createdAt: 1000 }))
    await saveSession(session({ uploadId: 'new', createdAt: 9000 }))
    expect((await listSessions()).map((s) => s.uploadId)).toEqual(['new', 'old'])
  })

  it('a discarded session is gone', async () => {
    await saveSession(session())
    await deleteSession('u-1')
    expect(await listSessions()).toEqual([])
  })

  it('deleting one that was never there is not an error', async () => {
    await expect(deleteSession('never')).resolves.toBeUndefined()
  })
})

describe('when the browser will not cooperate', () => {
  it('a private window (or blocked site data) means no resume, not a thrown error', async () => {
    fake.failing = true
    await expect(saveSession(session())).resolves.toBeUndefined()
    await expect(listSessions()).resolves.toEqual([])
    await expect(deleteSession('u-1')).resolves.toBeUndefined()
  })

  it('no IndexedDB at all is the same answer', async () => {
    fake.uninstall()
    ;(globalThis as Record<string, unknown>).indexedDB = undefined
    await expect(saveSession(session())).resolves.toBeUndefined()
    await expect(listSessions()).resolves.toEqual([])
  })

  it('an indexedDB whose open throws outright is survivable', async () => {
    ;(globalThis as Record<string, unknown>).indexedDB = {
      open: () => {
        throw new Error('SecurityError')
      },
    }
    await expect(listSessions()).resolves.toEqual([])
  })
})

describe('matching the file back to the session', () => {
  const s = session()

  it('the same file matches', () => {
    expect(
      fileMatchesSession({ name: s.fileName, size: s.fileSize, lastModified: s.lastModified }, s),
    ).toBe(true)
  })

  it('a different name does not', () => {
    expect(
      fileMatchesSession({ name: 'A001C003.MXF', size: s.fileSize, lastModified: s.lastModified }, s),
    ).toBe(false)
  })

  it('a different size does not — this is the corrupt-object case', () => {
    expect(
      fileMatchesSession({ name: s.fileName, size: s.fileSize - 1, lastModified: s.lastModified }, s),
    ).toBe(false)
  })

  it('a different modification time does not either', () => {
    // The sharp case: the same card re-exported. Same name, same size, a
    // different file. Resuming into the old session would splice two
    // different files into one object and complete it as whole.
    expect(
      fileMatchesSession({ name: s.fileName, size: s.fileSize, lastModified: s.lastModified + 60_000 }, s),
    ).toBe(false)
  })
})

describe('the File System Access API is feature-detected, never assumed', () => {
  it('reports unavailable when the picker is absent (Safari, Firefox)', () => {
    const w = globalThis as Record<string, unknown>
    const had = w.showOpenFilePicker
    delete w.showOpenFilePicker
    expect(canStoreFileHandles()).toBe(false)
    if (had) w.showOpenFilePicker = had
  })

  it('reports available when it is there (Chromium)', () => {
    const w = globalThis as Record<string, unknown>
    w.showOpenFilePicker = () => Promise.resolve([])
    expect(canStoreFileHandles()).toBe(true)
    delete w.showOpenFilePicker
  })

  it('a session with no handle yields no file, so the caller falls back to the picker', async () => {
    expect(await fileFromHandle(session())).toBeNull()
  })

  it('a handle whose permission is refused yields no file', async () => {
    const handle = {
      kind: 'file',
      getFile: async () => new File([new Uint8Array(4)], 'A001C002.MXF'),
      queryPermission: async () => 'denied' as PermissionState,
    }
    expect(await fileFromHandle(session({ handle: handle as unknown as FileSystemFileHandle }))).toBeNull()
  })

  it('a granted handle yields the file, which is the one-click resume', async () => {
    const file = new File([new Uint8Array(4)], 'A001C002.MXF')
    const handle = {
      kind: 'file',
      getFile: async () => file,
      queryPermission: async () => 'granted' as PermissionState,
    }
    expect(await fileFromHandle(session({ handle: handle as unknown as FileSystemFileHandle }))).toBe(file)
  })

  it('a handle that asks and is then granted also yields the file', async () => {
    const file = new File([new Uint8Array(4)], 'A001C002.MXF')
    let asked = false
    const handle = {
      kind: 'file',
      getFile: async () => file,
      queryPermission: async () => 'prompt' as PermissionState,
      requestPermission: async () => {
        asked = true
        return 'granted' as PermissionState
      },
    }
    expect(await fileFromHandle(session({ handle: handle as unknown as FileSystemFileHandle }))).toBe(file)
    expect(asked).toBe(true)
  })

  it('a handle whose file has since moved yields no file rather than throwing', async () => {
    const handle = {
      kind: 'file',
      getFile: async () => {
        throw new Error('NotFoundError')
      },
      queryPermission: async () => 'granted' as PermissionState,
    }
    expect(await fileFromHandle(session({ handle: handle as unknown as FileSystemFileHandle }))).toBeNull()
  })
})
