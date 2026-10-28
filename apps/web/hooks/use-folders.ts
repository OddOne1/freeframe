'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type {
  Folder,
  FolderTreeNode,
  TrashEntry,
  TrashKind,
  TrashResponse,
  TrashSort,
} from '@/types'

export function useFolders(projectId: string) {
  const { data: tree, mutate: mutateTree } = useSWR<FolderTreeNode[]>(
    projectId ? `/projects/${projectId}/folder-tree` : null,
    (key: string) => api.get<FolderTreeNode[]>(key),
  )

  async function createFolder(name: string, parentId?: string | null): Promise<Folder> {
    const folder = await api.post<Folder>(`/projects/${projectId}/folders`, {
      name,
      parent_id: parentId ?? null,
    })
    await mutateTree()
    return folder
  }

  async function renameFolder(folderId: string, name: string): Promise<Folder> {
    const folder = await api.patch<Folder>(`/folders/${folderId}`, { name })
    await mutateTree()
    return folder
  }

  async function moveFolder(folderId: string, targetParentId: string | null): Promise<void> {
    await api.patch(`/folders/${folderId}`, { parent_id: targetParentId })
    await mutateTree()
  }

  async function deleteFolder(folderId: string): Promise<void> {
    await api.delete(`/folders/${folderId}`)
    await mutateTree()
  }

  async function moveAsset(assetId: string, folderId: string | null): Promise<void> {
    await api.patch(`/assets/${assetId}/move`, { folder_id: folderId })
    await mutateTree()
  }

  async function bulkMove(
    assetIds: string[],
    folderIds: string[],
    targetFolderId: string | null,
  ): Promise<void> {
    await api.post(`/projects/${projectId}/bulk-move`, {
      asset_ids: assetIds,
      folder_ids: folderIds,
      target_folder_id: targetFolderId,
    })
    await mutateTree()
  }

  async function restoreAsset(assetId: string): Promise<void> {
    await api.post(`/assets/${assetId}/restore`)
    await mutateTree()
  }

  async function restoreFolder(folderId: string): Promise<void> {
    await api.post(`/folders/${folderId}/restore`)
    await mutateTree()
  }

  /**
   * §240 C — one deleted version back onto a LIVE asset.
   *
   * Not `editor`: the deleter, the project owner or a superadmin, and the
   * server decides. Refused with 409 `storage_limit` when the bytes would
   * no longer fit, which the caller shows as the server wrote it.
   */
  async function restoreVersion(assetId: string, versionId: string): Promise<void> {
    await api.post(`/assets/${assetId}/versions/${versionId}/restore`)
    await mutateTree()
  }

  /**
   * Permanent, irreversible delete of an already-soft-deleted item,
   * skipping the 30-day wait. Owner/admin only — the API enforces that
   * with `require_project_role(..., ProjectRole.admin)`; hiding the button
   * is a courtesy, not the control.
   */
  async function purgeAsset(assetId: string): Promise<void> {
    await api.post(`/assets/${assetId}/purge`)
    await mutateTree()
  }

  async function purgeFolder(folderId: string): Promise<void> {
    await api.post(`/folders/${folderId}/purge`)
    await mutateTree()
  }

  return {
    tree: tree ?? [],
    mutateTree,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    moveAsset,
    bulkMove,
    restoreAsset,
    restoreFolder,
    restoreVersion,
    purgeAsset,
    purgeFolder,
  }
}

/**
 * Everything `GET /projects/{id}/trash` lets the view vary (§240 B).
 *
 * `deletedBy` is a user id, or the literal `'unknown'` for the rows the
 * server has no deleter for — which is why it is a string and not a
 * `TrashDeleter`. Offer that value only when the response says
 * `unknown_deleter_present`.
 */
export interface TrashQuery {
  q?: string
  kind?: TrashKind | 'all'
  deletedBy?: string | null
  sort?: TrashSort
  order?: 'asc' | 'desc'
  includeNested?: boolean
  limit?: number
  offset?: number
}

/**
 * The query string for one trash view, built in ONE place so the SWR key
 * and the request cannot disagree — the key IS the request here.
 *
 * `offset`, never `skip`: §240 keeps `skip` only as a deprecated alias for
 * pre-§240 callers, and sending both is how a page starts at the wrong row.
 * `sort` is omitted at its API default so the plain view keeps a short key;
 * `order` is always explicit, because "Newest" and "Oldest" are the same
 * sort key in opposite directions and the web must not depend on the
 * server's default being the one its label promises.
 */
export function trashQueryString(query: TrashQuery = {}): string {
  const params = new URLSearchParams()
  const q = query.q?.trim()
  if (q) params.set('q', q)
  if (query.kind && query.kind !== 'all') params.set('kind', query.kind)
  if (query.deletedBy) params.set('deleted_by', query.deletedBy)
  if (query.sort && query.sort !== 'deleted_at') params.set('sort', query.sort)
  if (query.order) params.set('order', query.order)
  if (query.includeNested) params.set('include_nested', 'true')
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset) params.set('offset', String(query.offset))
  const serialised = params.toString()
  return serialised ? `?${serialised}` : ''
}

/**
 * One page of Recently Deleted.
 *
 * Tolerant of a response WITHOUT `items` on purpose: the legacy
 * `{folders, assets}` shape is what a pre-§240 API answers and what the
 * existing page-level test fixtures return, and the view then simply has
 * nothing to show rather than throwing on `data.items.map`.
 */
export function useTrash(projectId: string, query: TrashQuery = {}) {
  const key = projectId
    ? `/projects/${projectId}/trash${trashQueryString(query)}`
    : null
  const { data, mutate, isLoading } = useSWR<TrashResponse>(
    key,
    (k: string) => api.get<TrashResponse>(k),
  )

  const items: TrashEntry[] = data?.items ?? []

  return {
    items,
    /** The whole match count for this caller — what paging is built on. */
    total: data?.total ?? items.length,
    /** The SERVER's retention window, with the web's constant as fallback. */
    retentionDays: data?.retention_days ?? null,
    deleters: data?.deleters ?? [],
    unknownDeleterPresent: data?.unknown_deleter_present ?? false,
    trash: data ?? { folders: [], assets: [] },
    isLoading,
    mutateTrash: mutate,
  }
}
