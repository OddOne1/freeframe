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
  /**
   * §234 F2 — the author, as much of them as a share viewer may ever see:
   * their initials, or their first name on a password-protected link. The
   * server also sends the chip colour, so the browser never derives either
   * from a name or an id (it no longer receives one).
   */
  author_label?: string
  author_color?: string
  created_at: string
  timecode_start?: number | null
  /** Only present on a link that shows internal comments (§234 F1). */
  visibility?: string | null
}

/**
 * A comment's display name, whoever left it.
 *
 * §234 F2 — one field now, not four. The API used to populate a different
 * one depending on who commented (`author` for a signed-in user,
 * `guest_author` for a named visitor, `guest_name` for an anonymous one),
 * which is both the crash this function was written for — one comment from
 * a signed-in user took the whole share page down on
 * `comment.guest_name.charAt(0)` — and a full name or an e-mail address
 * handed to whoever held the link. The share routes send `author_label`
 * instead, and nothing else about the person.
 *
 * The fallback stays: a response from an older API, or one this page could
 * not parse, must render as a chip rather than as a crash.
 */
export function commentAuthorName(comment: GuestComment): string {
  return comment.author_label || 'User'
}

/** The chip colour the server assigned, or the page's own default. */
export function commentAuthorColor(comment: GuestComment): string {
  return comment.author_color || '#8b5cf6'
}

/**
 * What goes INSIDE the chip, given the label beside it.
 *
 * A label is one of two things and the chip has to read correctly for both:
 * on a link with no password it is already the initials ("MS"), so the chip
 * shows it whole; on a password-protected link it is a first name
 * ("Mathias"), so the chip shows the one letter an avatar normally would.
 * Taking the "first two letters" of a first name gives "MA", which looks
 * like a typo.
 */
export function chipText(label: string): string {
  return label.length <= 2 ? label.toUpperCase() : label.charAt(0).toUpperCase()
}

export interface GuestCommentListProps {
  token: string
  refreshKey: number
  /**
   * §234 B/D — the password session, sent exactly as the other share calls
   * send it. Without it a password-protected link's comments are refused,
   * because this listing is now behind the same gate as the media.
   */
  shareSession?: string | null
}

export function GuestCommentList({ token, refreshKey, shareSession }: GuestCommentListProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    setLoading(true)
    const sp = shareSession ? `?share_session=${encodeURIComponent(shareSession)}` : ''
    fetch(`${API_URL}/share/${token}/comments${sp}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: GuestComment[]) => setComments(Array.isArray(data) ? data : []))
      .catch(() => setComments([]))
      .finally(() => setLoading(false))
  }, [token, refreshKey, shareSession])

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
              {/* §234 F3 — the label and the colour the server assigned, as
                  an avatar-style chip. See `chipText`. */}
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-white"
                style={{ backgroundColor: commentAuthorColor(comment) }}
              >
                {chipText(name)}
              </div>
              {/* Not repeated when the chip already IS the label — "MS MS"
                  is what showing both gives on a link with no password. */}
              {chipText(name) !== name && (
                <span className="text-xs font-medium text-zinc-200">{name}</span>
              )}
              {comment.visibility === 'internal' && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-2xs font-medium text-amber-400">
                  Internal
                </span>
              )}
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
