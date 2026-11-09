/**
 * DEV ONLY. Answers the SocialSnippet API from memory so the snippets page can
 * be looked at before the backend is reachable. Loaded solely by
 * lib/snippet-api.ts behind `process.env.NEXT_PUBLIC_SNIPPET_FIXTURES === '1'`;
 * a normal build never includes this module.
 *
 * Six clips: two speakers, three topics, one audio-only file, one clip with no
 * scores, plus two transcript "moments" (one video, one audio-only; both
 * match "glacier"). Audio-only means no thumbnail_url, as the contract has
 * it, and that is what the player reads as "no video". Searching, filtering, sorting,
 * grouping, approve/reject, title/topic/in-out autosaves and exports all work
 * against it. Each clip sits on one track of its file (GET .../tracks is the
 * Files tab's list), and naming that track's speaker renames its clips.
 *
 * Files tab: 34 files in four folders plus the project root, in every state
 * (done, not processed, not ready, failed, one already running), many
 * without speaker names, some tracks with no speech and three very long
 * names, so the search, the filter chips, sorting, folder groups, name
 * wrapping and the 20-file "select all" limit can be seen. Processing one walks it through queued (5 s) and running (9 s
 * more) to done, so the 5 s polling can be watched starting and stopping;
 * "Keynote.mov" fails every time, for Retry.
 *
 * Media: set NEXT_PUBLIC_SNIPPET_FIXTURE_VIDEO / NEXT_PUBLIC_SNIPPET_FIXTURE_AUDIO
 * to an absolute URL (an .m3u8 or an .mp4/.m4a) to make the player play
 * something. Unset, stream_url is null and the player says so.
 */
