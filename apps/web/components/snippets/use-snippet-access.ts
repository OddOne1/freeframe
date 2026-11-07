'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import { snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import { useAuthStore } from '@/stores/auth-store'
import type { ProjectMember, ProjectRole, SnippetSettings } from '@/types'

/**
 * Who the caller is in this project, as far as SocialSnippet cares, and the
 * project's SocialSnippet settings.
 *
 * The role comes from the same `/projects/{id}/members` key the project page
 * already reads (SWR dedupes it), matched to the signed-in user, which is how
 * the project page derives `currentRole`.
 *
 *  - canEdit:   editor and up (owner, admin, editor). Approve/reject, in/out.
 *  - canManage: owner or superadmin, the server's `is_project_owner_or_superadmin`.
 *               NOT admin: settings and processing are owner-only server-side.
 *
 * The UI only hides what the server would refuse; the server still decides.
 */
export function useSnippetAccess(projectId: string) {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin)

  const { data: members } = useSWR<ProjectMember[]>(
    projectId ? `/projects/${projectId}/members` : null,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )
  const settingsSWR = useSWR<SnippetSettings>(
    projectId ? snippetKeys.settings(projectId) : null,
    snippetFetcher,
    { shouldRetryOnError: false },
  )

  const role: ProjectRole | null = members?.find((m) => m.user_id === user?.id)?.role ?? null
  const canEdit = role === 'owner' || role === 'admin' || role === 'editor'
  const canManage = role === 'owner' || isSuperAdmin

  return {
    role,
    canEdit,
    canManage,
    settings: settingsSWR.data,
    settingsError: settingsSWR.error as unknown,
    settingsLoading: settingsSWR.isLoading,
    mutateSettings: settingsSWR.mutate,
  }
}
