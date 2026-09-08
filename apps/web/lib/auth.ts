const ACCESS_TOKEN_KEY = 'ff_access_token'
const REFRESH_TOKEN_KEY = 'ff_refresh_token'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

export function setTokens(access: string, refresh: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(ACCESS_TOKEN_KEY, access)
  localStorage.setItem(REFRESH_TOKEN_KEY, refresh)
  // Set cookies so middleware can check auth on server side
  document.cookie = `${ACCESS_TOKEN_KEY}=${access}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
  document.cookie = `${REFRESH_TOKEN_KEY}=${refresh}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(REFRESH_TOKEN_KEY)
  // Clear auth cookies
  document.cookie = `${ACCESS_TOKEN_KEY}=; path=/; max-age=0`
  document.cookie = `${REFRESH_TOKEN_KEY}=; path=/; max-age=0`
  window.location.href = '/login'
}

// Deduplicate concurrent refresh calls — when access token expires, multiple
// API calls may simultaneously get 401 and try to refresh. Only one should run.
let _refreshPromise: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise

  _refreshPromise = _doRefresh()
  try {
    return await _refreshPromise
  } finally {
    _refreshPromise = null
  }
}

/** How long to wait before re-trying a refresh that failed for reasons that
 *  say nothing about the token. Short and bounded: every request that got a
 *  401 is awaiting this single call, so a long retry stalls the whole burst.
 */
const REFRESH_RETRY_DELAYS_MS = [300, 900]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * §129 — only a REJECTION clears the session.
 *
 * This used to `clearTokens()` in a bare `catch`, which cannot tell "the
 * refresh token was rejected" from "I could not reach the server". Confirmed
 * live against production: making the refresh endpoint unreachable at the
 * network level — not a 4xx, genuinely unreachable — wiped a valid
 * access+refresh pair with seven days left on it and redirected to /login.
 *
 * That is the worst possible reading of an ambiguous signal. A backgrounded
 * tab that Safari has throttled, a dropped wifi connection, a redeploy that
 * takes the API down for two seconds: each one logged the user out and threw
 * away credentials that were still perfectly valid.
 *
 * So the rule is now explicit about what it knows:
 *
 *   401/403 from the refresh endpoint   the server has rejected this refresh
 *                                       token. It is dead; clear it.
 *   network error, 5xx, anything else   nothing was learned about the token.
 *                                       Keep it, retry a couple of times,
 *                                       then give up for now. The caller
 *                                       surfaces a failed request; the next
 *                                       one tries again and succeeds once
 *                                       the network is back.
 */
async function _doRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) {
    // Genuinely nothing to refresh with — this IS a logged-out state.
    clearTokens()
    return null
  }

  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
    } catch {
      // Could not reach the server at all. Says nothing about the token.
      if (attempt < REFRESH_RETRY_DELAYS_MS.length) {
        await sleep(REFRESH_RETRY_DELAYS_MS[attempt])
        continue
      }
      return null
    }

    if (response.status === 401 || response.status === 403) {
      // The only answer that actually means the token is no good.
      clearTokens()
      return null
    }

    if (!response.ok) {
      // 5xx, 429, a proxy error page: the server's problem, not the token's.
      if (attempt < REFRESH_RETRY_DELAYS_MS.length) {
        await sleep(REFRESH_RETRY_DELAYS_MS[attempt])
        continue
      }
      return null
    }

    try {
      const data = await response.json()
      const newAccessToken: string = data.access_token
      const newRefreshToken: string = data.refresh_token ?? refreshToken
      setTokens(newAccessToken, newRefreshToken)
      return newAccessToken
    } catch {
      // A 200 whose body will not parse is a broken server, not a broken
      // token — same treatment, and no retry, since it will not differ.
      return null
    }
  }
}
