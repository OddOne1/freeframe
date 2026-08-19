/**
 * Reading a dropped folder.
 *
 * `DataTransfer.files` flattens a dropped directory and silently loses
 * everything nested — per the DnD spec, a directory never becomes a `File`.
 * `webkitGetAsEntry()` is the only way to see one, and it is non-standard but
 * implemented everywhere this app runs.
 *
 * Extracted from the LUT settings page (§42), which had the only correct
 * implementation of this walk, so the project uploader (§49) can share it
 * rather than grow a second copy to keep in step. The relative path is new:
 * the LUT page only ever needed a flat list, the project uploader needs to
 * know which folder a file came from.
 */

export interface DroppedFile {
  file: File
  /**
   * Directory components from the dropped root down to (but not including)
   * the file, e.g. `['Show', 'Sony']`. Empty for a loose file.
   */
  path: string[]
}

async function walk(entry: FileSystemEntry, path: string[], out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    )
    // A directory that cannot be read resolves null rather than throwing;
    // dropping it here is what keeps a phantom 0-byte entry out of the
    // upload queue.
    if (file) out.push({ file, path })
    return
  }
  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries returns at most ~100 per call and signals the end with an
  // empty batch. A single call silently truncates a large folder.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    )
    if (batch.length === 0) break
    for (const child of batch) await walk(child, [...path, entry.name], out)
  }
}

/**
 * Every file under a set of dropped entries, with the folder path each came
 * from.
 *
 * Returns `null` when the drop exposed no entries at all, which is how a
 * caller tells "an empty folder" from "this browser did not populate
 * `items`" and falls back to `DataTransfer.files`.
 */
export async function readDroppedEntries(
  dataTransfer: DataTransfer,
): Promise<DroppedFile[] | null> {
  const items = Array.from(dataTransfer.items ?? [])
  const entries = items
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() ?? null : null))
    .filter((entry): entry is FileSystemEntry => entry !== null)

  if (entries.length === 0) return null

  const out: DroppedFile[] = []
  for (const entry of entries) await walk(entry, [], out)
  return out
}

/** True when any dropped item was a directory — the question "was a folder
 *  involved at all", which decides whether to offer keep-structure. */
export function droppedAFolder(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items ?? []).some(
    (item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory === true,
  )
}

/**
 * The same shape from a `webkitdirectory` input, which reports paths as a
 * single `webkitRelativePath` string instead of handing over entries.
 */
export function fromDirectoryInput(files: File[]): DroppedFile[] {
  return files.map((file) => {
    const parts = (file.webkitRelativePath || '').split('/')
    // Last component is the filename; everything before it is the path.
    return { file, path: parts.slice(0, -1).filter(Boolean) }
  })
}
