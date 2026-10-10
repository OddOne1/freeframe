/**
 * Dropping OS files and folders onto the project view (§223 C).
 *
 * The hook is tested through a real rendered harness rather than by calling
 * handlers, because the rules worth pinning are all about which drags it
 * claims and when the highlight is on — both of which only exist as a
 * consequence of real enter/over/leave sequences across nested children.
 *
 * jsdom's `DataTransfer` is a stub, so `types`, `items` and `files` are
 * supplied the way the browser would. That is the same approach
 * `lib/__tests__/read-dropped-entries.test.ts` already takes, and it is
 * honest about its limit: this proves the branching and the bookkeeping,
 * not that Chrome or Safari deliver the events in this order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { DroppedFile } from '@/lib/read-dropped-entries'

import { dragCarriesFiles, useFileDropZone } from '../use-file-drop-zone'
import { UploadZone } from '@/components/upload/upload-zone'

// ─── Fakes the browser would supply ──────────────────────────────────────

function file(name: string) {
  return new File(['x'], name, { type: 'video/mp4' })
}

function fileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(file(name)),
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
          cb(done ? [] : children)
          done = true
        },
      }
    },
  } as unknown as FileSystemEntry
}

/** An OS file drag. `types` is what the page can read during dragover. */
function fileDrag(entries: FileSystemEntry[] = [], files: File[] = []) {
  return {
    types: ['Files'],
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files,
    dropEffect: '',
    getData: () => '',
  } as unknown as DataTransfer
}

/** One of the app's own asset/folder moves. */
function internalDrag(payload: Record<string, unknown> = { assetIds: ['a-1'], folderIds: [] }) {
  return {
    types: ['application/json'],
    items: [],
    files: [],
    dropEffect: '',
    getData: () => JSON.stringify(payload),
  } as unknown as DataTransfer
}

// ─── Harness ─────────────────────────────────────────────────────────────

function Harness({
  disabled = false,
  onFiles,
}: {
  disabled?: boolean
  onFiles: (f: DroppedFile[]) => void
}) {
  const drop = useFileDropZone({ disabled, onFiles })
  return (
    <div data-testid="zone" {...drop.dropProps}>
      {/* A nested child, because crossing one is what used to make a naive
          boolean highlight flicker off. */}
      <div data-testid="card">card</div>
      {drop.isOver && <div data-testid="highlight">Drop to upload</div>}
    </div>
  )
}

function zone() {
  return screen.getByTestId('zone')
}
function card() {
  return screen.getByTestId('card')
}
function highlighted() {
  return screen.queryByTestId('highlight') !== null
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── The 'Files' rule ───────────────────────────────────────────────────

describe('§223 C.2 — only OS file drags', () => {
  it('reads the rule straight off dataTransfer.types', () => {
    expect(dragCarriesFiles(fileDrag())).toBe(true)
    expect(dragCarriesFiles(internalDrag())).toBe(false)
    expect(dragCarriesFiles(null)).toBe(false)
    expect(dragCarriesFiles({ types: [] } as unknown as DataTransfer)).toBe(false)
  })

  it('highlights for an OS file drag', () => {
    render(<Harness onFiles={vi.fn()} />)
    expect(highlighted()).toBe(false)
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
  })

  it('does NOT highlight for an internal JSON drag', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragEnter(zone(), { dataTransfer: internalDrag() })
    fireEvent.dragOver(zone(), { dataTransfer: internalDrag() })
    expect(highlighted()).toBe(false)
  })

  it('leaves an internal drag entirely alone — not even preventDefault', () => {
    render(<Harness onFiles={vi.fn()} />)
    // An unprevented dragover is how the browser knows this target does not
    // want the drag, which is what lets the folder card underneath keep it.
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: internalDrag() })
    fireEvent(zone(), over)
    expect(over.defaultPrevented).toBe(false)
  })

  it('claims an OS drag, so the browser does not just open the file', () => {
    render(<Harness onFiles={vi.fn()} />)
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: fileDrag() })
    fireEvent(zone(), over)
    expect(over.defaultPrevented).toBe(true)
  })

  it('fires no handler at all for an internal drop', () => {
    const onFiles = vi.fn()
    render(<Harness onFiles={onFiles} />)
    fireEvent.drop(zone(), { dataTransfer: internalDrag() })
    expect(onFiles).not.toHaveBeenCalled()
  })
})

