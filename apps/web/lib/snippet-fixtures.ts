/**
 * DEV ONLY. Answers the SocialSnippet API from memory so the snippets page can
 * be looked at before the backend is reachable. Loaded solely by
 * lib/snippet-api.ts behind `process.env.NEXT_PUBLIC_SNIPPET_FIXTURES === '1'`;
 * a normal build never includes this module.
 *
 * Six clips: two speakers, three topics, one audio-only file, one clip with no
 * scores, plus one transcript "moment". Searching, filtering, sorting,
 * grouping, approve/reject, in/out saves and exports all work against it.
 *
 * Media: set NEXT_PUBLIC_SNIPPET_FIXTURE_VIDEO / NEXT_PUBLIC_SNIPPET_FIXTURE_AUDIO
 * to an absolute URL (an .m3u8 or an .mp4/.m4a) to make the player play
 * something. Unset, stream_url is null and the player says so.
 */
import { ApiError } from '@/lib/api'
import type {
  SnippetClip,
  SnippetExportJob,
  SnippetSearchResponse,
  SnippetSettings,
  SnippetSpeaker,
  SnippetTranscript,
  SnippetTranscriptSegment,
} from '@/types'

const VIDEO_URL = process.env.NEXT_PUBLIC_SNIPPET_FIXTURE_VIDEO || null
const AUDIO_URL = process.env.NEXT_PUBLIC_SNIPPET_FIXTURE_AUDIO || null
const ANNA: SnippetSpeaker = { id: '0d4f1c8e-0000-4000-8000-00000000a001', name: 'Anna Berger' }
const MARCO: SnippetSpeaker = { id: '0d4f1c8e-0000-4000-8000-00000000a002', name: 'Marco Rossi' }

const MF_INTERVIEW = '0d4f1c8e-0000-4000-8000-0000000f0001'
const MF_PANEL = '0d4f1c8e-0000-4000-8000-0000000f0002'
const MF_PODCAST = '0d4f1c8e-0000-4000-8000-0000000f0003'

const DURATIONS: Record<string, number> = {
  [MF_INTERVIEW]: 300_000,
  [MF_PANEL]: 240_000,
  [MF_PODCAST]: 600_000,
}

