'use client'

import * as React from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import type { ParsedCube } from '@/lib/lut/cube-parser'
import { getCachedCube, loadCube } from '@/lib/lut/cube-cache'
import { isWebGL2Available } from '@/lib/lut/webgl-lut'
import type { Lut } from '@/types'

export interface UseLutResult {
  /** Everything the picker should list for this project. */
  luts: Lut[]
  isLoading: boolean
  selectedId: string | null
  select: (id: string | null) => void
  /** Parsed LUT ready for LutRenderer.setLut, or null for no grade. */
  cube: ParsedCube | null
  /** Set while the .cube is being fetched/parsed after a selection. */
  isLoadingCube: boolean
  error: string | null
  /** False on browsers without WebGL2 — callers should hide LUT UI entirely. */
  supported: boolean
}

/**
 * Owns the LUT list, the current selection, and the parsed .cube behind it.
 *
 * `initialLutId` is the asset's team-wide grade (Asset.applied_lut_id); the
 * user can then preview anything else locally without that write ever
 * happening — the distinction the backend enforces in routers/luts.py.
 */
export function useLut(projectId: string | null | undefined, initialLutId?: string | null): UseLutResult {
  const supported = React.useMemo(() => isWebGL2Available(), [])

  const { data: luts, isLoading } = useSWR<Lut[]>(
    supported && projectId ? `/projects/${projectId}/luts` : null,
    (key: string) => api.get<Lut[]>(key),
  )

  const [selectedId, setSelectedId] = React.useState<string | null>(initialLutId ?? null)
  const [cube, setCube] = React.useState<ParsedCube | null>(null)
  const [isLoadingCube, setIsLoadingCube] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Follow the asset's saved grade when navigating between assets.
  React.useEffect(() => {
    setSelectedId(initialLutId ?? null)
  }, [initialLutId])

  React.useEffect(() => {
    let cancelled = false

    if (!selectedId) {
      setCube(null)
      setError(null)
      setIsLoadingCube(false)
      return
    }

    const cached = getCachedCube(selectedId)
    if (cached) {
      setCube(cached)
      setError(null)
      return
    }

    const lut = luts?.find((l) => l.id === selectedId)
    if (!lut?.file_url) return // list hasn't arrived yet; re-runs when it does

    setIsLoadingCube(true)
    setError(null)
    // Shared with the LUT-browser thumbnails, so a LUT already drawn as a
    // swatch is applied here with no second fetch or parse.
    loadCube(selectedId, lut.file_url)
      .then((parsed) => {
        if (!cancelled) {
          setCube(parsed)
          setIsLoadingCube(false)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        // Deliberately drops the grade rather than showing an ungraded
        // frame as though it were graded.
        setCube(null)
        setError(e instanceof Error ? e.message : 'Could not load LUT')
        setIsLoadingCube(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedId, luts])

  return {
    luts: luts ?? [],
    isLoading,
    selectedId,
    select: setSelectedId,
    cube,
    isLoadingCube,
    error,
    supported,
  }
}
