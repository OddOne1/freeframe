/**
 * The live password meter (§200).
 *
 * **Advisory only. `apps/api/services/password_policy.py` decides.** This
 * module exists so somebody typing a password finds out it is weak while they
 * are typing it, instead of after a round-trip — not so the browser can hold
 * an opinion the server does not share. Every rule here has a twin on the
 * server, the server's twin runs on every path that sets a password, and a
 * password this file happens to like is still refused if the server's does
 * not.
 *
 * The two ARE different implementations — Python `zxcvbn` 4.4 there,
 * `@zxcvbn-ts/core` 3.x here — so the score can differ by a point at the
 * boundary. That is tolerable precisely because of the sentence above. What
 * would not be tolerable is this file inventing a scorer of its own: a
 * hand-rolled "has a digit, has a symbol, therefore strong" meter is how
 * `Sommer2026!` gets a green bar.
 *
 * The four class rules are duplicated here rather than fetched, because they
 * have to run on every keystroke. The NUMBERS are not duplicated —
 * `GET /auth/password-policy` serves the minimum length and score, and
 * `usePasswordPolicy` below reads them from there so the screen and the
 * server cannot disagree about what is required.
 */

import * as React from 'react'
import useSWR from 'swr'
import { api } from '@/lib/api'
import type { PasswordPolicy, PasswordStrength } from '@/types'

/**
 * The fallback used until `GET /auth/password-policy` answers, and if it
 * never does.
 *
 * It matches the server's constants as of §200. Stating it as a fallback
 * rather than as the source of truth is the point: if the two ever drift, the
 * screen is briefly wrong about the minimum length, which costs one rejected
 * submission — whereas treating this as authoritative would let the screen be
 * permanently wrong and confident.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  min_length: 12,
  min_strength_score: 3,
  requires_upper: true,
  requires_lower: true,
  requires_digit: true,
  requires_special: true,
}

/**
 * Read a dynamically imported module's real exports, whichever shape the
 * bundler hands back (§202).
 *
 * This function exists because of a bug that reached production and was
 * invisible to the whole test suite. The original code read
 * `common.default.dictionary`, and `@zxcvbn-ts/language-*` has **no default
 * export at all** — its ESM build ends in `export { adjacencyGraphs,
 * dictionary }`. In a true ESM namespace `.default` is therefore `undefined`,
 * and `.default.dictionary` throws a TypeError.
 *
 * It passed every test anyway. Vitest resolves these packages' CJS build and
 * synthesises `default = module.exports`, which happens to carry `.dictionary`
 * — so `common.default.dictionary` works in jsdom and only ever fails in the
 * browser, where Next resolves the `module` field and gets the real namespace.
 * A test environment that is kinder than production is worse than no test.
 *
 * So this picks by CONTENT rather than by shape: whichever of the namespace or
 * its `.default` actually carries the keys being asked for. That is stable
 * across both interops, and across the package growing a default export later.
 */
export function resolveModuleExports<T>(ns: unknown, ...expectedKeys: string[]): T {
  const candidates = [ns, (ns as { default?: unknown })?.default]
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      expectedKeys.every((key) => key in (candidate as object))
    ) {
      return candidate as T
    }
  }
  // Nothing carried them. Throwing names the module shape in the message
  // instead of letting a TypeError surface three frames away as
  // "cannot read properties of undefined".
  throw new Error(
    `zxcvbn module is missing ${expectedKeys.join(', ')}; got keys: ` +
      `${ns && typeof ns === 'object' ? Object.keys(ns).join(', ') : typeof ns}`,
  )
}

interface ZxcvbnLanguage {
  dictionary: Record<string, (string | number)[]>
  adjacencyGraphs?: Record<string, unknown>
  translations?: unknown
}

/**
 * zxcvbn's dictionaries, loaded once and only when a password field is
 * actually rendered.
 *
 * `@zxcvbn-ts/language-common` is ~800KB of frequency lists. Importing it at
 * module scope would put that in the bundle of every page that transitively
 * reaches this file — including the dashboard, which never asks for a
 * password. A dynamic import inside a memoised promise keeps it on the two
 * screens that need it and loads it exactly once per session.
 */
let optionsPromise: Promise<void> | null = null

/**
 * Turn the two imported language modules into the options object zxcvbn wants.
 *
 * Exported and pure ONLY so it can be tested, and that is not a small point:
 * the §202 bug lived in exactly these four lines, in code that could not be
 * reached from a test because it sat inside a dynamic import. A test can now
 * hand this the real ESM namespace — the one with no default export, the one
 * the browser gets — and assert it produces a populated dictionary. Reverting
 * to `commonNs.default.dictionary` fails that test instead of shipping.
 */
export function buildZxcvbnOptions(commonNs: unknown, enNs: unknown) {
  const common = resolveModuleExports<ZxcvbnLanguage>(
    commonNs,
    'dictionary',
    'adjacencyGraphs',
  )
  const en = resolveModuleExports<ZxcvbnLanguage>(enNs, 'dictionary', 'translations')
  return {
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs as never,
    translations: en.translations as never,
  }
}

