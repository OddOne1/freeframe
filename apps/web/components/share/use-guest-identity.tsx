'use client'

import * as React from 'react'
import {
  clearGuestIdentity,
  readGuestIdentity,
  writeGuestIdentity,
  type GuestIdentity,
} from '@/lib/guest-identity'

/**
 * The one gate every guest-authored post goes through (§209 part B).
 *
 * ONE implementation, deliberately, because the bug this closes was a missing
 * second copy: posting a new comment on a share link asked for a name and
 * email, and replying did not — the reply path had simply never been wired to
 * anything. Writing a second identity check for replies is how the two drift,
 * and this codebase has paid that bill repeatedly (§190's four byte
 * formatters, §193's two login branches, §209's own two no-op `onSubmitReply`
 * stubs).
 *
 * So the contract is: a caller does not post directly. It hands the post to
 * `submitAsGuest`, which either runs it now (signed in, or identity already
 * remembered) or holds it, prompts, and runs it once the guest has typed a
 * name. New comments and replies both call this, with different work.
 *
 * `isAuthenticated` short-circuits everything: a signed-in user's identity
 * comes from their token and they are never prompted.
 */
export function useGuestIdentity({
  shareToken,
  linkExpiresAt,
  isAuthenticated,
}: {
  shareToken: string
  linkExpiresAt?: string | null
  isAuthenticated: boolean
}) {
  const [identity, setIdentity] = React.useState<GuestIdentity | null>(null)
  const [prompting, setPrompting] = React.useState(false)
  /** The post that is waiting for a name. Held in a ref rather than state
   *  because resolving it must not depend on a re-render landing first. */
  const pending = React.useRef<(() => Promise<void>) | null>(null)

  // Read once per link, on mount. Deliberately an effect rather than a lazy
  // useState initialiser: this runs during SSR too, where there is no
  // `window`, and a throwing initialiser would take the whole page down
  // instead of just failing to remember a name.
  React.useEffect(() => {
    if (isAuthenticated) {
      setIdentity(null)
      return
    }
    setIdentity(readGuestIdentity(shareToken, linkExpiresAt))
  }, [shareToken, linkExpiresAt, isAuthenticated])

  /**
   * Run `work` if we may, otherwise prompt and run it afterwards.
   *
   * Returns true when the work ran (or started), false when it was deferred —
   * so a caller can tell "sent" from "waiting for a name" and leave the
   * composer's text alone in the second case. Clearing a draft the guest has
   * not managed to post yet would lose it.
   */
  const submitAsGuest = React.useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      if (isAuthenticated) {
        await work()
        return true
      }
      const known = identity ?? readGuestIdentity(shareToken, linkExpiresAt)
      if (known) {
        // Keep local state in step when the read came from storage (another
        // tab may have saved it since this hook mounted).
        if (!identity) setIdentity(known)
        await work()
        return true
      }
      pending.current = work
      setPrompting(true)
      return false
    },
    [identity, isAuthenticated, linkExpiresAt, shareToken],
  )

  /** The prompt's Save. Stores, closes, and runs whatever was waiting. */
  const saveIdentity = React.useCallback(
    async (next: GuestIdentity) => {
      const trimmed = { name: next.name.trim(), email: next.email.trim() }
      writeGuestIdentity(shareToken, trimmed)
      setIdentity(trimmed)
      setPrompting(false)
      const work = pending.current
      pending.current = null
      // Awaited rather than fired through a setTimeout: the caller's own
      // error handling has to be able to see this fail, which is what §209
      // part A item 2 is about. The pre-§209 share viewer used
      // `setTimeout(..., 50)`, so a failed auto-submit could not be reported
      // anywhere.
      if (work) await work()
    },
    [shareToken],
  )

  /** The prompt's Cancel. The held post is dropped, not retried. */
  const cancelPrompt = React.useCallback(() => {
    pending.current = null
    setPrompting(false)
  }, [])

  /** "Not you?" — forget this link's identity and ask again. */
  const forgetIdentity = React.useCallback(() => {
    clearGuestIdentity(shareToken)
    setIdentity(null)
    pending.current = null
    setPrompting(false)
  }, [shareToken])

  return {
    /** Non-null only for a guest with a remembered, unexpired identity. */
    identity: isAuthenticated ? null : identity,
    prompting,
    submitAsGuest,
    saveIdentity,
    cancelPrompt,
    forgetIdentity,
  }
}