import { ApiError } from '@/lib/api'
import type {
  SnippetClip,
  SnippetExportJob,
  SnippetFile,
  SnippetFilesResponse,
  SnippetSearchResponse,
  SnippetSettings,
  SnippetSpeaker,
  SnippetTrack,
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
  c: Omit<SnippetClip, 'duration_ms' | 'kind' | 'stream_url' | 'thumbnail_url' | 'generator' | 'user_edited'> & {
    kind?: SnippetClip['kind']
    user_edited?: boolean
    audio?: boolean
    hue?: number
    generator?: string | null
  },
): SnippetClip {
  const { audio, hue = 210, ...rest } = c
  return {
    kind: 'snippet',
    generator: rest.source === 'llm' ? 'claude-haiku-5-5' : rest.source === 'keyword' ? 'keyword-v1' : null,
    user_edited: false,
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
    // Trimmed by a person: shows the "edited" pill.
    user_edited: true,
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
  user_edited: false,
  generator: null,
}

/** An audio-only transcript moment (the podcast), so the player's audio-only
 *  handling — the AUDIO ONLY tile, no "no playable picture" message, and
 *  "Export needs a video file." instead of export buttons — can be seen on a
 *  moment as well as on a stored clip. Audio-only by contract: no thumbnail. */
const AUDIO_MOMENT: SnippetClip = {
  ...base({
    id: `moment:${MF_PODCAST}:452000`,
    asset_id: '0d4f1c8e-0000-4000-8000-0000000a0003',
    asset_name: 'Podcast_Ep14_master.wav',
    media_file_id: MF_PODCAST,
    speaker: MARCO,
    start_ms: 452_000,
    end_ms: 463_500,
    title: null,
    quote: 'Every glacier we went back to was shorter than on the old maps, without a single exception.',
    topics: [],
    quality_score: null,
    viral_score: null,
    source: null,
    status: null,
    audio: true,
  }),
  kind: 'moment',
  user_edited: false,
  generator: null,
}

const MOMENTS = [MOMENT, AUDIO_MOMENT]

let settings: SnippetSettings = {
  enabled: true,
  source_folder_id: null,
  export_retention_days: 30,
  export_aspect: '9:16',
  caption_font: null,
}

const speakers: SnippetSpeaker[] = [ANNA, MARCO]

// ─── Files tab ───────────────────────────────────────────────────────────────

/** A fixture file, plus where a run started (absent = not running). */
type FixtureFile = SnippetFile & { startedAt?: number; outcome?: 'done' | 'failed' }

const FILE_QUEUED_MS = 5_000
const FILE_RUNNING_MS = 14_000

const track = (track_index: number, label: string, who: SnippetSpeaker | null = null): SnippetTrack => ({
  track_index,
  label,
  speaker_id: who?.id ?? null,
  speaker_name: who?.name ?? null,
})

function file(id: number, f: Partial<FixtureFile> & Pick<FixtureFile, 'name'>): FixtureFile {
  return {
    asset_id: `0d4f1c8e-0000-4000-8000-0000000a${String(id).padStart(4, '0')}`,
    media_file_id: `0d4f1c8e-0000-4000-8000-0000000b${String(id).padStart(4, '0')}`,
    kind: /\.(wav|m4a|mp3)$/i.test(f.name) ? 'audio' : 'video',
    folder_path: '/Interviews',
    duration_ms: 600_000,
    asset_status: 'ready',
    not_ready_reason: null,
    snippet_status: 'not_processed',
    segment_count: 0,
    snippet_count: 0,
    error: null,
    updated_at: new Date(Date.now() - id * 3_600_000).toISOString(),
    tracks: [track(0, 'Track 1')],
    planned_track_count: (f.tracks ?? [null]).length,
    done_track_count: 0,
    ...f,
  }
}

let files: FixtureFile[] = [
  file(1, {
    name: 'Interview Anna.mov', media_file_id: MF_INTERVIEW, duration_ms: 300_000,
    snippet_status: 'done', segment_count: 84, snippet_count: 4,
    tracks: [track(0, 'Lav Anna · 1 ch · de', ANNA), track(1, 'Lav Marco · 1 ch', MARCO)],
  }),
  file(2, {
    name: 'Panel discussion.mov', media_file_id: MF_PANEL, duration_ms: 240_000,
    snippet_status: 'done', segment_count: 61, snippet_count: 1,
    error: 'Clip detection failed: ValueError: no sentence boundaries',
    tracks: [track(0, 'Track 1 · stereo', MARCO)],
  }),
  file(3, {
    name: 'Podcast episode 12.wav', media_file_id: MF_PODCAST, folder_path: '/Podcast',
    snippet_status: 'done', segment_count: 140, snippet_count: 1,
    // Host and guest on their own tracks, so a clip card's speaker select
    // and the transcript's speaker labels each find a track to name.
    tracks: [track(0, 'Host · mono', ANNA), track(1, 'Guest · mono', MARCO)],
  }),
  file(4, {
    name: 'Roundtable_with_the_whole_team_final_v3_EXPORT.mov', duration_ms: 2_520_000,
    folder_path: '/Interviews/Day 2', snippet_status: 'running', startedAt: Date.now() - FILE_QUEUED_MS,
    outcome: 'done',
    tracks: [track(0, 'Boom · mono'), track(1, 'Lav 1 · mono', ANNA), track(2, 'Lav 2 · mono')],
  }),
  file(5, {
    name: 'B-roll street.mov', duration_ms: 4_320_000, folder_path: '/Footage',
    tracks: [track(0, 'Track 1 · stereo'), track(1, 'Track 2 · stereo')],
  }),
  file(6, { name: 'Phone memo.m4a', duration_ms: null, folder_path: '/' }),
  file(7, {
    name: 'Keynote.mov', duration_ms: 1_800_000, snippet_status: 'failed',
    error: 'RuntimeError: ffmpeg exited with status 1 while extracting track 0', outcome: 'failed',
  }),
  file(8, {
    name: 'Upload in progress.mov', asset_status: 'uploading',
    not_ready_reason: 'the file is still uploading', tracks: [],
  }),
  file(9, {
    name: 'Archive 2019.mov', asset_status: 'failed',
    not_ready_reason: "the file's own processing failed; fix that first",
  }),
  file(10, {
    name: 'Camera A ambience.mxf', duration_ms: 3_420_000, snippet_status: 'done',
    tracks: [track(0, 'Track 1 · mono · no speech'), track(1, 'Track 2 · mono · no speech')],
    done_track_count: 2,
  }),
  file(11, {
    name: 'Canon interview.mxf', duration_ms: 3_420_000, snippet_status: 'failed',
    error: 'ConnectionError: S3 read timed out', outcome: 'failed',
    tracks: [track(0, 'Track 1 · mono', ANNA), track(1, 'Track 2 · mono · no speech'),
      track(2, 'Track 3 · mono'), track(3, 'Track 4 · mono')],
    done_track_count: 2,
  }),
  // More of the same shoot, so the tab has enough to filter, sort and group.
  ...Array.from({ length: 8 }, (_, i) =>
    file(12 + i, {
      name: `Interview take ${i + 2}.mov`,
      duration_ms: 240_000 + i * 95_000,
      folder_path: i < 4 ? '/Interviews' : '/Interviews/Day 2',
      snippet_status: i % 3 === 0 ? 'done' : 'not_processed',
      segment_count: i % 3 === 0 ? 50 + i : 0,
      snippet_count: i % 3 === 0 ? 2 : 0,
      tracks:
        i % 2 === 0
          ? [track(0, 'Lav Anna · 1 ch', ANNA), track(1, 'Lav guest · 1 ch')]
          : [track(0, 'Lav Anna · 1 ch', ANNA), track(1, 'Lav Marco · 1 ch', MARCO)],
    }),
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    file(20 + i, {
      name: `Drone shot ${String(i + 1).padStart(2, '0')}.mp4`,
      duration_ms: 45_000 + i * 20_000,
      folder_path: '/Footage',
      snippet_status: i < 2 ? 'done' : 'not_processed',
      tracks: [track(0, i < 2 ? 'Track 1 · stereo · no speech' : 'Track 1 · stereo')],
      done_track_count: i < 2 ? 1 : 0,
    }),
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    file(26 + i, {
      name: `Podcast episode ${13 + i}.wav`,
      duration_ms: 1_800_000 + i * 300_000,
      folder_path: '/Podcast',
      snippet_status: i === 0 ? 'done' : i === 1 ? 'failed' : 'not_processed',
      segment_count: i === 0 ? 120 : 0,
      snippet_count: i === 0 ? 5 : 0,
      error: i === 1 ? 'RuntimeError: the transcription worker stopped' : null,
      tracks: [track(0, 'Host · mono', i === 0 ? MARCO : null), track(1, 'Guest · mono')],
    }),
  ),
  file(30, { name: 'Voice note 2.m4a', duration_ms: 95_000, folder_path: '/', snippet_status: 'done',
    segment_count: 12, snippet_count: 1, tracks: [track(0, 'Track 1 · mono', ANNA)] }),
  file(31, { name: 'Untitled export.mov', duration_ms: 610_000, folder_path: '/' }),
  // Very long names, to see wrapping (two lines, then an ellipsis) and the tooltip.
  file(32, {
    name: '2026-10-14 Client interview Anna Berger and Marco Rossi about the new product line, full uncut take with room tone, camera A and lavalier tracks (final).mov',
    duration_ms: 3_960_000, folder_path: '/Interviews/Day 2', snippet_status: 'done', segment_count: 212, snippet_count: 7,
    tracks: [track(0, 'Lav Anna · 1 ch', ANNA), track(1, 'Lav Marco · 1 ch'), track(2, 'Camera A · stereo · no speech')],
    done_track_count: 3,
  }),
  file(33, {
    name: 'PODCAST_EP017_MASTER_MIXDOWN_44k1_24bit_NORMALISED_-16LUFS_v7_FINAL_FINAL_use_this_one.wav',
    duration_ms: 2_700_000, folder_path: '/Podcast', snippet_status: 'failed',
    error: 'RuntimeError: the transcription worker stopped', tracks: [track(0, 'Host · mono', MARCO), track(1, 'Guest · mono')],
    done_track_count: 1,
  }),
  file(34, {
    name: 'Drone flyover of the harbour at sunrise, long version with the slow push-in over the old lighthouse.mp4',
    duration_ms: 412_000, folder_path: '/Footage',
  }),
]

/** Moves a running fixture file along by the clock. */
function advance(f: FixtureFile): FixtureFile {
  if (f.startedAt == null) return f
  const elapsed = Date.now() - f.startedAt
  if (elapsed < FILE_QUEUED_MS) return { ...f, snippet_status: 'queued', error: null }
  if (elapsed < FILE_QUEUED_MS + FILE_RUNNING_MS) return { ...f, snippet_status: 'running', error: null }
  const failed = f.outcome === 'failed'
  return {
    ...f,
    startedAt: undefined,
    snippet_status: failed ? 'failed' : 'done',
    error: failed ? 'RuntimeError: ffmpeg exited with status 1 while extracting track 0' : null,
    segment_count: failed ? f.segment_count : Math.max(f.segment_count, 40 + f.name.length),
    snippet_count: failed ? f.snippet_count : Math.max(f.snippet_count, 3),
    updated_at: new Date().toISOString(),
  }
}

function listFiles(qs: URLSearchParams): SnippetFilesResponse {
  files = files.map(advance)
  const q = (qs.get('q') ?? '').trim().toLowerCase()
  const page = Number(qs.get('page') ?? 1)
  const size = Number(qs.get('page_size') ?? 50)
  const all = files
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return {
    total: all.length,
    items: all.slice((page - 1) * size, page * size).map(({ startedAt: _s, outcome: _o, ...f }) => f),
  }
}

function processFiles(ids: string[], force: boolean) {
  files = files.map(advance)
  const results = ids.map((asset_id) => {
    const f = files.find((x) => x.asset_id === asset_id)
    if (!f) return { asset_id, queued: false, reason: 'not found' }
    if (f.not_ready_reason) return { asset_id, queued: false, reason: f.not_ready_reason }
    if (f.startedAt != null) return { asset_id, queued: false, reason: 'a transcription is already running' }
    if (f.segment_count > 0 && !force) return { asset_id, queued: false, reason: 'already transcribed' }
    files = files.map((x) => (x.asset_id === asset_id ? { ...x, startedAt: Date.now(), snippet_status: 'queued' } : x))
    return { asset_id, queued: true, reason: 'queue' }
  })
  return { queued: results.filter((r) => r.queued).length, results }
}

function setFileTrackSpeaker(mediaFileId: string, trackIndex: number, speakerId: string) {
  const f = files.find((x) => x.media_file_id === mediaFileId)
  const who = speakers.find((s) => s.id === speakerId)
  if (!f || !who) throw new ApiError(404, 'Not found')
  if (!f.tracks.some((t) => t.track_index === trackIndex)) {
    throw new ApiError(422, `This file's audio tracks are [${f.tracks.map((t) => t.track_index).join(', ')}]; there is no track ${trackIndex}.`)
  }
  let row: SnippetTrack | undefined
  files = files.map((x) =>
    x !== f
      ? x
      : {
          ...x,
          tracks: x.tracks.map((t) =>
            t.track_index === trackIndex ? (row = { ...t, speaker_id: who.id, speaker_name: who.name }) : t,
          ),
        },
  )
  // A clip's speaker is its track's: every clip and moment on this track
  // now carries the new name, as the API's re-labelling does.
  const onTrack = (c: SnippetClip) => c.media_file_id === mediaFileId && trackIndexOf(c) === trackIndex
  clips = clips.map((c) => (onTrack(c) ? { ...c, speaker: who } : c))
  MOMENTS.forEach((c, k) => {
    if (onTrack(c)) MOMENTS[k] = { ...c, speaker: who }
  })
  const hasTranscript = f.segment_count > 0
  return {
    ...row!,
    segments_relabelled: hasTranscript ? 12 : 0,
    detect_summary: f.startedAt != null
      ? { ran: false, created: 0, removed: 0, reason: 'A transcription is running; it will detect clips with this speaker when it finishes.' }
      : hasTranscript
        ? { ran: true, created: 3, removed: 2, reason: null }
        : { ran: false, created: 0, removed: 0, reason: 'No transcript yet; clips are detected when the file is processed.' },
  }
}

// ─── Transcripts: words laid out evenly over each clip's span ────────────────

/** Which track a clip is spoken on: decided once, from the track that had its
 *  speaker when the fixtures were built, so renaming the speaker keeps it. */
const clipTracks = new Map<string, number>()
function trackIndexOf(c: SnippetClip): number {
  let t = clipTracks.get(c.id)
  if (t == null) {
    const f = files.find((x) => x.media_file_id === c.media_file_id)
    t = f?.tracks.find((tr) => tr.speaker_id != null && tr.speaker_id === c.speaker?.id)?.track_index ?? 0
    clipTracks.set(c.id, t)
  }
  return t
}

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
    track_index: trackIndexOf(c),
    speaker_name: c.speaker?.name ?? null,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    text,
    status: 'auto',
    words,
  }
}