async function ensureZxcvbnOptions(): Promise<
  typeof import('@zxcvbn-ts/core')
> {
  const core = await import('@zxcvbn-ts/core')
  if (!optionsPromise) {
    optionsPromise = (async () => {
      const [commonNs, enNs] = await Promise.all([
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
      ])
      core.zxcvbnOptions.setOptions(buildZxcvbnOptions(commonNs, enNs))
    })()
    // §202 — a REJECTED promise must not be cached.
    //
    // Left as-is, one failure (a dropped chunk on a flaky connection, a
    // transient 502 from the CDN) poisons the meter for the rest of the
    // session: every later call awaits the same rejected promise and returns
    // instantly without retrying. That is how a momentary network blip
    // becomes a permanently dead password form.
    optionsPromise.catch(() => {
      optionsPromise = null
    })
  }
  await optionsPromise
  return core
}

/**
 * The same short locale list `services/password_policy.py` feeds to its own
 * zxcvbn, kept in step by hand.
 *
 * zxcvbn's dictionaries are English, so `Summer2026!` scores 2 and
 * `Sommer2026!` scores 3 — one point apart purely because of which language
 * the user thinks in. Without this the meter would be a full point more
 * optimistic than the server for exactly the passwords the people on this
 * instance actually choose, which is the one direction a meter must never be
 * wrong in.
 *
 * Duplicated rather than fetched because it runs on every keystroke and the
 * list is short and stable. If the server's list grows, grow this one: a
 * drift here shows up as a meter that reads "medium" on something the server
 * refuses, which is annoying rather than dangerous — but it is still wrong.
 */
const LOCALE_WORDS = [
  'sommer', 'winter', 'herbst', 'fruehling', 'frühling',
  'jaenner', 'jänner', 'januar', 'februar', 'maerz', 'märz', 'april',
  'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november',
  'dezember',
  'passwort', 'kennwort', 'geheim', 'willkommen', 'servus', 'schatz',
  'liebe', 'sonne', 'hallo', 'danke',
  'wien', 'oesterreich', 'österreich', 'austria',
  'freeframe',
]

/** Which of the four character classes are still missing. */
export function missingClasses(
  password: string,
  policy: PasswordPolicy,
): string[] {
  const missing: string[] = []
  if (policy.requires_upper && !/[A-Z]/.test(password)) missing.push('an upper-case letter')
  if (policy.requires_lower && !/[a-z]/.test(password)) missing.push('a lower-case letter')
  if (policy.requires_digit && !/[0-9]/.test(password)) missing.push('a digit')
  // The complement of alphanumeric MINUS whitespace, matching the server's
  // own definition exactly. Both halves matter: not a fixed punctuation set,
  // because that would show a red mark for a password the server accepts; and
  // not counting spaces, because `[^A-Za-z0-9]` alone treats the spaces in a
  // passphrase as special characters — which would let this meter say a
  // spaced passphrase is fine right up until the server refuses it.
  if (policy.requires_special && !/[^A-Za-z0-9\s]/.test(password)) {
    missing.push('a special character')
  }
  return missing
}

export const STRENGTH_LABELS = ['weak', 'weak', 'weak', 'medium', 'strong'] as const

/**
 * Score a password, the same way and against the same inputs the server does.
 *
 * `userInputs` is not optional in spirit: the server rejects a password
 * containing the person's own address or name outright, and zxcvbn scores
 * those far lower when it is told about them. Calling this without them
 * produces a meter that is more optimistic than the server, which is the one
 * direction a meter must never be wrong in.
 */
export async function scorePassword(
  password: string,
  userInputs: string[],
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): Promise<PasswordStrength> {
  if (!password) {
    return { score: 0, label: 'weak', reason: '', meetsPolicy: false, missing: [] }
  }

  const missing = missingClasses(password, policy)
  const tooShort = password.length < policy.min_length

  const core = await ensureZxcvbnOptions()
  // Capped at 128 like the server, and for the same reason: zxcvbn's cost
  // grows fast with length, and this runs on every keystroke.
  const result = core.zxcvbn(password.slice(0, 128), [
    ...LOCALE_WORDS,
    ...userInputs,
  ])
  const score = result.score as number

  // zxcvbn's own finding, which is the part that makes a weak score
  // actionable — "This is similar to a commonly used password" tells the
  // person what to change; a bar that is 40% full does not.
  const reason =
    result.feedback.warning?.replace(/\.$/, '') ??
    result.feedback.suggestions[0]?.replace(/\.$/, '') ??
    ''

  return {
    score,
    label: STRENGTH_LABELS[Math.min(Math.max(score, 0), 4)],
    reason,
    // Everything the browser can check. Deliberately NOT called "valid": the
    // blocklist and the personal-token rule only exist server-side, so a
    // password that passes here can still be refused, and a name suggesting
    // otherwise would invite a caller to skip handling that.
    meetsPolicy:
      !tooShort && missing.length === 0 && score >= policy.min_strength_score,
    missing,
  }
}

/**
 * Report a scoring failure once per session, loudly enough to be found.
 *
 * Once, because this runs on a debounce behind every keystroke and a
 * per-attempt log would bury the first and only useful one under a hundred
 * copies. Loudly, because the alternative is what §202 was: a `catch` that
 * returned null, a submit button that never enabled, and no evidence at all
 * in the console, the network tab or the server logs.
 */
