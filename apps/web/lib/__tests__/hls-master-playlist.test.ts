/**
 * Reading the rendition list out of a master playlist (§185).
 *
 * §117 put Safari on native HLS deliberately (our segments are MPEG-TS,
 * which Safari's MSE refuses), and the stated cost was that hls.js — the
 * thing that supplied the level list — was no longer in the picture, so
 * Safari got no quality control at all. It turns out the level list never
 * needed hls.js: it is in the master playlist, which is plain text.
 *
 * The playlists here are the real shape ffmpeg's HLS muxer emits for this
 * project (`%v` subdirectories, `job.qualities = ["1080p","720p","360p"]`),
 * including the `?token=` the media proxy rewrites into every `.m3u8` line.
 */
import { describe, it, expect } from 'vitest'

import { parseHlsMasterPlaylist, resolveRenditionUrl } from '../hls-master-playlist'

const MASTER_URL = '/api/stream/hls/master.m3u8?token=TOK123'

/** What the proxy actually serves: relative URIs, each already token-stamped
 *  by hls_proxy.py's `_rewrite_manifest`. */
const REWRITTEN = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
0/playlist.m3u8?token=TOK123
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
1/playlist.m3u8?token=TOK123
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
2/playlist.m3u8?token=TOK123
`

/** The same manifest unrewritten — bare relative URIs, no token. */
const BARE = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
0/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
1/playlist.m3u8
`

describe('parsing the rendition list', () => {
  it('finds every rendition, in manifest order', () => {
    const levels = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(levels.map((l) => l.label)).toEqual(['1080p', '720p', '360p'])
  })

  it('indexes them the way hls.js does, so one dropdown fits both paths', () => {
    /* `setQuality(1)` has to mean the same rendition whichever engine is
       playing, or the control means different things in different browsers. */
    const levels = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(levels.map((l) => l.index)).toEqual([0, 1, 2])
  })

  it('reads height and bitrate off the attributes', () => {
    const [first] = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(first.height).toBe(1080)
    expect(first.bitrate).toBe(5000000)
  })

  it('is not confused by the commas inside CODECS', () => {
    /* `CODECS="avc1.640028,mp4a.40.2"` contains a comma. Splitting the
       attribute list on every comma turns one attribute into two broken
       ones and loses whatever followed. */
    const [first] = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(first.height).toBe(1080)
    expect(first.bitrate).toBe(5000000)
  })

  it('falls back to a bitrate label when a rendition declares no resolution', () => {
    const levels = parseHlsMasterPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=850000\naudio/playlist.m3u8\n',
      MASTER_URL,
    )

    expect(levels[0].label).toBe('850kbps')
  })

  it('returns nothing for a single-rendition playlist', () => {
    /* Which is what makes the dropdown not render — correct, since there
       would be nothing to choose between. */
    const levels = parseHlsMasterPlaylist(
      '#EXTM3U\n#EXTINF:6.0,\nseg_000.ts\n#EXT-X-ENDLIST\n',
      MASTER_URL,
    )

    expect(levels).toEqual([])
  })

  it('returns nothing for junk rather than throwing', () => {
    expect(parseHlsMasterPlaylist('', MASTER_URL)).toEqual([])
    expect(parseHlsMasterPlaylist('not a playlist at all', MASTER_URL)).toEqual([])
  })

  it('skips a STREAM-INF with no URI after it', () => {
    const levels = parseHlsMasterPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=100x50\n',
      MASTER_URL,
    )

    expect(levels).toEqual([])
  })

  it('tolerates a comment between the tag and its URI', () => {
    const levels = parseHlsMasterPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n# a comment\n1/playlist.m3u8\n',
      MASTER_URL,
    )

    expect(levels).toHaveLength(1)
    expect(levels[0].url).toBe('/api/stream/hls/1/playlist.m3u8?token=TOK123')
  })

  it('handles CRLF line endings', () => {
    const levels = parseHlsMasterPlaylist(REWRITTEN.replace(/\n/g, '\r\n'), MASTER_URL)

    expect(levels.map((l) => l.label)).toEqual(['1080p', '720p', '360p'])
  })
})

describe('resolving a rendition URL', () => {
  it('resolves relative to the master, not to the page', () => {
    const levels = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(levels.map((l) => l.url)).toEqual([
      '/api/stream/hls/0/playlist.m3u8?token=TOK123',
      '/api/stream/hls/1/playlist.m3u8?token=TOK123',
      '/api/stream/hls/2/playlist.m3u8?token=TOK123',
    ])
  })

  it('stays RELATIVE, because that is what the API hands back', () => {
    /* `proxy_url_for` returns a relative path. Turning it absolute against
       some invented origin would point the player at a host that does not
       exist — the §141/§32 mistake, one layer down. */
    const [first] = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(first.url?.startsWith('/')).toBe(true)
    expect(first.url).not.toMatch(/^https?:/)
  })

  it('carries the master token onto a URI that has none', () => {
    /* The proxy normally stamps each line itself, but a manifest served
       unrewritten would otherwise produce un-authorized rendition URLs. */
    const levels = parseHlsMasterPlaylist(BARE, MASTER_URL)

    expect(levels[0].url).toBe('/api/stream/hls/0/playlist.m3u8?token=TOK123')
  })

  it('does not double-stamp a URI that already carries one', () => {
    /* `?token=a&token=b` is what blind appending produces, and the proxy
       reads only the first. */
    const [first] = parseHlsMasterPlaylist(REWRITTEN, MASTER_URL)

    expect(first.url?.match(/token=/g)).toHaveLength(1)
  })

  it('leaves a URI with its OWN different token alone', () => {
    const url = resolveRenditionUrl('0/playlist.m3u8?token=OTHER', MASTER_URL)

    expect(url).toBe('/api/stream/hls/0/playlist.m3u8?token=OTHER')
  })

  it('handles an absolute master URL too', () => {
    const url = resolveRenditionUrl(
      '0/playlist.m3u8',
      'https://frame.yon.studio/api/stream/hls/master.m3u8?token=T',
    )

    expect(url).toBe('https://frame.yon.studio/api/stream/hls/0/playlist.m3u8?token=T')
  })

  it('handles a root-relative rendition URI', () => {
    const url = resolveRenditionUrl('/other/place/playlist.m3u8', MASTER_URL)

    expect(url).toBe('/other/place/playlist.m3u8?token=TOK123')
  })
})