const thumb = (hue: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${hue + 40},40%,18%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="160" cy="78" r="30" fill="hsla(0,0%,100%,.18)"/><rect x="110" y="114" width="100" height="40" rx="20" fill="hsla(0,0%,100%,.14)"/></svg>`,
  )}`

function base(
  c: Omit<SnippetClip, 'duration_ms' | 'kind' | 'stream_url' | 'thumbnail_url' | 'generator'> & {
    kind?: SnippetClip['kind']
    audio?: boolean
    hue?: number
    generator?: string | null
  },
): SnippetClip {
  const { audio, hue = 210, ...rest } = c
  return {
    kind: 'snippet',
    generator: rest.source === 'llm' ? 'claude-haiku-5-5' : rest.source === 'keyword' ? 'keyword-v1' : null,
    ...rest,
    duration_ms: rest.end_ms - rest.start_ms,
    stream_url: audio ? AUDIO_URL : VIDEO_URL,
    thumbnail_url: audio ? null : thumb(hue),
  }
}

let clips: SnippetClip[] = [
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0001',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0001',
    asset_name: 'Interview_Anna_A-cam.mov',
    media_file_id: MF_INTERVIEW,
    speaker: ANNA,
    start_ms: 12_400,
    end_ms: 31_900,
    title: 'Why we left the glacier camp early',
    quote:
      'We had planned three weeks on the ice, but by day nine the meltwater was running under the tents, and at that point you stop arguing with the mountain and you start packing.',
    topics: ['climate', 'expedition'],
    quality_score: 0.86,
    viral_score: 0.72,
    source: 'llm',
    status: 'suggested',
    hue: 200,
  }),
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0002',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0001',
    asset_name: 'Interview_Anna_A-cam.mov',
    media_file_id: MF_INTERVIEW,
    speaker: ANNA,
    start_ms: 95_000,
    end_ms: 104_500,
    title: 'The one photo that made it',
    quote: 'Out of four thousand frames there is exactly one I would print, and I took it with my phone.',
    topics: ['photography'],
    quality_score: 0.64,
    viral_score: 0.91,
    source: 'keyword',
    status: 'approved',
    hue: 30,
  }),
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0003',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0002',
    asset_name: 'Panel_Day2_wide.mp4',
    media_file_id: MF_PANEL,
    speaker: MARCO,
    start_ms: 41_000,
    end_ms: 68_200,
    title: 'Funding expeditions without sponsors',
    quote:
      'Sponsors want a summit photo with a logo on it. If your science needs you to sit in one valley for a month, you need a different kind of money, and that money is slower.',
    topics: ['expedition'],
    quality_score: 0.71,
    viral_score: 0.38,
    source: 'import',
    status: 'suggested',
    hue: 140,
  }),
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0004',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0002',
    asset_name: 'Panel_Day2_wide.mp4',
    media_file_id: MF_PANEL,
    speaker: MARCO,
    start_ms: 150_300,
    end_ms: 162_800,
    title: 'Not yet scored: the audience question',
    quote: 'Somebody asked whether we were ever scared, and honestly the scary part was the paperwork.',
    topics: ['expedition', 'photography'],
    quality_score: null,
    viral_score: null,
    source: 'manual',
    status: 'suggested',
    hue: 280,
  }),
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0005',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0003',
    asset_name: 'Podcast_Ep14_master.wav',
    media_file_id: MF_PODCAST,
    speaker: ANNA,
    start_ms: 302_000,
    end_ms: 326_500,
    title: 'Measuring a glacier with a tape and a drone',
    quote:
      'The drone gives you the shape and the tape gives you the truth. You need both, because the drone will happily tell you the ice is twelve metres thicker than it is.',
    topics: ['climate'],
    quality_score: 0.79,
    viral_score: 0.55,
    source: 'llm',
    status: 'approved',
    audio: true,
  }),
  base({
    id: '0d4f1c8e-0000-4000-8000-0000000c0006',
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0003',
    asset_name: 'Podcast_Ep14_master.wav',
    media_file_id: MF_PODCAST,
    speaker: MARCO,
    start_ms: 410_000,
    end_ms: 419_000,
    title: 'Too rough to use',
    quote: 'So yeah, uh, that was, I mean, we can cut that.',
    topics: ['climate'],
    quality_score: 0.12,
    viral_score: 0.05,
    source: 'keyword',
    status: 'rejected',
    audio: true,
  }),
]

/** A transcript hit no clip covers: only returned when q matches it. */
const MOMENT: SnippetClip = {
  ...base({
    id: `moment:${MF_INTERVIEW}:188000`,
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0001',
    asset_name: 'Interview_Anna_A-cam.mov',
    media_file_id: MF_INTERVIEW,
    speaker: ANNA,
    start_ms: 188_000,
    end_ms: 201_400,
    title: null,
    quote: 'The glacier had retreated about forty metres since the last survey, which sounds small until you stand where the ice used to be.',
    topics: [],
    quality_score: null,
    viral_score: null,
    source: null,
    status: null,
    hue: 200,
  }),
  kind: 'moment',
  generator: null,
}

let settings: SnippetSettings = {
  enabled: true,
  source_folder_id: null,
  export_retention_days: 30,
  export_aspect: '9:16',
  caption_font: null,
}

const speakers: SnippetSpeaker[] = [ANNA, MARCO]

// ─── Transcripts: words laid out evenly over each clip's span ────────────────

function segmentFor(c: SnippetClip, i: number): SnippetTranscriptSegment {
  const text = c.quote ?? ''
  const tokens = text.split(/\s+/).filter(Boolean)
  const span = c.end_ms - c.start_ms
  const step = span / Math.max(1, tokens.length)
  const words = tokens.map((word, k) => {
    const s = Math.round(c.start_ms + k * step)
    return { start_ms: s, end_ms: Math.round(s + step * 0.82), word }
  })
  return {
    id: `0d4f1c8e-0000-4000-8000-${String(900000000000 + i).padStart(12, '0')}`,
    track_index: c.speaker?.id === MARCO.id ? 1 : 0,
    speaker_name: c.speaker?.name ?? null,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    text,
    status: 'auto',
    words,
  }
}