let strengthFailureReported = false

function reportStrengthFailure(err: unknown): void {
  if (strengthFailureReported) return
  strengthFailureReported = true
  // eslint-disable-next-line no-console
  console.error(
    '[password-policy] strength scoring is unavailable; the meter will stay ' +
      'blank and the server will enforce the policy on submit.',
    err,
  )
}

/**
 * Why the submit button cannot be pressed yet — or `null` when it can (§202).
 *
 * ONE rule, shared by the four forms that set a password (invite acceptance,
 * the §200 onboarding gate, the login screen's set-password step, and
 * Settings → Profile). They had four copies of
 * `disabled={!strength?.meetsPolicy || !confirm}`, which is how all four
 * inherited the same silent failure at once.
 *
 * Two principles, and they are the actual fix rather than the interop patch:
 *
 * **A blocked submit always has a sentence.** The caller renders the returned
 * string next to the button. There is no state in which the control is dead
 * and the screen says nothing — that is the bug class §202 is about, not the
 * particular TypeError that caused it this time.
 *
 * **An unknown score never blocks.** `strength` is null while the debounce is
 * pending, while the 800KB dictionary is still downloading, and forever if
 * that download fails. None of those are statements about the password. The
 * server runs the real policy on every path that sets one — including the
 * blocklist and the personal-token rule, which the browser cannot check at
 * all — so letting an unscored password through costs a round trip and a
 * rendered error, while blocking it costs the user their account.
 *
 * What DOES block is only what the browser can be certain of: the two fields
 * disagreeing, and the length and character-class rules, which are computed
 * synchronously and need no dictionary at all.
 */
export function passwordSubmitBlock(args: {
  password: string
  confirmPassword: string
  strength: PasswordStrength | null
  policy: PasswordPolicy
}): string | null {
  const { password, confirmPassword, strength, policy } = args

  if (!password) return 'Enter a password.'

  // Synchronous, dictionary-free, and therefore always available — this is
  // the part that can safely block.
  if (password.length < policy.min_length) {
    return `Use at least ${policy.min_length} characters.`
  }
  const missing = missingClasses(password, policy)
  if (missing.length > 0) {
    return `Add ${missing.join(', ')}.`
  }

  if (!confirmPassword) return 'Confirm your password.'
  if (password !== confirmPassword) return 'Passwords do not match.'

  // Null means "not scored yet", never "bad". See the note above.
  if (strength && strength.score < policy.min_strength_score) {
    return strength.reason
      ? `This password is too easy to guess. ${strength.reason}.`
      : 'This password is too easy to guess.'
  }

  return null
}

/** The instance's rules, fetched once. Falls back to the constants above. */
export function usePasswordPolicy(): PasswordPolicy {
  const { data } = useSWR<PasswordPolicy>(
    '/auth/password-policy',
    () => api.get<PasswordPolicy>('/auth/password-policy'),
    {
      // The rules do not change between renders, and a screen that refetched
      // them on every focus would be spending requests to be told the same
      // thing.
      revalidateOnFocus: false,
      revalidateIfStale: false,
    },
  )
  return data ?? DEFAULT_PASSWORD_POLICY
}

/**
 * Debounced scoring for a controlled input.
 *
 * Debounced because `scorePassword` awaits a dynamic import on its first call
 * and then runs a real analysis; doing that synchronously per keystroke makes
 * a password field feel heavy. 150ms is below the threshold where the meter
 * reads as lagging, and above the one where it re-runs for every character of
 * a fast typist.
 */
export function usePasswordStrength(
  password: string,
  userInputs: string[],
  policy: PasswordPolicy,
): PasswordStrength | null {
  const [strength, setStrength] = React.useState<PasswordStrength | null>(null)
  // Joined into a primitive so the effect does not re-run because the caller
  // built a fresh array with the same contents — which is what an inline
  // `[user.email, user.name]` does on every render.
  const inputsKey = userInputs.join('\u0000')

  React.useEffect(() => {
    if (!password) {
      setStrength(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      scorePassword(password, inputsKey ? inputsKey.split('\u0000') : [], policy)
        .then((next) => {
          // Guards against an out-of-order resolve overwriting a newer score
          // — the dynamic import makes the first call much slower than the
          // rest, so this is a real ordering, not a theoretical one.
          if (!cancelled) setStrength(next)
        })
        .catch((err) => {
          // A failed dictionary load must not break the form: the meter
          // simply does not appear, and `passwordSubmitBlock` treats a null
          // score as "unknown", which does NOT block submission — the server
          // enforces the real policy either way.
          //
          // §202 — but it is no longer SILENT. This catch is what hid a
          // TypeError for an entire deploy: every password form in the app
          // had a permanently disabled submit button and nothing, anywhere,
          // said why. One console line is the difference between "the button
          // is broken" and a stack trace pointing at the cause.
          reportStrengthFailure(err)
          if (!cancelled) setStrength(null)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [password, inputsKey, policy])

  return strength
}
