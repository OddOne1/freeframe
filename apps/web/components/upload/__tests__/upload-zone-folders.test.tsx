/**
 * The project uploader accepts folders (CLAUDE.md §49).
 *
 * The bug being fixed: handleDrop read `dataTransfer.files`, which flattens
 * a dropped folder to nothing usable, and the phantom directory entry that
 * did get through reached startUpload as an unreadable 0-byte blob — the
 * "upload just stops" report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UploadZone } from '../upload-zone'

const onFilesSelected = vi.fn()

beforeEach(() => onFilesSelected.mockReset())

function file(name: string) {
  return new File(['x'], name, { type: 'image/jpeg' })
}

function fileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) => cb(file(name)),
  } as unknown as FileSystemEntry
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false
      return {
        readEntries: (cb: (e: FileSystemEntry[]) => void) => {
          if (done) return cb([])
          done = true
          cb(children)
        },
      }
    },
  } as unknown as FileSystemEntry
}

function dropOn(zone: HTMLElement, entries: FileSystemEntry[] | null, files: File[] = []) {
  fireEvent.drop(zone, {
    dataTransfer: {
      items: entries === null ? [] : entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
      files,
    },
  })
}

describe('dropping onto the project uploader', () => {
  it('walks a dropped folder instead of losing it', async () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    dropOn(container.firstElementChild as HTMLElement, [dirEntry('Shoot', [fileEntry('a.jpg'), fileEntry('b.jpg')])])

    await vi.waitFor(() => expect(onFilesSelected).toHaveBeenCalled())
    const selected = onFilesSelected.mock.calls[0][0]
    expect(selected).toHaveLength(2)
    // The path is what makes keep-structure possible at all.
    expect(selected[0].path).toEqual(['Shoot'])
  })

  it('still handles a plain file drop, with an empty path', async () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    dropOn(container.firstElementChild as HTMLElement, [fileEntry('loose.jpg')])

    await vi.waitFor(() => expect(onFilesSelected).toHaveBeenCalled())
    expect(onFilesSelected.mock.calls[0][0][0].path).toEqual([])
  })

  it('falls back to .files when the browser exposes no entries', async () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    dropOn(container.firstElementChild as HTMLElement, null, [file('old-browser.jpg')])

    await vi.waitFor(() => expect(onFilesSelected).toHaveBeenCalled())
    expect(onFilesSelected.mock.calls[0][0]).toEqual([{ file: expect.any(File), path: [] }])
  })

  it('reports nothing at all for an empty folder', async () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    dropOn(container.firstElementChild as HTMLElement, [dirEntry('Empty', [])])
    await Promise.resolve()
    // Not an empty selection either: nothing was chosen, so nothing is said.
    expect(onFilesSelected).not.toHaveBeenCalled()
  })
})

describe('click-to-browse', () => {
  it('offers both a file picker and a folder picker', () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    expect(screen.getByRole('button', { name: 'Add files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeInTheDocument()

    // One control cannot do both: Windows' webkitdirectory picker blocks
    // file selection and the plain picker blocks folders.
    const inputs = Array.from(container.querySelectorAll('input[type="file"]'))
    expect(inputs).toHaveLength(2)
    expect(inputs.filter((i) => i.hasAttribute('webkitdirectory'))).toHaveLength(1)
  })

  it('reports a folder selection with its relative path', async () => {
    const { container } = render(<UploadZone onFilesSelected={onFilesSelected} />)
    const folderInput = container.querySelector('input[webkitdirectory]') as HTMLInputElement

    const f = file('clip.jpg')
    Object.defineProperty(f, 'webkitRelativePath', { value: 'Shoot/Day 1/clip.jpg' })
    await userEvent.upload(folderInput, [f])

    expect(onFilesSelected).toHaveBeenCalledWith([{ file: f, path: ['Shoot', 'Day 1'] }])
  })
})
