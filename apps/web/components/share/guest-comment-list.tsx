'use client'

/**
 * The comment list shown in an asset share link's right panel.
 *
 * Lifted out of app/share/[token]/page.tsx so it can be rendered in a test:
 * a Next.js page file may only export the page itself, so anything living
 * there is unreachable from a test that wants to render it. The crash this
 * file exists to prevent was in the render, not in a pure helper, so being
 * able to render it is the point.
 */

import * as React from 'react'
import { Loader2, MessageSquare } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface GuestComment {
  id: string
  body: string
  /** Absent on a comment left by a signed-in user — see commentAuthorName. */
  guest_name?: string
  guest_email?: string
  author_name?: string
  author?: { id: string; name: string; avatar_url?: string | null } | null
  guest_author?: { id: string; name: string; email: string } | null
  created_at: string
  timecode_start?: number | null
}

/**
 * A comment's display name, whoever left it.
 *
 * The API populates a different field depending on who commented: `author`
 * for a signed-in user, `guest_author` for a named share-link visitor,
 * `guest_name` for an anonymous one — and `guest_name` is `Optional[str]`
 * server-side (schemas/comment.py). Reading any one of them directly is a
 * crash waiting for the first comment of another kind, which is exactly what
 * `comment.guest_name.charAt(0)` was: one comment from a signed-in user took
 * the whole share page down to Next's generic error screen.
 *
 * Same chain as folder-share-viewer.tsx, which already got this right — which
 * is why folder and project share links never hit the crash.
 */
export function commentAuthorName(comment: GuestComment): string {
  return (
    comment.author?.name ||
    comment.guest_author?.name ||
    comment.guest_name ||
    comment.author_name ||
    'User'
  )
}

export interface GuestCommentListProps {
  token: string
  refreshKey: number
}

export function GuestCommentList({ token, refreshKey }: GuestCommentListProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    setLoading(true)
    fetch(`${API_URL}/share/${token}/comments`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: GuestComment[]) => setComments(Array.isArray(data) ? data : []))
      .catch(() => setComments([]))
      .finally(() => setLoading(false))
  }, [token, refreshKey])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <MessageSquare className="h-6 w-6 text-zinc-600" />
        </div>
        <p className="text-sm font-medium text-zinc-300">No comments — yet</p>
        <p className="text-xs text-zinc-500 mt-1">
          Be the first to leave feedback on this asset.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
      {comments.map((comment) => {
        const name = commentAuthorName(comment)
        return (
          <div
            key={comment.id}
            className="rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-2xs font-medium text-purple-400">
                {name.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-medium text-zinc-200">{name}</span>
              {comment.timecode_start != null && (
                <span className="text-2xs text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
                  {Math.floor(comment.timecode_start / 60)}:
                  {String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
                </span>
              )}
              <span className="ml-auto text-2xs text-zinc-600">
                {new Date(comment.created_at).toLocaleDateString()}
              </span>
            </div>
            <p className="text-sm text-zinc-300 leading-relaxed">{comment.body}</p>
          </div>
        )
      })}
    </div>
  )
}
