/**
 * The SocialSnippet API, typed. Every call the snippets UI makes goes through
 * here, so the paths and the query encoding exist once.
 *
 * Reads are SWR keys plus one fetcher (`snippetFetcher`); writes are plain
 * async functions that the components follow with `mutate`.
 *
 * DEV FIXTURES: with NEXT_PUBLIC_SNIPPET_FIXTURES=1 every call is answered by
 * lib/snippet-fixtures.ts instead of the API, so the page can be looked at
 * without a backend. The check is written as a literal comparison on
 * `process.env.NEXT_PUBLIC_SNIPPET_FIXTURES` at each call site on purpose:
 * Next inlines the value at build time, the condition becomes `"" === "1"`,
 * and webpack drops the dynamic import with the dead branch, so a normal
 * build does not contain the fixture module at all.
 */
import { api, ApiError } from '@/lib/api'
import type {
  SnippetClip,
  SnippetExport,
  SnippetPatch,
  SnippetProcessResponse,
  SnippetSearchParams,
  SnippetSearchResponse,
  SnippetSettings,
  SnippetSettingsPatch,
  SnippetSpeaker,
  SnippetSuggest,
  SnippetTrack,
  SnippetTrackSpeakerResponse,
  SnippetTranscript,
} from '@/types'

export const fixturesEnabled = process.env.NEXT_PUBLIC_SNIPPET_FIXTURES === '1'

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (process.env.NEXT_PUBLIC_SNIPPET_FIXTURES === '1') {
    const { fixtureRequest } = await import('./snippet-fixtures')
    return fixtureRequest<T>(method, path, body)
  }
  switch (method) {
    case 'GET':
      return api.get<T>(path)
    case 'POST':
      return api.post<T>(path, body)
    case 'PATCH':
      return api.patch<T>(path, body)
    case 'PUT':
      return api.put<T>(path, body)
  }
}

/** The SWR fetcher for every key below. */
export const snippetFetcher = <T>(key: string): Promise<T> => call<T>('GET', key)

// ─── Query encoding ──────────────────────────────────────────────────────────

/**
 * The search query string. Repeatable filters are repeated keys
 * (`topic=a&topic=b`), which is what FastAPI's list query params expect.
 * Empty values are left out so the server's defaults apply (and so the SWR
 * key of "no filters" is stable).
 */
export function searchQuery(p: SnippetSearchParams): string {
  const qs = new URLSearchParams()
  const q = p.q?.trim()
  if (q) qs.set('q', q)
  for (const id of p.speaker_id ?? []) qs.append('speaker_id', id)
  for (const t of p.topic ?? []) qs.append('topic', t)
  if (p.min_ms != null) qs.set('min_ms', String(p.min_ms))
  if (p.max_ms != null) qs.set('max_ms', String(p.max_ms))
  for (const s of p.source ?? []) qs.append('source', s)
  for (const s of p.status ?? []) qs.append('status', s)
  if (p.sort && p.sort !== 'relevance') qs.set('sort', p.sort)
  if (p.group && p.group !== 'none') qs.set('group', p.group)
  if (p.page && p.page > 1) qs.set('page', String(p.page))
  if (p.page_size) qs.set('page_size', String(p.page_size))
  return qs.toString()
}

// ─── Keys (reads) ────────────────────────────────────────────────────────────

export const snippetKeys = {
  settings: (projectId: string) => `/projects/${projectId}/snippet/settings`,
  speakers: (projectId: string) => `/projects/${projectId}/snippet/speakers`,
  suggest: (projectId: string, q: string) =>
    `/projects/${projectId}/snippet/suggest?${new URLSearchParams({ q: q.trim() })}`,
  search: (projectId: string, p: SnippetSearchParams) => {
    const qs = searchQuery(p)
    return `/projects/${projectId}/snippet/search${qs ? `?${qs}` : ''}`
  },
  tracks: (mediaFileId: string) => `/media-files/${mediaFileId}/snippet/tracks`,
  transcript: (mediaFileId: string, fromMs: number, toMs: number) =>
    `/media-files/${mediaFileId}/snippet/transcript?from_ms=${Math.max(0, Math.floor(fromMs))}&to_ms=${Math.ceil(toMs)}`,
  export: (exportId: string) => `/exports/${exportId}`,
}

/** The transcript endpoint answers at most 10 minutes at a time. */
export const TRANSCRIPT_MAX_RANGE_MS = 10 * 60 * 1000

// ─── Writes ──────────────────────────────────────────────────────────────────

export const snippetApi = {
  getSettings: (projectId: string) => call<SnippetSettings>('GET', snippetKeys.settings(projectId)),
  patchSettings: (projectId: string, body: SnippetSettingsPatch) =>
    call<SnippetSettings>('PATCH', snippetKeys.settings(projectId), body),
  process: (projectId: string, assetIds: string[], force = false) =>
    call<SnippetProcessResponse>('POST', `/projects/${projectId}/snippet/process`, {
      asset_ids: assetIds,
      force,
    }),
  createSpeaker: (projectId: string, name: string) =>
    call<SnippetSpeaker>('POST', snippetKeys.speakers(projectId), { name }),
  listTracks: (mediaFileId: string) => call<SnippetTrack[]>('GET', snippetKeys.tracks(mediaFileId)),
  setTrackSpeaker: (mediaFileId: string, trackIndex: number, speakerId: string) =>
    call<SnippetTrackSpeakerResponse>(
      'PUT',
      `/media-files/${mediaFileId}/snippet/tracks/${trackIndex}/speaker`,
      { speaker_id: speakerId },
    ),
  suggest: (projectId: string, q: string) => call<SnippetSuggest>('GET', snippetKeys.suggest(projectId, q)),
  search: (projectId: string, p: SnippetSearchParams) =>
    call<SnippetSearchResponse>('GET', snippetKeys.search(projectId, p)),
  transcript: (mediaFileId: string, fromMs: number, toMs: number) =>
    call<SnippetTranscript>('GET', snippetKeys.transcript(mediaFileId, fromMs, toMs)),
  /** PATCH /snippets/{id}. Only for kind "snippet": a moment has no row. */
  patchSnippet: (snippetId: string, body: SnippetPatch) =>
    call<SnippetClip>('PATCH', `/snippets/${snippetId}`, body),
  /** Prompt #8. A 404 means that endpoint is not deployed yet. */
  createExport: (snippetId: string, aspect: string) =>
    call<SnippetExport>('POST', `/snippets/${snippetId}/exports`, { aspect }),
  getExport: (exportId: string) => call<SnippetExport>('GET', snippetKeys.export(exportId)),
}

// ─── Error helpers ───────────────────────────────────────────────────────────

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiError ? err.status : null
}

export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) return err.detail || fallback
  if (err instanceof Error) return err.message || fallback
  return fallback
}

/** True for the two answers that mean "SocialSnippet is not available here":
 *  404 (not a member, or no such project) and 409 (not enabled). */
export function isUnavailable(err: unknown): boolean {
  const s = errorStatus(err)
  return s === 404 || s === 409
}