// ─── The enter/leave counter ────────────────────────────────────────────

describe('§223 C.6 — the highlight does not flicker over children', () => {
  it('survives moving from the zone onto a child', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    // Entering the child bubbles a second dragenter, then the zone gets the
    // child's own dragleave as the pointer moves off its padding.
    fireEvent.dragEnter(card(), { dataTransfer: fileDrag() })
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
  })

  it('turns off only when the last enter is matched by a leave', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragEnter(card(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
    fireEvent.dragLeave(card(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(false)
  })

  it('never goes negative, so a stray leave cannot wedge it on', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
    fireEvent.dragLeave(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(false)
  })

  it('clears on drop', async () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag([fileEntry('a.mp4')]) })
    expect(highlighted()).toBe(true)
    fireEvent.drop(zone(), { dataTransfer: fileDrag([fileEntry('a.mp4')]) })
    await waitFor(() => expect(highlighted()).toBe(false))
  })

  it('clears when the drag ends outside the window', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
    // No dragleave ever reaches the target in that case.
    fireEvent.dragEnd(window)
    expect(highlighted()).toBe(false)
  })

  it('shows up even if the dragenter was missed', () => {
    render(<Harness onFiles={vi.fn()} />)
    fireEvent.dragOver(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(true)
  })
})

// ─── What the drop produces ────────────────────────────────────────────

describe('§223 C.3 — the drop yields files with their folder paths', () => {
  it('walks a dropped folder and keeps each file’s path', async () => {
    const onFiles = vi.fn()
    render(<Harness onFiles={onFiles} />)

    const tree = dirEntry('Card A', [
      fileEntry('clip1.mp4'),
      dirEntry('Sony', [fileEntry('clip2.mp4')]),
    ])
    fireEvent.drop(zone(), { dataTransfer: fileDrag([tree]) })

    await waitFor(() => expect(onFiles).toHaveBeenCalled())
    const got = onFiles.mock.calls[0][0] as DroppedFile[]
    expect(got.map((d) => [d.file.name, d.path.join('/')])).toEqual([
      ['clip1.mp4', 'Card A'],
      ['clip2.mp4', 'Card A/Sony'],
    ])
  })

  it('gives a loose file an empty path', async () => {
    const onFiles = vi.fn()
    render(<Harness onFiles={onFiles} />)
    fireEvent.drop(zone(), { dataTransfer: fileDrag([fileEntry('loose.mp4')]) })

    await waitFor(() => expect(onFiles).toHaveBeenCalled())
    const got = onFiles.mock.calls[0][0] as DroppedFile[]
    expect(got).toEqual([{ file: expect.any(File), path: [] }])
  })

  it('falls back to dataTransfer.files when no entries are exposed', async () => {
    const onFiles = vi.fn()
    render(<Harness onFiles={onFiles} />)
    // `items` empty but `files` populated: the shape a browser without
    // webkitGetAsEntry gives, which the Upload dialog's zone also handles.
    fireEvent.drop(zone(), { dataTransfer: fileDrag([], [file('old.mp4')]) })

    await waitFor(() => expect(onFiles).toHaveBeenCalled())
    const got = onFiles.mock.calls[0][0] as DroppedFile[]
    expect(got).toEqual([{ file: expect.any(File), path: [] }])
  })

  it('reads the entries before yielding, or a dropped folder is lost', async () => {
    // The browser invalidates webkitGetAsEntry once the handler returns.
    // This fake models exactly that, so an implementation that awaited
    // first would see nothing.
    let handlerReturned = false
    const entry = fileEntry('clip.mp4')
    const dt = {
      types: ['Files'],
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => (handlerReturned ? null : entry),
        },
      ],
      files: [],
      dropEffect: '',
    } as unknown as DataTransfer

    const onFiles = vi.fn()
    render(<Harness onFiles={onFiles} />)
    fireEvent.drop(zone(), { dataTransfer: dt })
    handlerReturned = true

    await waitFor(() => expect(onFiles).toHaveBeenCalled())
    expect((onFiles.mock.calls[0][0] as DroppedFile[])[0].file.name).toBe('clip.mp4')
  })
})

