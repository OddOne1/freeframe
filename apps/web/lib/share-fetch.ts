/**
 * `fetch` for the public share endpoints (`/share/{token}/...`).
 *
 * A `secure` share link answers only a signed-in account, on EVERY share
 * endpoint (API: `permissions.enforce_share_link_visibility`) — not just on
 * `GET /share/{token}`, which was the only one that checked before. So on a
 * secure link these requests must carry the same bearer token the rest of the
 * app sends.
 *
 * Only on a secure link. A public link keeps sending exactly what it always
 * did — nothing — because a signed-in caller changes more than access there:
 * the API files a comment under the account instead of the guest name typed
 * into the prompt, and logs the account in the link's activity. That is a
 * product decision of its own, not part of making secure links work.
 *
 * The share page marks a link secure once `GET /share/{token}` has answered
 * (`setShareLinkVisibility`), before it renders anything that calls these
 * endpoints. An anonymous visitor on a secure link never gets that far: that
 * same response says `requires_auth`, and the page shows its sign-in prompt.
 */
import { getAccessToken } from './auth'

const secureTokens = new Set<string>()

/** Record what `GET /share/{token}` said about this link's visibility. */
export function setShareLinkVisibility(token: string, visibility: string | null | undefined): void {
  if (visibility === 'secure') secureTokens.add(token)
  else secureTokens.delete(token)
}

function accessToken(): string | null {
  try {
    return getAccessToken()
  } catch {
    // Storage disabled (private mode): behave as signed out.
    return null
  }
}

/** `fetch(url, init)`, plus `Authorization: Bearer …` when `token` is a
 *  secure link and this browser holds a session. */
export function shareFetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const bearer = secureTokens.has(token) ? accessToken() : null
  // Unchanged call shape when nothing is added: `fetch(url)` stays `fetch(url)`.
  if (!bearer) return init ? fetch(url, init) : fetch(url)
  const headers = new Headers(init?.headers)
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${bearer}`)
  return fetch(url, { ...init, headers })
}
