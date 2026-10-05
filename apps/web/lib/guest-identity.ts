/**
 * A guest's self-declared name and email, remembered on their own device for
 * one share link (§209 part C).
 *
 * Why localStorage and not a cookie: the POST to /share/{token}/comment
 * already carries `guest_name`/`guest_email` in its body, so the server needs
 * nothing kept for it. A cookie would travel on every request to the API for
 * no reason, and would be a server-visible identifier where none is required.
 *
 * Why keyed per share token: a reviewer may hold links to two different
 * clients' projects, and "the name I comment under here" is a property of the
 * link, not of the browser. The pre-§209 implementation used ONE unscoped key
 * (`ff_guest_identity`), so the name entered on one link silently followed the
 * person onto every other link they opened — and never expired.
 *
 * Nothing here throws. Private mode, disabled site data and a cleared profile
 * all read as "nobody remembered", which is the correct answer: the page then
 * asks for a name, exactly as it does on a first visit.
 *
 * What is NOT here, deliberately: any claim that the address is real. A guest
 * email is self-declared, today and after §209 — there is no verification
 * step and the UI must not imply one.
 */

export interface GuestIdentity {
  name: string
  email: string
}

interface StoredGuestIdentity extends GuestIdentity {
  /** ms epoch of the last time this entry was written OR successfully read.
   *  "Last use", not "first saved": a guest who comments every week should
   *  not be asked again on day 31. */
  savedAt: number
}

/** 30 days from last use. Long enough that a review cycle does not re-ask,
 *  short enough that a shared or borrowed machine forgets. */
export const GUEST_IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function guestIdentityKey(shareToken: string): string {
  return `ff_guest:${shareToken}`
}

function isIdentity(value: unknown): value is StoredGuestIdentity {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.email === 'string' &&
    v.email.trim().length > 0
  )
}

/**
 * The remembered identity for this link, or null.
 *
 * `linkExpiresAt` is the share link's own expiry (ISO string, or null for a
 * link that never expires). An entry is dropped when it is older than the TTL
 * **or** when the link itself has expired — whichever comes first — because a
 * name remembered for a dead link is only a stale prompt waiting to happen.
 *
 * A live read refreshes `savedAt`, which is what makes the TTL "from last
 * use". The refresh is best-effort: if the write fails the identity is still
 * returned, since being unable to extend the clock is not a reason to ask the
 * guest to type their name again right now.
 */
export function readGuestIdentity(
  shareToken: string,
  linkExpiresAt?: string | null,
): GuestIdentity | null {
  if (!shareToken) return null
  try {
    const raw = window.localStorage.getItem(guestIdentityKey(shareToken))
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    if (!isIdentity(parsed)) {
      clearGuestIdentity(shareToken)
      return null
    }

    const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
    const now = Date.now()

    if (now - savedAt >= GUEST_IDENTITY_TTL_MS) {
      clearGuestIdentity(shareToken)
      return null
    }

    if (linkExpiresAt) {
      const expiry = Date.parse(linkExpiresAt)
      // An unparseable date is ignored rather than treated as expired: the
      // TTL above still bounds the entry, and throwing away a good identity
      // over a malformed field would be the worse failure.
      if (!Number.isNaN(expiry) && now >= expiry) {
        clearGuestIdentity(shareToken)
        return null
      }
    }

    const identity = { name: parsed.name, email: parsed.email }
    try {
      window.localStorage.setItem(
        guestIdentityKey(shareToken),
        JSON.stringify({ ...identity, savedAt: now }),
      )
    } catch {
      // Best-effort, see above.
    }
    return identity
  } catch {
    return null
  }
}

/** Remember this identity for this link. Silently does nothing if storage is
 *  unavailable — the comment the guest is posting still goes through, they
 *  will just be asked again next time. */
export function writeGuestIdentity(
  shareToken: string,
  identity: GuestIdentity,
): void {
  if (!shareToken) return
  const name = identity.name.trim()
  const email = identity.email.trim()
  if (!name || !email) return
  try {
    window.localStorage.setItem(
      guestIdentityKey(shareToken),
      JSON.stringify({ name, email, savedAt: Date.now() }),
    )
  } catch {
    // Private mode, or site data blocked.
  }
}

/** Forget this link's identity — what "Not you?" calls. */
export function clearGuestIdentity(shareToken: string): void {
  if (!shareToken) return
  try {
    window.localStorage.removeItem(guestIdentityKey(shareToken))
  } catch {
    // Nothing to do; the caller re-prompts either way.
  }
}
