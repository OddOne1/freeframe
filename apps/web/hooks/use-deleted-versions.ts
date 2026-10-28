'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type { AssetVersion } from '@/types'

/**
 * The key `include_deleted=true` is fetched under — exported so a test can
 * assert that NOTHING else asks for it.
 *
 * §241 item 1: removed versions belong in the version dropdown and nowhere
 * else. The provider's own `/assets/{id}/versions` (the player, §242's live
 * list, the share pages' separate queries) must keep answering live
 * versions only, so this is a SEPARATE SWR key rather than a parameter on
 * the existing read. One list gains deleted rows; every other consumer is
 * byte-for-byte unchanged.
 */
export function deletedVersionsKey(assetId: string): string {
  return `/assets/${assetId}/versions?include_deleted=true`
}

/**
 * The REMOVED versions of one asset (§240 D).
 *
 * Returns only the rows the server marked deleted: the live ones already
 * come from the provider, and merging two copies of the same version would
 * put the selection logic at the mercy of which list answered last. Each
 * row carries the server's own `can_restore` and, when the caller may see
 * it, `deleted_by_name`.
 *
 * `enabled` is false in share mode and for a caller with no asset: the
 * route is authenticated-only and an anonymous link-holder cannot ask for
 * it, so the request is not made rather than made and refused.
 */
export function useDeletedVersions(assetId: string | null | undefined, enabled = true) {
  const { data, mutate, isLoading } = useSWR<AssetVersion[]>(
    enabled && assetId ? deletedVersionsKey(assetId) : null,
    (key: string) => api.get<AssetVersion[]>(key),
  )

  return {
    removedVersions: (data ?? []).filter((v) => v.deleted_at !== null),
    isLoading,
    mutateRemovedVersions: mutate,
  }
}

/**
 * After a restore: should the user be MOVED to the version that came back?
 *
 * Only when it is now the highest live version and it is ready — the same
 * "highest ready" rule the review provider applies on first load and the
 * delete flow applies on the way out. Restoring an old v2 while somebody
 * is reviewing v7 must leave them on v7; restoring the newest one, which
 * is what they were looking at before it was deleted, should put them
 * back on it.
 *
 * `live` is the list as the SERVER answers it after the restore, which is
 * also where the restored row's `files` have to come from: a deleted row
 * is served with `files: []`.
 */
export function shouldSelectRestored(
  restored: AssetVersion | undefined,
  live: AssetVersion[],
): boolean {
  if (!restored) return false
  if (restored.processing_status !== 'ready') return false
  const highest = live.reduce((max, v) => Math.max(max, v.version_number), 0)
  return restored.version_number === highest
}
