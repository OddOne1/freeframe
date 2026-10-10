'use client'

import * as React from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Project } from '@/types'

export interface StorageSummary {
  /** Projects this user owns. Empty for anyone who owns none, which is
   *  also the case where there is no storage figure worth showing. */
  ownedProjects: Project[]
  /** Sum of the owned projects' own limits. */
  allocatedBytes: number
  /** Sum of what those projects actually hold. */
  usedBytes: number
  /** The user's personal allowance, or null for "unlimited". */
  personalTotalBytes: number | null
  /** usedBytes as a share of the personal allowance, or null when there
   *  is no allowance to be a share of. */
  percentUsed: number | null
  isLoading: boolean
}

/**
 * The storage numbers behind the avatar (§224b).
 *
 * Lifted out of OwnedProjectsView (app/(dashboard)/settings/projects) so
 * the phone navigation drawer can show the same figure as the Projects
 * settings page instead of computing its own. Two surfaces quoting
 * different numbers for one account is worse than one surface.
 *
 * NULL (unlimited) projects contribute 0 to the sums rather than being
 * unbounded — the same simplification the backend's SQL SUM makes, kept
 * deliberately so the client never disagrees with the server.
 */
export function useStorageSummary(): StorageSummary {
  const { user } = useAuthStore()
  const { data: projects, isLoading } = useSWR<Project[]>('/projects', () =>
    api.get<Project[]>('/projects'),
  )

  const ownedProjects = React.useMemo(
    () => (projects ?? []).filter((p) => p.role === 'owner'),
    [projects],
  )
  const allocatedBytes = React.useMemo(
    () => ownedProjects.reduce((sum, p) => sum + (p.storage_limit_bytes ?? 0), 0),
    [ownedProjects],
  )
  const usedBytes = React.useMemo(
    () => ownedProjects.reduce((sum, p) => sum + (p.storage_bytes ?? 0), 0),
    [ownedProjects],
  )
  const personalTotalBytes = user?.storage_limit_bytes ?? null
  const percentUsed =
    personalTotalBytes === null ? null : personalTotalBytes > 0 ? (usedBytes / personalTotalBytes) * 100 : 100

  return { ownedProjects, allocatedBytes, usedBytes, personalTotalBytes, percentUsed, isLoading }
}
