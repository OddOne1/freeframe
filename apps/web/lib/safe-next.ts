/**
 * §233b — the one place that decides whether a redirect target taken from a
 * URL is allowed to be followed.
 *
 * `middleware.ts` puts the path you were refused into `?from=` and
 * `app/(auth)/login/page.tsx` sends you there once you have a token. Nothing
 * checked what was in it, so `/login?from=https://evil.com` was a working
 * open redirect on a page people are told to expect a sign-in on — the one
 * page where "the address bar still says our domain" is the whole of what a
 * person has to go on. Phishing is the obvious use; the quieter one is that
 * the login page sets `ff_access_token` as a cookie just before it
 * redirects, so the target gets a freshly-signed-in referrer.
 *
 * The rule is a WHITELIST: a same-origin absolute path, and nothing else. It
 * is not a blacklist of bad schemes, because that is the version of this
 * function that gets bypassed next year by a scheme nobody listed.
 */

/** Where the login page lands when it has no usable target of its own. */
export const DEFAULT_LANDING_PATH = '/projects'

/**
 * How many times a value is percent-decoded before it is judged.
 *
 * One pass stops `%2F%2Fevil.com`. Two stop `%252F%252Fevil.com`, which is
 * what you get when something in the chain decodes once on its own — and
 * `middleware.ts` → `searchParams.set` → `URLSearchParams.get` is exactly
 * such a chain. Three is one more than any of that needs; the loop also
 * stops early as soon as decoding changes nothing.
 */
const MAX_DECODE_PASSES = 3

/** `http:`, `javascript:`, `data:` — a scheme at the very start of a value. */
const LEADING_SCHEME = /^[a-z][a-z0-9+.\-]*:/i

/**
 * Every form of a value a browser might end up looking at: the value itself,
 * then each percent-decoding of it.
 *
 * A malformed escape ENDS the walk rather than failing it, and the
 * difference matters in both directions. `/projects?q=50%25` is a perfectly
 * good path whose first decoding is `/projects?q=50%` and whose second
 * throws — §233 is the change that made a bare `%` something a search box
 * legitimately produces, so rejecting it here would break a real target. And
 * nothing is let through by stopping: an attack has to decode CLEANLY into
 * `//host` or a scheme to be worth anything to a browser, and every layer
 * produced before the throw is still checked below.
 */
function decodeLayers(value: string): string[] {
  const layers = [value]
  let current = value
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      break
    }
    if (next === current) break
    layers.push(next)
    current = next
  }
  return layers
}

/** True only for a value that is safe to hand to `router.replace` as-is. */
function isSameOriginPath(value: string): boolean {
  if (value.length === 0) return false

  return decodeLayers(value).every((layer) => {
    // A single leading slash. `//evil.com` is a protocol-relative URL and
    // `/\evil.com` is one too, because every browser normalises a backslash
    // in the authority position to a forward slash.
    if (!layer.startsWith('/')) return false
    if (layer.startsWith('//')) return false
    // Not just at position 1: a backslash has no legitimate place in a URL
    // path, and allowing it anywhere means reasoning about where a given
    // browser normalises it.
    if (layer.includes('\\')) return false
    // Unreachable while the leading-slash rule holds, and stated anyway so
    // that the rule this function enforces can be read off its own body.
    if (LEADING_SCHEME.test(layer)) return false
    // Control characters: C0, then DEL and C1. A browser STRIPS tab, LF and
    // CR while resolving a URL, so `/\njavascript:alert(1)` is a different
    // string to it than it is to a startsWith('/') check.
    //
    // A space is deliberately NOT in here. `/projects/my%20project` is a
    // real target whose decoding contains one, and a space cannot build an
    // authority or a scheme: the constructs that can are `//`, `\` and a
    // leading scheme, each checked above. Leading whitespace — which a
    // browser does strip, making ` //evil.com` protocol-relative — is
    // already refused by the leading-slash rule, in every decoded layer.
    for (const char of layer) {
      const code = char.codePointAt(0) ?? 0
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
    }
    return true
  })
}

/**
 * The redirect target to actually use.
 *
 * Returns `next` unchanged when it is a same-origin path, and `fallback`
 * (the caller's own landing path) for everything else — an absent value, an
 * absolute URL, a scheme, a protocol-relative `//host`, a backslash, a
 * control character, or any percent-encoding of those.
 *
 * Never throws and never returns an empty string, so a caller can use the
 * result directly: `router.replace(safeNext(params.get('from')))`.
 */
export function safeNext(
  next: string | null | undefined,
  fallback: string = DEFAULT_LANDING_PATH,
): string {
  if (typeof next !== 'string') return fallback
  return isSameOriginPath(next) ? next : fallback
}
