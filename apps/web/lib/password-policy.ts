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

async function ensureZxcvbnOptions(): Promise<
  typeof import('@zxcvbn-ts/core')
> {
  const core = await import('@zxcvbn-ts/core')
  if (!optionsPromise) {
    optionsPromise = (async () => {
      const [common, en] = await Promise.all([
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
      ])
      core.zxcvbnOptions.setOptions({
        dictionary: {
          ...common.default.dictionary,
          ...en.default.dictionary,
        },
        graphs: common.default.adjacencyGraphs,
        translations: en.default.translations,
      })
    })()
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
        .catch(() => {
          // A failed dictionary load must not break the form. The meter
          // simply does not appear; the server still enforces everything.
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
