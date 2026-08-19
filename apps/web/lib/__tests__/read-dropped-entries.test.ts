/**
 * The shared dropped-folder walk (CLAUDE.md §49).
 *
 * jsdom has no FileSystemEntry, so these build the objects a browser hands
 * over. The details worth pinning are the ones that silently lose files:
 * readEntries' pagination, and telling "no entries exposed" apart from "an
 * empty folder".
 */
import { describe, it, expect } from 'vitest'
import {
  droppedAFolder,
  fromDirectoryInput,
  readDroppedEntries,
} from '../read-dropped-entries'

function file(name: string) {
  return new File(['x'], name, { type: 'image/jpeg' })
}

function fileEntry(name: string, readable = true): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void, fail: () => void) => (readable ? ok(file(name)) : fail()),
  } as unknown as FileSystemEntry
}

/** Yields its children in batches, like a real reader. */
function dirEntry(name: string, children: FileSystemEntry[], batchSize = 100): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let i = 0
      return {
        readEntries: (cb: (entries: FileSystemEntry[]) => void) => {
          const batch = children.slice(i, i + batchSize)
          i += batch.length
          cb(batch)
        },
      }
    },
  } as unknown as FileSystemEntry
}

function transfer(entries: FileSystemEntry[] | null, files: File[] = []): DataTransfer {
  return {
    items: entries === null ? [] : entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
  } as unknown as DataTransfer
}

describe('readDroppedEntries', () => {
  it('returns loose files with an empty path', async () => {
    const out = await readDroppedEntries(transfer([fileEntry('a.jpg')]))
    expect(out).toEqual([{ file: expect.any(File), path: [] }])
  })

  it('records the folder path a file came from', async () => {
    const out = await readDroppedEntries(
      transfer([dirEntry('Show', [dirEntry('Sony', [fileEntry('clip.mov')])])]),
    )
    expect(out!.map((d) => d.path)).toEqual([['Show', 'Sony']])
  })

  it('reads past the first batch of a large directory', async () => {
    // A real reader returns ~100 per call; one call silently truncates.
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.jpg`))
    const out = await readDroppedEntries(transfer([dirEntry('Big', children)]))
    expect(out).toHaveLength(250)
  })

  it('drops an entry that cannot be read rather than queueing a phantom', async () => {
    // This is the 0-byte directory-as-File that used to reach startUpload and
    // stall the whole upload.
    const out = await readDroppedEntries(transfer([fileEntry('broken.jpg', false)]))
    expect(out).toEqual([])
  })

  it('returns null when the drop exposed no entries at all', async () => {
    // Distinct from an empty folder: the caller falls back to .files.
    expect(await readDroppedEntries(transfer(null, [file('a.jpg')]))).toBeNull()
  })

  it('returns an empty array for a genuinely empty folder', async () => {
    expect(await readDroppedEntries(transfer([dirEntry('Empty', [])]))).toEqual([])
  })
})

describe('droppedAFolder', () => {
  it('is true only when a directory was among the dropped items', () => {
    expect(droppedAFolder(transfer([fileEntry('a.jpg')]))).toBe(false)
    expect(droppedAFolder(transfer([fileEntry('a.jpg'), dirEntry('D', [])]))).toBe(true)
  })
})

describe('fromDirectoryInput', () => {
  it('splits webkitRelativePath into the same shape', () => {
    const f = file('clip.mov')
    Object.defineProperty(f, 'webkitRelativePath', { value: 'Show/Sony/clip.mov' })
    expect(fromDirectoryInput([f])).toEqual([{ file: f, path: ['Show', 'Sony'] }])
  })

  it('gives a file with no relative path an empty path', () => {
    expect(fromDirectoryInput([file('a.jpg')])).toEqual([{ file: expect.any(File), path: [] }])
  })
})