// ─── Disabled ──────────────────────────────────────────────────────────

describe('§223 C.4 — no drop target where uploading is not allowed', () => {
  it('attaches no handlers at all', () => {
    const onFiles = vi.fn()
    render(<Harness disabled onFiles={onFiles} />)

    fireEvent.dragEnter(zone(), { dataTransfer: fileDrag() })
    fireEvent.dragOver(zone(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(false)

    fireEvent.drop(zone(), { dataTransfer: fileDrag([fileEntry('a.mp4')]) })
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('does not claim the drag, so the browser keeps its own behaviour', () => {
    render(<Harness disabled onFiles={vi.fn()} />)
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: fileDrag() })
    fireEvent(zone(), over)
    expect(over.defaultPrevented).toBe(false)
  })
})

// ─── C.5 — the Upload dialog's own dropzone, nested inside this one ──────

/**
 * The real `UploadZone`, inside a target using this hook — which is exactly
 * how the project page composes them: the Upload dialog renders inside the
 * main content area's React tree, and React propagates a synthetic event up
 * the React tree even across a portal.
 *
 * Asserted here rather than only on the page because the page's own end
 * state happens to be identical either way: running second, the page's
 * handler finds the dropped entries already spent, resolves first (fewer
 * microtask hops), and its result is then overwritten by the dialog's. The
 * duplicate handling is real and this is where it is visible.
 */
describe('§223 C.5 — a drop in the Upload dialog does not also fire the page', () => {
  function Nested({ onPageFiles, onZoneFiles }: {
    onPageFiles: (f: DroppedFile[]) => void
    onZoneFiles: (f: DroppedFile[]) => void
  }) {
    const drop = useFileDropZone({ onFiles: onPageFiles })
    return (
      <div data-testid="page" {...drop.dropProps}>
        <UploadZone onFilesSelected={onZoneFiles} />
        {drop.isOver && <div data-testid="highlight">Drop to upload</div>}
      </div>
    )
  }

  function zoneTarget() {
    const el = screen.getByText(/drag files and folders to upload/i).closest('[role="button"]')
    if (!el) throw new Error('upload zone not found')
    return el as HTMLElement
  }

  it('the dialog takes the drop and the page never sees it', async () => {
    const onPageFiles = vi.fn()
    const onZoneFiles = vi.fn()
    render(<Nested onPageFiles={onPageFiles} onZoneFiles={onZoneFiles} />)

    fireEvent.drop(zoneTarget(), { dataTransfer: fileDrag([fileEntry('inner.mp4')]) })

    await waitFor(() => expect(onZoneFiles).toHaveBeenCalledTimes(1))
    expect(onPageFiles).not.toHaveBeenCalled()
  })

  it('the page shows no highlight for a drag over the dialog’s zone', () => {
    render(<Nested onPageFiles={vi.fn()} onZoneFiles={vi.fn()} />)
    fireEvent.dragEnter(zoneTarget(), { dataTransfer: fileDrag() })
    fireEvent.dragOver(zoneTarget(), { dataTransfer: fileDrag() })
    expect(highlighted()).toBe(false)
  })

  it('…while a drop on the page itself still reaches the page', async () => {
    // The control: the boundary is the dialog's zone, not the hook refusing
    // every drop that happens to land on a child.
    const onPageFiles = vi.fn()
    const onZoneFiles = vi.fn()
    render(<Nested onPageFiles={onPageFiles} onZoneFiles={onZoneFiles} />)

    fireEvent.drop(screen.getByTestId('page'), {
      dataTransfer: fileDrag([fileEntry('outer.mp4')]),
    })

    await waitFor(() => expect(onPageFiles).toHaveBeenCalledTimes(1))
    expect(onZoneFiles).not.toHaveBeenCalled()
  })
})