function transcript(mediaFileId: string, from: number, to: number): SnippetTranscript {
  const segs = [...clips, MOMENT]
    .filter((c) => c.media_file_id === mediaFileId)
    .map((c, i) => segmentFor(c, i))
    .filter((s) => s.end_ms > from && s.start_ms < to)
    .sort((a, b) => a.start_ms - b.start_ms)
  return { language: 'en', segments: segs }
}

// ─── Search ──────────────────────────────────────────────────────────────────

function matches(c: SnippetClip, q: string): boolean {
  const hay = [c.title, c.quote, c.speaker?.name, ...c.topics].filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

function search(projectId: string, qs: URLSearchParams): SnippetSearchResponse {
  void projectId
  const q = qs.get('q') ?? ''
  const speakerIds = qs.getAll('speaker_id')
  const topics = qs.getAll('topic').map((t) => t.toLowerCase())
  const sources = qs.getAll('source')
  const statuses = qs.getAll('status')
  const min = qs.get('min_ms') ? Number(qs.get('min_ms')) : null
  const max = qs.get('max_ms') ? Number(qs.get('max_ms')) : null
  const sort = qs.get('sort') ?? 'relevance'
  const group = qs.get('group') ?? 'none'
  const page = Number(qs.get('page') ?? 1)
  const pageSize = Math.min(60, Number(qs.get('page_size') ?? 24))
  if (min != null && max != null && min > max) throw new ApiError(422, 'min_ms must not be greater than max_ms.')

  const wanted = statuses.length ? statuses : ['suggested', 'approved']
  let pool = clips.filter((c) => wanted.includes(c.status as string))
  // Moments only without an explicit status filter, and only for a query.
  if (!statuses.length && q && !sources.length) pool = [...pool, MOMENT]
  let items = pool.filter(
    (c) =>
      (!q || matches(c, q)) &&
      (!speakerIds.length || (c.speaker && speakerIds.includes(c.speaker.id))) &&
      (!topics.length || c.topics.some((t) => topics.includes(t.toLowerCase()))) &&
      (!sources.length || (c.source && sources.includes(c.source))) &&
      (min == null || c.duration_ms >= min) &&
      (max == null || c.duration_ms <= max),
  )
  const nullsLast = (k: 'quality_score' | 'viral_score') => (a: SnippetClip, b: SnippetClip) =>
    (b[k] ?? -1) - (a[k] ?? -1)
  if (sort === 'quality') items = [...items].sort(nullsLast('quality_score'))
  if (sort === 'viral') items = [...items].sort(nullsLast('viral_score'))
  if (sort === 'length_asc') items = [...items].sort((a, b) => a.duration_ms - b.duration_ms)
  if (sort === 'length_desc') items = [...items].sort((a, b) => b.duration_ms - a.duration_ms)

  type Entry = { key: string; label: string; clip: SnippetClip }
  let entries: Entry[]
  if (group === 'speaker') {
    entries = items.map((c) => ({ key: c.speaker?.id ?? 'none', label: c.speaker?.name ?? 'No speaker', clip: c }))
  } else if (group === 'topic') {
    entries = items.flatMap((c) =>
      c.topics.length
        ? c.topics.map((t) => ({ key: t.toLowerCase(), label: t, clip: c }))
        : [{ key: 'none', label: 'No topic', clip: c }],
    )
  } else {
    entries = items.map((c) => ({ key: 'all', label: 'All', clip: c }))
  }
  if (group !== 'none') {
    entries = entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        if ((a.e.key === 'none') !== (b.e.key === 'none')) return a.e.key === 'none' ? 1 : -1
        return a.e.label.localeCompare(b.e.label) || a.i - b.i
      })
      .map((x) => x.e)
  }
  const slice = entries.slice((page - 1) * pageSize, page * pageSize)
  const groups: SnippetSearchResponse['groups'] = []
  for (const e of slice) {
    const last = groups[groups.length - 1]
    if (last && last.key === e.key) last.items.push(e.clip)
    else groups.push({ key: e.key, label: e.label, items: [e.clip] })
  }
  return { total: entries.length, page, page_size: pageSize, groups }
}