function transcript(mediaFileId: string, from: number, to: number): SnippetTranscript {
  const segs = [...clips, ...MOMENTS]
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
  if (!statuses.length && q && !sources.length) pool = [...pool, ...MOMENTS]
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
    const { asset_ids, force } = body as { asset_ids: string[]; force?: boolean }
    return processFiles(asset_ids, !!force) as T
  }
  if ((m = p.match(/^\/projects\/([^/]+)\/snippet\/files$/))) return listFiles(qs) as T
  if ((m = p.match(/^\/media-files\/([^/]+)\/snippet\/tracks\/(\d+)\/speaker$/)) && method === 'PUT') {
    return setFileTrackSpeaker(m[1], Number(m[2]), (body as { speaker_id: string }).speaker_id) as T
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
    // The same tracks the Files tab shows, so naming a speaker from a clip
    // and from the Files tab change one list.
    const f = files.find((x) => x.media_file_id === m![1])
    if (!f) throw new ApiError(404, 'Not found')
    return f.tracks as T
  }
  if ((m = p.match(/^\/snippets\/([^/]+)$/)) && method === 'PATCH') {
    const i = clips.findIndex((c) => c.id === m![1])
    if (i < 0) throw new ApiError(404, 'Not found')
    const patch = body as Partial<SnippetClip>
    const prev = clips[i]
    const next = { ...prev, ...patch }
    // As the API: only a change to the title, topics or in/out marks a clip edited.
    const changed =
      ('title' in patch && (patch.title || null) !== prev.title) ||
      ('topics' in patch && JSON.stringify(patch.topics) !== JSON.stringify(prev.topics)) ||
      ('start_ms' in patch && patch.start_ms !== prev.start_ms) ||
      ('end_ms' in patch && patch.end_ms !== prev.end_ms)
    if (changed) next.user_edited = true
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
