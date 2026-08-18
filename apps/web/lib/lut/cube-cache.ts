/**
 * Shared fetch/parse/cache for .cube files, keyed by LUT id.
 *
 * Pulled out of use-lut.ts so the live grading preview and the LUT-browser
 * thumbnails (lut-thumbnail.ts) hit one cache rather than two: opening the
 * picker after Settings has already drawn a library's thumbnails should
 * re-parse nothing.
 *
 * A .cube's *content* is immutable once uploaded — only metadata (name,
 * group, sharing) changes via PATCH — so there is no invalidation case to
 * handle beyond the cache living for the session.
 */

import { resolveApiMediaUrl } from '@/lib/utils'
import { parseCube, type ParsedCube } from './cube-parser'

/** A 33³ LUT is ~140k floats to parse, and the same LUT is routinely picked
 *  again across assets within one session. */
const cubeCache = new Map<string, ParsedCube>()

/** In-flight fetch+parse per LUT id. Without this, a picker selection and a
 *  thumbnail render firing for the same LUT in the same tick each do their
 *  own fetch and their own parse. */
const inFlight = new Map<string, Promise<ParsedCube>>()

/** Synchronous hit-test, for callers that want to render without a tick of
 *  loading state when the LUT is already parsed. */
export function getCachedCube(lutId: string): ParsedCube | undefined {
  return cubeCache.get(lutId)
}

export function loadCube(
  lutId: string,
  fileUrl: string | null | undefined,
): Promise<ParsedCube> {
  const cached = cubeCache.get(lutId)
  if (cached) return Promise.resolve(cached)

  const existing = inFlight.get(lutId)
  if (existing) return existing

  const url = resolveApiMediaUrl(fileUrl)
  if (!url) return Promise.reject(new Error('This LUT has no file to load'))

  const request = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load LUT (${res.status})`)
      return res.text()
    })
    .then((text) => {
      const parsed = parseCube(text)
      cubeCache.set(lutId, parsed)
      return parsed
    })
    .finally(() => {
      // Dropped whether it resolved or rejected. A success lives in
      // cubeCache from here on; a failure has to be retryable rather than a
      // permanently-rejected promise handed to every later caller.
      inFlight.delete(lutId)
    })

  inFlight.set(lutId, request)
  return request
}
