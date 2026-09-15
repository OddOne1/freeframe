import type { QualityLevel } from '@/hooks/use-video-player'

/**
 * Read the rendition list out of an HLS master playlist (§185).
 *
 * Safari plays HLS natively (§117 chose that deliberately — our segments are
 * MPEG-TS, which Safari's MSE refuses, so hls.js had to transmux and produced
 * `HLS error: mediaError`). The cost was that hls.js is also what supplied
 * the level list, so Safari — the browser most of this project's real viewing
 * happens in — got no quality control at all.
 *
 * It does not need hls.js for that. The master playlist is plain text listing
 * each rendition's own playlist, and Safari will play one of those directly
 * just as happily as it plays the master; pointing `video.src` at one is a
 * manual rendition choice, with the native engine still doing the decoding.
 * So this parses the same list hls.js would have reported, from the same file
 * the browser already fetched.
 *
 * Pure and separate from the hook on purpose: jsdom implements no media
 * pipeline, so the integration genuinely cannot be tested here — but the
 * parsing can be, completely.
 */

/** Any absolute base, for resolving relative URIs. Never requested. */
const RELATIVE_BASE = 'https://hls-master.invalid'

/**
 * Resolve one rendition URI against the master's URL, carrying the token.
 *
 * Two things this has to get right:
 *
 *  - The API hands back RELATIVE proxy paths (`/stream/hls/...`), so the
 *    result has to stay relative — returning an absolute URL against a made-up
 *    origin would point the player at a host that does not exist.
 *  - The proxy REWRITES manifests on the way out (hls_proxy.py
 *    `_rewrite_manifest`), appending `?token=` to every `.m3u8` line. So a
 *    rendition URI usually arrives already authorized, and blindly appending
 *    the master's token would produce `?token=a&token=b`. The master's token
 *    is copied only when the URI carries none — which covers a manifest
 *    served unrewritten.
 */
export function resolveRenditionUrl(uri: string, masterUrl: string): string {
  const baseIsRelative = !/^[a-z][a-z0-9+.-]*:\/\//i.test(masterUrl)
  const base = new URL(masterUrl, RELATIVE_BASE)
  const resolved = new URL(uri, base)

  if (!resolved.searchParams.has('token')) {
    const token = base.searchParams.get('token')
    if (token) resolved.searchParams.set('token', token)
  }

  return baseIsRelative && resolved.origin === RELATIVE_BASE
    ? `${resolved.pathname}${resolved.search}`
    : resolved.toString()
}

/** `BANDWIDTH=123,RESOLUTION=1920x1080,CODECS="a,b"` -> a map.
 *
 *  Quote-aware: CODECS legitimately contains commas, and splitting on every
 *  comma would turn one attribute into several malformed ones. */
function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  let key = ''
  let value = ''
  let inQuotes = false
  let readingKey = true

  const commit = () => {
    if (key.trim()) attrs[key.trim().toUpperCase()] = value.trim().replace(/^"|"$/g, '')
    key = ''
    value = ''
    readingKey = true
  }

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes
      value += ch
    } else if (ch === '=' && readingKey && !inQuotes) {
      readingKey = false
    } else if (ch === ',' && !inQuotes) {
      commit()
    } else if (readingKey) {
      key += ch
    } else {
      value += ch
    }
  }
  commit()
  return attrs
}

/**
 * Every `#EXT-X-STREAM-INF` rendition, in manifest order.
 *
 * The index is the position in that order, matching what hls.js reports for
 * `data.levels` — so both playback paths hand the same dropdown the same
 * shape, and `setQuality(1)` means the same rendition in either.
 *
 * Returns [] for anything that is not a master playlist: a single-rendition
 * playlist has no STREAM-INF lines, and an empty list is exactly what makes
 * the dropdown not render — which is correct, since there would be nothing
 * to choose between.
 */
export function parseHlsMasterPlaylist(text: string, masterUrl: string): QualityLevel[] {
  const lines = text.split(/\r?\n/)
  const levels: QualityLevel[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF:')) continue

    const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))

    // The URI is the next line that is neither blank nor a tag. Usually the
    // very next one, but the spec permits comments in between.
    let uri: string | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim()
      if (!candidate || candidate.startsWith('#')) continue
      uri = candidate
      i = j
      break
    }
    if (!uri) continue

    const height = Number(attrs.RESOLUTION?.split('x')[1] ?? 0) || 0
    const bitrate = Number(attrs.BANDWIDTH ?? attrs['AVERAGE-BANDWIDTH'] ?? 0) || 0

    levels.push({
      index: levels.length,
      height,
      bitrate,
      // Same rule as the hls.js branch, so a rendition is labelled
      // identically whichever path loaded it.
      label: height ? `${height}p` : `${Math.round(bitrate / 1000)}kbps`,
      url: resolveRenditionUrl(uri, masterUrl),
    })
  }

  return levels
}
