'use client'

import * as React from 'react'
import { readDroppedEntries, type DroppedFile } from '@/lib/read-dropped-entries'

/**
 * A drop target for files and folders dragged in from the OS (§223 C).
 *
 * Two things make this worth a hook rather than four inline handlers.
 *
 * **It must ignore the app's own drags.** The project view already uses
 * HTML5 drag-and-drop internally to move assets and folders, with the
 * payload in `application/json` (see `folder-card.tsx` and
 * `folder-tree.tsx`). Those drags cross this same area constantly. A drop
 * target that called `preventDefault()` on everything would claim them and
 * break moving a file into a folder. So every handler returns immediately
 * unless `dataTransfer.types` contains `'Files'`, which is the DnD spec's
 * own marker for "this drag carries files from outside the page" and the
 * only thing readable during `dragover` — `items`/`files` are deliberately
 * empty until the drop itself, for privacy.
 *
 * **The highlight must not flicker.** `dragenter`/`dragleave` fire for
 * every child element the pointer crosses, so a naive boolean turns off the
 * moment the cursor moves from the grid's padding onto a card. A depth
 * counter is the standard fix: enter increments, leave decrements, and the
 * highlight is on while the count is above zero.
 *
 * The drop handler reads the entries through `readDroppedEntries`, called
 * SYNCHRONOUSLY on the event. That is not stylistic: `webkitGetAsEntry()`
 * and every `DataTransferItem` are invalidated once the handler yields, so
 * an `await` before the read loses a dropped folder entirely. The shared
 * walk already does its synchronous part first, which is why it is reused
 * rather than reimplemented here.
 */
export interface FileDropZone {
  /** True while an OS file drag is over the target. */
  isOver: boolean
  /** Spread onto the element that should accept the drop. Empty when
   *  disabled, so a role without upload rights has no drop target at all
   *  rather than one that silently swallows the drop. */
  dropProps: {
    onDragEnter?: (e: React.DragEvent) => void
    onDragOver?: (e: React.DragEvent) => void
    onDragLeave?: (e: React.DragEvent) => void
    onDrop?: (e: React.DragEvent) => void
  }
}

/** Whether this drag carries OS files, as opposed to one of the app's own
 *  JSON payloads. Exported because it is the rule the whole hook turns on,
 *  and a test should be able to state it directly. */
export function dragCarriesFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  // `types` is a DOMStringList in some engines and a plain array in others,
  // and jsdom gives an array; `Array.from` covers both.
  return Array.from(dataTransfer.types ?? []).includes('Files')
}

export function useFileDropZone({
  disabled = false,
  onFiles,
}: {
  disabled?: boolean
  /** Every file under the drop, with the folder path each came from. */
  onFiles: (files: DroppedFile[]) => void
}): FileDropZone {
  const [isOver, setIsOver] = React.useState(false)
  const depth = React.useRef(0)

  // Held in a ref so the handlers below keep a stable identity and the
  // target does not get new listeners mid-drag, which Safari has been
  // known to treat as leaving the element.
  const onFilesRef = React.useRef(onFiles)
  React.useEffect(() => {
    onFilesRef.current = onFiles
  })

  const reset = React.useCallback(() => {
    depth.current = 0
    setIsOver(false)
  }, [])

  // A drag that ends outside the window never sends `dragleave` to the
  // target, so without this the highlight can survive the drag that caused
  // it. `dragend` does not fire for a drag that started outside the page
  // either, which is why this listens for `drop` on the document too.
  React.useEffect(() => {
    if (disabled) return
    const clear = () => reset()
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [disabled, reset])

  const onDragEnter = React.useCallback((e: React.DragEvent) => {
    if (!dragCarriesFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    depth.current += 1
    setIsOver(true)
  }, [])

  const onDragOver = React.useCallback((e: React.DragEvent) => {
    if (!dragCarriesFiles(e.dataTransfer)) return
    // Required, or the browser refuses the drop and opens the file instead.
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    // A drag that entered before this target mounted (or whose dragenter
    // was swallowed by a child) would otherwise show no highlight at all.
    if (depth.current === 0) {
      depth.current = 1
      setIsOver(true)
    }
  }, [])

  const onDragLeave = React.useCallback((e: React.DragEvent) => {
    if (!dragCarriesFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setIsOver(false)
  }, [])

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setIsOver(false)

      // Synchronous, for the reason in this hook's own doc comment.
      const walk = readDroppedEntries(e.dataTransfer)
      // Captured here as well: `files` is a live-ish list on the event's
      // DataTransfer and the fallback below runs after an await.
      const flat = Array.from(e.dataTransfer.files ?? [])

      void walk.then((dropped) => {
        if (dropped !== null) {
          onFilesRef.current(dropped)
          return
        }
        // Same fallback the Upload dialog's zone keeps, for a browser that
        // does not populate `items`.
        onFilesRef.current(flat.map((file) => ({ file, path: [] })))
      })
    },
    [],
  )

  if (disabled) return { isOver: false, dropProps: {} }

  return {
    isOver,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
