'use client'

import * as React from 'react'
import useSWR from 'swr'
import { ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TechnicalMetadataList } from '@/components/review/technical-metadata-list'
import { SidecarList } from '@/components/review/sidecar-metadata'
import type { SidecarFile, TechnicalMetadata } from '@/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/**
 * The Fields panel for a share-link viewer (CLAUDE.md §33).
 *
 * One component for both share surfaces — `app/share/[token]/page.tsx` and
 * `components/share/folder-share-viewer.tsx` — which previously had one
 * working Fields tab and one that rendered nothing at all.
 *
 * Everything comes from a single share-token route that decides the level
 * server-side. The component renders what it is given rather than deciding
 * what a viewer may see: `technical_metadata` and `sidecars` are simply
 * absent unless the link is set to `full`, so there is nothing here to
 * bypass.
 *
 * Deliberately NOT rendered at any level: the project's custom metadata
 * fields and the rating voter breakdown. Both describe the team rather than
 * the asset, and neither is sent by the route.
 */

export interface ShareFieldsData {
  level: 'disabled' | 'basic' | 'full'
  name: string
  asset_type: string
  description?: string | null
  rating?: number | null
  due_date?: string | null
  keywords?: string[]
  technical_metadata?: TechnicalMetadata | null
  sidecars?: SidecarFile[] | null
}

function Row({
  label,
  value,
  capitalize,
}: {
  label: string
  value: string
  capitalize?: boolean
}) {
  return (
    <div className="space-y-0.5">
      <span className="text-xs text-text-tertiary">{label}</span>
      <p className={cn('text-sm text-text-primary break-words', capitalize && 'capitalize')}>
        {value}
      </p>
    </div>
  )
}

export function ShareFieldsPanel({
  token,
  assetId,
  shareSession,
  className,
}: {
  token: string
  assetId: string
  shareSession?: string | null
  className?: string
}) {
  const [showAllFields, setShowAllFields] = React.useState(false)

  const query = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
  const { data, isLoading, error } = useSWR<ShareFieldsData>(
    assetId ? `${API_URL}/share/${token}/fields/${assetId}${query}` : null,
    async (url: string) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(String(res.status))
      return res.json()
    },
  )

  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center p-6', className)}>
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className={cn('p-4', className)}>
        <p className="text-xs text-text-tertiary">Details are unavailable.</p>
      </div>
    )
  }

  const keywords = data.keywords ?? []
  const technical = data.technical_metadata ?? null
  const sidecars = data.sidecars ?? null
  const hasTechnical =
    !!technical && Object.values(technical).some((v) => v !== undefined && v !== null)

  return (
    <div className={cn('flex-1 overflow-y-auto p-4 space-y-4', className)}>
      <div className="space-y-3">
        <Row label="Name" value={data.name} />
        <Row label="Type" value={data.asset_type.replace('_', ' ')} capitalize />
        {data.description && <Row label="Description" value={data.description} />}
        {data.rating != null && <Row label="Rating" value={`${data.rating}/5`} />}
        {data.due_date && (
          <Row label="Due date" value={new Date(data.due_date).toLocaleDateString()} />
        )}
        {keywords.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs text-text-tertiary">Keywords</span>
            <div className="flex flex-wrap gap-1">
              {keywords.map((kw, i) => (
                <span
                  key={i}
                  className="text-2xs bg-bg-tertiary text-text-secondary rounded px-1.5 py-0.5"
                >
                  {kw}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* full only — collapsed by default, matching the logged-in Fields tab */}
      {hasTechnical && (
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setShowAllFields((v) => !v)}
            className="w-full flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <span>{showAllFields ? 'Hide' : 'Show'} all fields</span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', showAllFields && 'rotate-180')}
            />
          </button>
          {showAllFields && <TechnicalMetadataList metadata={technical!} />}
        </div>
      )}

      {sidecars && sidecars.length > 0 && (
        <div className="pt-2">
          <div className="pb-2 mb-1 border-b border-border/60">
            <h3 className="text-xs font-medium text-text-secondary">From uploaded sidecar</h3>
          </div>
          <SidecarList sidecars={sidecars} />
        </div>
      )}
    </div>
  )
}
