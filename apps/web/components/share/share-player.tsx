'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'

/**
 * The real review player, loaded on demand (§184).
 *
 * Single-asset share links rendered a bare `<video controls>` — native
 * browser chrome, no quality selector, nothing branded — while folder
 * shares had been using the app's own player for ages. Same asset, two
 * completely different players depending on how it happened to be shared.
 *
 * Dynamic, for the same two reasons folder-share-viewer.tsx does it: keep
 * the review bundle out of every share page load, and keep hls.js away
 * from SSR.
 *
 * ── Why ReviewProvider is here despite the brief saying to avoid it ──
 * `VideoPlayer` calls `useReview()` (video-player.tsx:198), which THROWS
 * outside a provider — so dropping it in bare crashes the page instantly.
 * The concern behind that instruction was a layout collision, and it does
 * not apply: `ReviewProvider` renders `<Context.Provider>{children}</...>`
 * and nothing else. What was rightly avoided is `ShareReviewScreen`, the
 * folder path's full-screen chrome, which would genuinely fight this
 * page's own top bar and sidebar. That is untouched.
 *
 * With `initialStreamUrl` set the player short-circuits its own stream
 * fetch (video-player.tsx:258) and never reads the provider's version or
 * loading state, so the provider is needed only so `useReview()` resolves
 * — plus the poster it supplies, which fixes §118's black-first-frame gap
 * on this page for free.
 */
export function SharePlayer({
  assetId,
  streamUrl,
  token,
}: {
  assetId: string
  streamUrl: string
  token: string
}) {
  const [mods, setMods] = React.useState<{
    ReviewProvider: React.ComponentType<Record<string, unknown>>
    VideoPlayer: React.ComponentType<Record<string, unknown>>
  } | null>(null)

  React.useEffect(() => {
    let live = true
    Promise.all([
      import('@/components/review/review-provider'),
      import('@/components/review/video-player'),
    ])
      .then(([provider, video]) => {
        if (!live) return
        setMods({
          ReviewProvider: provider.ReviewProvider as never,
          VideoPlayer: video.VideoPlayer as never,
        })
      })
      .catch(() => {
        // Left null: the caller renders its spinner rather than a broken
        // frame. A share link that cannot load its player is worth a
        // visible wait, not a silent blank box.
      })
    return () => {
      live = false
    }
  }, [])

  if (!mods) {
    return <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
  }

  const { ReviewProvider, VideoPlayer } = mods
  return (
    <ReviewProvider assetId={assetId} shareToken={token}>
      {/* Deliberately NOT passed:
          - `lutPicker`: guests get no colour controls, matching what the
            folder-share path already does by omitting it.
          - `comments` / `overlay`: this page has its own GuestCommentList,
            and the player's marker overlay is a review-flow feature. */}
      <VideoPlayer assetId={assetId} initialStreamUrl={streamUrl} className="flex-1" />
    </ReviewProvider>
  )
}
