'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { resolveApiMediaUrl } from '@/lib/utils'

interface StreamUrlResponse {
  url: string
}

/**
 * Fetch a version-scoped stream URL for a compare pane.
 * Mirrors VideoPlayer's internal fetch (incl. relative-HLS prefixing and the
 * ignore-flag anti-race guard) but is keyed on an explicit versionId instead
 * of the global review store.
 */
export function useStreamUrl(assetId: string | null, versionId: string | null) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let ignore = false
    setUrl(null)
    setError(false)
    if (!assetId || !versionId) return
    api
      .get<StreamUrlResponse>(`/assets/${assetId}/stream?version_id=${versionId}`)
      .then((data) => {
        if (ignore) return
        // resolveApiMediaUrl rather than upstream's inline prefixing: our
        // fork already centralises this rule, and §32 was a live 404 caused
        // by two copies of it disagreeing about how many times to apply.
        setUrl(resolveApiMediaUrl(data.url))
      })
      .catch(() => {
        if (!ignore) setError(true)
      })
    return () => {
      ignore = true
    }
  }, [assetId, versionId])

  return { url, error }
}
