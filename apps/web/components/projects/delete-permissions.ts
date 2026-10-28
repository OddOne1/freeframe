/**
 * Why a Delete action is refused, in the user's words (§240 C2 / §241 5b).
 *
 * §240 narrowed deletion: an editor may delete only assets they uploaded,
 * and a folder only when everything in its subtree is theirs. The server
 * answers that with a `can_delete` flag on assets, on `FolderResponse` and
 * on every folder-tree node, and with a 403 carrying its own sentence if
 * the action is attempted anyway.
 *
 * These strings are what a DISABLED control says before the attempt. They
 * live in one module because they are shown from six surfaces (grid card
 * menu, grid list row, right-click menu, the multi-select toolbar and its
 * menu, the folder card and the folder tree) and six copies of a
 * permission sentence drift.
 */

/** A single asset whose `can_delete` the server set false. */
export const ASSET_DELETE_DENIED =
  'Only the person who uploaded this file, the project owner or an admin can delete it'

/** A folder whose subtree holds somebody else's files. */
export const FOLDER_DELETE_DENIED =
  "Only the project owner or an admin can delete a folder that contains other people's files"

/** A multi-select containing at least one item the caller may not delete.
 *  §240 has no bulk endpoint — the web deletes one id at a time — so a
 *  mixed selection would half-succeed. It is not offered. */
export const BULK_DELETE_DENIED =
  'Your selection includes items you cannot delete — deselect them to delete the rest'

/** True only when the server said no. An absent flag (an older listing, a
 *  share page's grid) leaves the action in place and relies on the 403. */
export function deleteBlocked(canDelete: boolean | undefined): boolean {
  return canDelete === false
}
