/**
 * Interrupted browser uploads, remembered across reloads (§213).
 *
 * The desktop app can resume by itself: it has the file path, so after a
 * crash it reopens the file and carries on. A browser cannot. Once the tab
 * closes or the page reloads, the `File` object is gone and nothing in the
 * page may reach back into the filesystem without the user acting — so a
 * resume here is necessarily "we remember exactly where this upload got
 * to; hand us the same file again".
 *
 * WHY INDEXEDDB AND NOT THE ZUSTAND `persist` STORE. That store is
 * localStorage, it is synchronous, and it is deliberately narrow: its
 * `partialize` keeps only failed/cancelled rows and the dismissed-history
 * ids. Putting resumable sessions there would mean (a) serialising them
 * through localStorage's ~5 MB shared budget alongside everything else the
 * app keeps, and (b) no way to hold a `FileSystemFileHandle`, which is a
 * structured-cloneable object localStorage cannot represent at all. The
 * existing store is left exactly as it was.
 *
 * Everything here is best-effort. A private window, blocked site data, or
 * a browser that refuses IndexedDB must degrade to "no resume offered",
 * never to a thrown error in an upload path.
 */

const DB_NAME = 'ff-uploads'
const DB_VERSION = 1
const STORE = 'sessions'

export interface UploadSession {
  /** The multipart upload, which is what makes this resumable at all. */
  uploadId: string
  s3Key: string
  assetId: string
  versionId: string
  /** The size the SERVER chose. Re-planning on resume would renumber
   *  every remaining part against bytes already stored under the old
   *  numbering. */
  partSize: number
  projectId: string
  folderId: string | null
  /** For a new version of an existing asset, so a resumed one goes to the
   *  same place rather than becoming a new asset. */
  versionOf: string | null
  assetName: string
  /** The file's identity, and the whole of it a browser can see. All three
   *  must match before a byte is sent: resuming into a session whose
   *  source has been replaced would splice two different files into one
   *  object and complete it as if it were whole. */
  fileName: string
  fileSize: number
  lastModified: number
  fileType: string
  /** Chromium only. Lets a resume be one permission click instead of a
   *  file picker. Absent elsewhere, which is not a failure. */
  handle?: FileSystemFileHandle
  createdAt: number
  /** Bytes confirmed present at the moment this record was last written.
   *  Display only — the server's own part list is what a resume trusts. */
  uploadedBytes: number
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          // Keyed by the upload id: it is the server's own name for this
          // session, so two uploads of the same file to the same project
          // cannot collide and neither can two tabs.
          db.createObjectStore(STORE, { keyPath: 'uploadId' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null)
          return
        }
        try {
          const t = db.transaction(STORE, mode)
          const req = run(t.objectStore(STORE))
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => resolve(null)
          t.onabort = () => resolve(null)
        } catch {
          resolve(null)
        }
      }),
  )
}

export async function saveSession(session: UploadSession): Promise<void> {
  await tx('readwrite', (s) => s.put(session) as unknown as IDBRequest<IDBValidKey>)
}

export async function deleteSession(uploadId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(uploadId) as unknown as IDBRequest<undefined>)
}

export async function listSessions(): Promise<UploadSession[]> {
  const all = await tx<UploadSession[]>('readonly', (s) => s.getAll() as IDBRequest<UploadSession[]>)
  if (!all) return []
  return [...all].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Is this the file the session was for?
 *
 * Name, size and lastModified — the only three things a browser tells us
 * about a file without reading it. Deliberately ALL THREE: a user asked
 * for "A001C002.MXF" will often have several files of that name from
 * different cards, and uploading the wrong one into a half-finished
 * session produces a corrupt object that completes successfully.
 */
export function fileMatchesSession(
  file: { name: string; size: number; lastModified: number },
  session: UploadSession,
): boolean {
  return (
    file.name === session.fileName &&
    file.size === session.fileSize &&
    file.lastModified === session.lastModified
  )
}

/**
 * Chromium's File System Access API, feature-detected rather than assumed.
 *
 * Safari and Firefox do not have it, so a resume there is a file picker.
 * Typed through an indexed read rather than by augmenting `Window`: the
 * whole point is that the property may not exist, and declaring it as if
 * it always does invites someone to call it without checking.
 */
export function canStoreFileHandles(): boolean {
  if (typeof window === 'undefined') return false
  return typeof (window as unknown as Record<string, unknown>).showOpenFilePicker === 'function'
}

/**
 * The file behind a stored handle, if the browser still grants it.
 *
 * Returns null for every "no": no handle, no API, permission not granted
 * and not re-grantable without a gesture, or a file that has since been
 * moved. The caller falls back to the picker, which always works.
 */
export async function fileFromHandle(session: UploadSession): Promise<File | null> {
  const handle = session.handle
  if (!handle || typeof handle.getFile !== 'function') return null
  try {
    const queryable = handle as FileSystemFileHandle & {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>
    }
    if (queryable.queryPermission) {
      let state = await queryable.queryPermission({ mode: 'read' })
      if (state === 'prompt' && queryable.requestPermission) {
        state = await queryable.requestPermission({ mode: 'read' })
      }
      if (state !== 'granted') return null
    }
    return await handle.getFile()
  } catch {
    return null
  }
}
