/**
 * A single-asset share link gets the real player (§184).
 *
 * Folder shares have used the app's own VideoPlayer for ages. Single-asset
 * shares never adopted it: they rendered a bare `<video controls>`, so the
 * same asset looked like a branded player or like raw browser chrome
 * depending only on how it happened to be shared — no quality selector, no
 * LUT-aware frame, nothing.
 *
 * The prop list is most of what is asserted here, because each entry is a
 * decision: `initialStreamUrl` is what lets the player skip an
 * authenticated fetch it cannot make as a guest, and the ABSENCE of
 * `lutPicker`, `comments` and `overlay` is what keeps a guest out of
 * review-flow features this page does not have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const videoProps: Record<string, unknown>[] = []
const providerProps: Record<string, unknown>[] = []

vi.mock('@/components/review/video-player', () => ({
  VideoPlayer: (props: Record<string, unknown>) => {
    videoProps.push(props)
    return <div data-testid="real-video-player" />
  },
}))

vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children, ...rest }: { children: React.ReactNode }) => {
    providerProps.push(rest)
    return <div data-testid="review-provider">{children}</div>
  },
}))

import { SharePlayer } from '../share-player'

const STREAM = '/api/stream/hls/master.m3u8?token=t'

beforeEach(() => {
  videoProps.length = 0
  providerProps.length = 0
})

async function renderPlayer() {
  const r = render(<SharePlayer assetId="a-1" streamUrl={STREAM} token="tok" />)
  await screen.findByTestId('real-video-player')
  return r
}

describe('the player itself', () => {
  it('renders the app VideoPlayer, not a bare <video>', async () => {
    await renderPlayer()

    expect(screen.getByTestId('real-video-player')).toBeTruthy()
    // The regression, stated directly: native browser chrome is what the
    // guest was getting, and a raw <video controls> is what produced it.
    expect(document.querySelector('video[controls]')).toBeNull()
  })

  it('shows a spinner until the chunk arrives rather than an empty frame', () => {
    render(<SharePlayer assetId="a-1" streamUrl={STREAM} token="tok" />)

    expect(document.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.queryByTestId('real-video-player')).toBeNull()
  })

  it('hands the player the pre-fetched stream URL', async () => {
    /* A guest cannot make the authenticated call VideoPlayer would
       otherwise make for itself; `initialStreamUrl` is the prop that
       exists for exactly that. */
    await renderPlayer()

    expect(videoProps[0].initialStreamUrl).toBe(STREAM)
    expect(videoProps[0].assetId).toBe('a-1')
  })
})

describe('what a guest must NOT be given', () => {
  it('passes no lutPicker — no colour controls on a share link', async () => {
    await renderPlayer()

    expect(videoProps[0].lutPicker).toBeUndefined()
  })

  it('passes no comments or overlay — this page has its own panel', async () => {
    /* GuestCommentList already handles comments here; the player's own
       marker overlay is a review-flow feature. */
    await renderPlayer()

    expect(videoProps[0].comments).toBeUndefined()
    expect(videoProps[0].overlay).toBeUndefined()
  })
})

describe('the provider', () => {
  it('is present, because VideoPlayer throws without one', async () => {
    /* video-player.tsx calls useReview(), which raises "useReview must be
       used inside <ReviewProvider>". This is not optional plumbing — drop
       it and the share page crashes on open. */
    await renderPlayer()

    expect(screen.getByTestId('review-provider')).toBeTruthy()
  })

  it('is given the share token, so it uses the guest API', async () => {
    await renderPlayer()

    expect(providerProps[0].shareToken).toBe('tok')
    expect(providerProps[0].assetId).toBe('a-1')
  })

  it('wraps the player rather than replacing the page layout', async () => {
    /* The folder path's ShareReviewScreen brings a whole top bar and
       sidebar; this page has its own. Only the provider — which renders
       no markup of its own — comes across. */
    await renderPlayer()

    const provider = screen.getByTestId('review-provider')
    expect(provider.contains(screen.getByTestId('real-video-player'))).toBe(true)
  })
})

describe('the page actually uses it', () => {
  /* The tests above all pass against a page that still renders a bare
     <video> and never mounts SharePlayer at all — the component would be
     correct and unreachable. Checked at the source, in the same spirit as
     folder-url-sync.test.tsx: what is being asserted is wiring, and there
     is no behaviour to drive without mounting the whole share route. */
  const RAW = readFileSync(
    join(process.cwd(), 'app/share/[token]/page.tsx'),
    'utf8',
  )
  /** Comments stripped before matching. The §184 comment explaining what
   *  replaced the bare `<video>` NAMES it, so a check over the raw text
   *  matches the prose describing the fix rather than the code — which is
   *  how a passing assertion ends up proving nothing. */
  const PAGE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('renders SharePlayer in the video branch', () => {
    expect(PAGE).toMatch(/<SharePlayer\s/)
    expect(RAW).toContain("import { SharePlayer } from '@/components/share/share-player'")
  })

  it('has no bare <video> left for a guest to fall back to', () => {
    /* The bug was native browser chrome. `<audio controls>` below it is
       untouched and legitimate — this asserts only that the VIDEO branch
       no longer hand-rolls its own element. */
    expect(PAGE).not.toMatch(/<video\b/)
  })

  it('gives it the stream URL the page already fetched', () => {
    const at = PAGE.indexOf('<SharePlayer')
    expect(PAGE.slice(at, at + 200)).toMatch(/streamUrl=\{streamUrl\}/)
  })
})
