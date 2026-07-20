'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Project } from '@/types'

/**
 * True for superadmins, or anyone holding owner/admin membership on at
 * least one project. Shared gate for Settings-section access -- both the
 * burger-menu link (components/layout/sidebar.tsx) and the Settings
 * sub-nav (app/(dashboard)/settings/layout.tsx) key off this exact check,
 * so a user's access to one always matches the other.
 */
export function useHasProjectPrivilege(): boolean {
  const { user, isSuperAdmin } = useAuthStore()
  const { data: projects } = useSWR<Project[]>(
    user && !isSuperAdmin ? '/projects' : null,
    (key: string) => api.get<Project[]>(key),
  )

  if (isSuperAdmin) return true
  return !!projects?.some((p) => p.role === 'owner' || p.role === 'admin')
}