// ─── Exports: a fake job that finishes in about six seconds ──────────────────
//
// Contract shape: POST -> {export_id, status: "queued"};
// GET -> {status, progress 0..1, download_url|null, error|null}.
//
// Which outcome the fake produces: localStorage "snippet-fixture-exports"
// (so it can be switched in the browser without a restart), else
// NEXT_PUBLIC_SNIPPET_FIXTURE_EXPORTS, else "ok". Modes:
//   ok        queued -> running -> done
//   missing   POST 404 (prompt #8 not deployed)
//   disabled  POST 409
//   refuse    POST 422 "aspect not available yet"
//   failed    the job fails half way, with an error
//   expired   the job reports an unknown status, "expired"
//   legacy-id POST answers {id} instead of {export_id}

type ExportMode = 'ok' | 'missing' | 'disabled' | 'refuse' | 'failed' | 'expired' | 'legacy-id'

function exportMode(): ExportMode {
  let fromStorage: string | null = null
  try {
    fromStorage = globalThis.localStorage?.getItem('snippet-fixture-exports') ?? null
  } catch {
    // storage blocked: fall through to the env value
  }
  return (fromStorage || process.env.NEXT_PUBLIC_SNIPPET_FIXTURE_EXPORTS || 'ok') as ExportMode
}

const exportsById = new Map<string, { started: number; aspect: string; mode: ExportMode }>()

function exportState(id: string): SnippetExportJob {
  const job = exportsById.get(id)
  if (!job) throw new ApiError(404, 'Not found')
  const progress = Math.min(1, (Date.now() - job.started) / 6000)
  if (job.mode === 'failed' && progress >= 0.5) {
    return { status: 'failed', progress: 0.5, download_url: null, error: 'ffmpeg exited with code 1 (fixture)' }
  }
  if (job.mode === 'expired' && progress >= 0.3) {
    return { status: 'expired', progress: null, download_url: null, error: null }
  }
  return {
    status: progress >= 1 ? 'done' : progress < 0.15 ? 'queued' : 'running',
    progress,
    download_url: progress >= 1 ? (VIDEO_URL ?? 'data:text/plain,fixture%20export') : null,
    error: null,
  }
}

/** Every fixture request with its body, for checking from the browser
 *  console what was sent and that polling stops
 *  (window.__snippetFixtureLog). Dev fixtures only. */
function logRequest(method: string, path: string, body?: unknown) {
  const w = globalThis as unknown as {
    __snippetFixtureLog?: { at: number; method: string; path: string; body?: unknown }[]
  }
  ;(w.__snippetFixtureLog ??= []).push({
    at: Date.now(),
    method,
    path,
    ...(body !== undefined ? { body: JSON.parse(JSON.stringify(body)) } : {}),
  })
}

