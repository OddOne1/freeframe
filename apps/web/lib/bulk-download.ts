/**
 * What a multi-select "Download" actually means (§177).
 *
 * Three decisions live here rather than inside the page components, because
 * both surfaces (the project grid and the share viewer) have to make the
 * same ones and only one of them used to:
 *
 *  1. ONE file is not a batch. Selecting a single asset by checkbox used to
 *     route into the zip dialog, so the user got `Project_selection.zip`
 *     holding one clip — while every other way of downloading that same
 *     clip (the card menu, right-click, the viewer) handed them the file
 *     itself.
 *  2. What SHAPE the selection is, which is the whole of the naming scheme.
 *     The server cannot work this out: the client flattens a folder into a
 *     list of asset ids before the request is built, so folder identity is
 *     gone by the time it arrives.
 *  3. Whether to offer a choice between a zip and individual files at all.
 */

/**
 * The shape of a batch, which decides the download's FILENAME only.
 *
 *   all              -> {base}.zip
 *   selected         -> {base}_Selected.zip
 *   single_folder    -> {base}_{FolderName}.zip
 *   multiple_folders -> {base}_MultipleFolders.zip
 *
 * `{base}` is the share link's title, or the project's name in-app. Kept in
 * step with `ZipScope` in apps/api/schemas/share.py — the API validates
 * against that Literal, so an unknown value here is a 422, not a fallback.
 */
export type ZipScope = 'all' | 'selected' | 'single_folder' | 'multiple_folders'

/** Above this many files, a zip is not offered as a choice — it is the only
 *  sane option. One browser download per file past this point is thousands
 *  of popups and a download manager nobody can read. */
export const INDIVIDUAL_DOWNLOAD_LIMIT = 50

export interface SelectionShape {
  scope: ZipScope
  /** Only ever set for `single_folder`; the API ignores it otherwise. */
  folderName?: string
}

/**
 * Classify a grid selection, before it is flattened into asset ids.
 *
 * Deliberately never returns "all": a grid selection is something the user
 * picked, and nothing here verified it was the whole project. Even selecting
 * every visible item is a selection — a filter may be hiding the rest.
 */
export function classifySelection(
  assetIds: string[],
  folderIds: string[],
  folderNameById?: (id: string) => string | undefined,
): SelectionShape {
  const onlyFolders = assetIds.length === 0 && folderIds.length > 0
  if (onlyFolders && folderIds.length === 1) {
    return { scope: 'single_folder', folderName: folderNameById?.(folderIds[0]) }
  }
  if (onlyFolders) return { scope: 'multiple_folders' }
  return { scope: 'selected' }
}

export type BulkDownloadPlan =
  /** Exactly one file: hand over the file, not an archive containing it. */
  | { mode: 'single'; assetId: string }
  | { mode: 'zip'; assetIds: string[]; scope: ZipScope; folderName?: string }
  /** Nothing downloadable — the caller should do nothing at all. */
  | { mode: 'none' }

/**
 * Turn a selection into what should happen next.
 *
 * `expandFolder` fetches a folder's asset ids; it is passed in rather than
 * imported so this stays testable without a network, and so the two surfaces
 * can keep their own endpoints.
 *
 * The single-file check runs BEFORE expansion on purpose: one folder that
 * happens to hold one asset is still a folder download, and naming it after
 * the file inside would lose the fact that a folder was what got picked.
 */
export async function planBulkDownload({
  assetIds,
  folderIds,
  expandFolder,
  folderNameById,
}: {
  assetIds: string[]
  folderIds: string[]
  expandFolder: (folderId: string) => Promise<string[]>
  folderNameById?: (id: string) => string | undefined
}): Promise<BulkDownloadPlan> {
  if (assetIds.length === 1 && folderIds.length === 0) {
    return { mode: 'single', assetId: assetIds[0] }
  }

  const shape = classifySelection(assetIds, folderIds, folderNameById)

  const ids = [...assetIds]
  for (const folderId of folderIds) {
    try {
      ids.push(...(await expandFolder(folderId)))
    } catch {
      // A folder that cannot be listed is left out rather than failing the
      // whole download — same tolerance the previous inline loop had.
    }
  }
  // Array.from, not spread: this tsconfig targets below es2015 for
  // downlevel iteration.
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return { mode: 'none' }

  // NOTE: a folder that happens to hold one file still zips. The archive is
  // what carries the folder structure (see zip_entry_path server-side), and
  // the user picked a folder — unpacking that into a bare file would throw
  // away the one thing they asked for.
  return { mode: 'zip', assetIds: unique, ...shape }
}
