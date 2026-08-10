'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type { Folder, FolderTreeNode, TrashResponse } from '@/types'

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
    purgeAsset,
    purgeFolder,
  }
}

export function useTrash(projectId: string) {
  const { data, mutate, isLoading } = useSWR<TrashResponse>(
    projectId ? `/projects/${projectId}/trash` : null,
    (key: string) => api.get<TrashResponse>(key),
  )

  return {
    trash: data ?? { folders: [], assets: [] },
    isLoading,
    mutateTrash: mutate,
  }
}