/** The export POST's checks, as the API makes them (prompt #8). */
function checkExportRequest(target: string, body: { aspect?: string; start_ms?: number; end_ms?: number; captions?: boolean }) {
  let mediaFileId: string | undefined
  if (target.startsWith('moment:')) {
    mediaFileId = target.split(':')[1]
  } else {
    mediaFileId = clips.find((c) => c.id === target)?.media_file_id
  }
  if (!mediaFileId || DURATIONS[mediaFileId] == null) throw new ApiError(404, 'Snippet not found')
  if (body.start_ms == null || body.end_ms == null) throw new ApiError(422, 'start_ms and end_ms are required.')
  const aspects = ['9:16', '16:9', '1:1', '4:5', '3:4', '4:3']
  if (!body.aspect || !aspects.includes(body.aspect)) throw new ApiError(422, `aspect must be one of ${aspects.join(', ')}.`)
  if (body.aspect !== '9:16' && body.aspect !== '16:9') throw new ApiError(422, 'aspect not available yet')
  if (body.captions) throw new ApiError(422, 'captions not available yet')
  if (mediaFileId === MF_PODCAST) throw new ApiError(422, 'audio-only export not supported yet')
  if (body.start_ms < 0) throw new ApiError(422, 'start_ms must be 0 or more.')
  if (body.start_ms >= body.end_ms) throw new ApiError(422, 'start_ms must be before end_ms.')
  if (body.end_ms - body.start_ms < 1000) throw new ApiError(422, 'An export must be at least 1 second long.')
  if (body.end_ms - body.start_ms > 600_000) throw new ApiError(422, 'An export may be at most 10 minutes long.')
  if (body.end_ms > DURATIONS[mediaFileId]) throw new ApiError(422, 'end_ms is past the end of the file.')
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function fixtureRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  logRequest(method, path, body)
  await delay(method === 'GET' ? 250 : 400)
  const url = new URL(path, 'http://fixture.local')
  const p = url.pathname
  const qs = url.searchParams
  let m: RegExpMatchArray | null

  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/settings$/))) {
    if (method === 'PATCH') settings = { ...settings, ...(body as Partial<SnippetSettings>) }
    return settings as T
  }
  if (!settings.enabled && p.includes('/snippet/')) throw new ApiError(409, 'SocialSnippet is not enabled for this project')

  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/speakers$/))) {
    if (method === 'POST') {
      const name = String((body as { name: string }).name).trim()
      const found = speakers.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (found) return found as T
      const s = { id: `0d4f1c8e-0000-4000-8000-${String(speakers.length + 1).padStart(12, '0')}`, name }
      speakers.push(s)
      return s as T
    }
    return speakers as T
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/suggest$/))) {
    const q = (qs.get('q') ?? '').toLowerCase()
    const live = clips.filter((c) => c.status !== 'rejected')
    const counts: Record<string, number> = {}
    for (const c of live) for (const t of c.topics) counts[t] = (counts[t] ?? 0) + 1
    return {
      names: speakers
        .filter((s) => !q || s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
        .slice(0, 6),
      topics: Object.entries(counts)
        .filter(([t]) => !q || t.startsWith(q))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([topic, count]) => ({ topic, count })),
    } as T
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/search$/))) return search(m[1], qs) as T
  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/process$/))) {
    const ids = (body as { asset_ids: string[] }).asset_ids
    return { queued: ids.length, results: ids.map((asset_id) => ({ asset_id, queued: true, reason: 'queued' })) } as T
  }
  if ((m = p.match(/^\/media-files\/([^/]+)\/snippet\/transcript$/))) {
    const dur = DURATIONS[m[1]]
    if (dur == null) throw new ApiError(404, 'Not found')
    const from = Number(qs.get('from_ms') ?? 0)
    const to = Number(qs.get('to_ms') ?? from + 600_000)
    if (from >= dur) throw new ApiError(422, 'from_ms is past the end of the file.')
    return transcript(m[1], from, to) as T
  }
  if ((m = p.match(/^\/media-files\/([^/]+)\/snippet\/tracks$/))) {
    return [
      { track_index: 0, label: 'Track 1', speaker_id: ANNA.id, speaker_name: ANNA.name },
      { track_index: 1, label: 'Track 2', speaker_id: MARCO.id, speaker_name: MARCO.name },
    ] as T
  }
  if ((m = p.match(/^\/snippets\/([^/]+)$/)) && method === 'PATCH') {
    const i = clips.findIndex((c) => c.id === m![1])
    if (i < 0) throw new ApiError(404, 'Not found')
    const patch = body as Partial<SnippetClip>
    const next = { ...clips[i], ...patch }
    const dur = DURATIONS[next.media_file_id]
    if (next.end_ms - next.start_ms < 1000) throw new ApiError(422, 'A clip must be at least 1 second long.')
    if (next.start_ms < 0 || (dur && next.end_ms > dur)) throw new ApiError(422, 'The clip must lie inside the file.')
    next.duration_ms = next.end_ms - next.start_ms
    clips = clips.map((c, k) => (k === i ? next : c))
    return next as T
  }
  if ((m = p.match(/^\/snippets\/([^/]+)\/exports$/)) && method === 'POST') {
    const mode = exportMode()
    if (mode === 'missing') throw new ApiError(404, 'Not Found')
    if (mode === 'disabled') throw new ApiError(409, 'SocialSnippet is not enabled for this project')
    if (mode === 'refuse') throw new ApiError(422, 'aspect not available yet')
    const req = body as { aspect?: string; start_ms?: number; end_ms?: number; captions?: boolean }
    checkExportRequest(decodeURIComponent(m[1]), req)
    const id = `exp-${Date.now()}`
    exportsById.set(id, { started: Date.now(), aspect: req.aspect as string, mode })
    return (mode === 'legacy-id' ? { id, status: 'queued' } : { export_id: id, status: 'queued' }) as T
  }
  if ((m = p.match(/^\/exports\/([^/]+)$/))) return exportState(m[1]) as T

  throw new ApiError(404, 'Not found')
}
