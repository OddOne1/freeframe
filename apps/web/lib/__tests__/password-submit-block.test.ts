/**
 * Why a password submit button is blocked — the shared rule (§202).
 *
 * The bug class this replaces: four forms each carried
 * `disabled={!strength?.meetsPolicy || !confirmPassword}`, which is false
 * whenever the async score has not arrived — including forever, if loading the
 * dictionary fails. A dead control and a silent screen.
 *
 * Two invariants carry the fix, and both are asserted below rather than
 * described in a comment somewhere:
 *
 *   1. **Blocking always produces a sentence.** Every branch that returns
 *      "blocked" returns text for the screen to render.
 *   2. **An unknown score never blocks.** null means "not scored yet" or
 *      "could not score", never "bad". The server runs the real policy —
 *      including the blocklist and the personal-token rule, which the browser
 *      cannot check at all — so an unscored password costs a round trip, while
 *      blocking it costs the user their account.
 */
import { describe, it, expect } from 'vitest'
import { passwordSubmitBlock, DEFAULT_PASSWORD_POLICY } from '@/lib/password-policy'
import type { PasswordStrength } from '@/types'

const policy = DEFAULT_PASSWORD_POLICY
const GOOD = 'Xq7#vLm2$kPzR4w'

function strength(overrides: Partial<PasswordStrength> = {}): PasswordStrength {
  return {
    score: 4,
    label: 'strong',
    reason: '',
    meetsPolicy: true,
    missing: [],
    ...overrides,
  }
}

const block = (args: Partial<Parameters<typeof passwordSubmitBlock>[0]>) =>
  passwordSubmitBlock({
    password: GOOD,
    confirmPassword: GOOD,
    strength: strength(),
    policy,
    ...args,
  })

describe('an unknown score never blocks', () => {
  it('lets a good password through while the score is still pending', () => {
    // The §202 bug, as a single assertion. This returned "blocked" before, and
    // nothing said why.
    expect(block({ strength: null })).toBeNull()
  })

  it('lets it through even if scoring failed permanently', () => {
    // Identical state from this function's point of view, and deliberately so:
    // "the dictionary did not load" is not a fact about the password.
    expect(block({ strength: null })).toBeNull()
  })

  it('still blocks a password the browser can judge WITHOUT a score', () => {
    // The length and class rules are synchronous and need no dictionary, so
    // they remain safe to block on even when scoring is unavailable.
    expect(block({ password: 'short', confirmPassword: 'short', strength: null }))
      .toMatch(/at least 12 characters/)
    expect(
      block({ password: 'alllowercase1234', confirmPassword: 'alllowercase1234', strength: null }),
    ).toMatch(/upper-case/)
  })
})

describe('every block has a sentence', () => {
  it.each([
    ['empty', { password: '', confirmPassword: '' }],
    ['too short', { password: 'Ab3$xKm9!Qw', confirmPassword: 'Ab3$xKm9!Qw' }],
    ['missing a class', { password: 'abcdefghijkl', confirmPassword: 'abcdefghijkl' }],
    ['no confirmation', { confirmPassword: '' }],
    ['mismatched', { confirmPassword: 'something-else' }],
    ['weak score', { strength: strength({ score: 1, reason: 'This is similar to a commonly used password' }) }],
  ])('%s', (_label, args) => {
    const reason = block(args)
    expect(reason).toBeTruthy()
    expect(typeof reason).toBe('string')
    // Not a code, not an empty string, not "invalid" — something a person can
    // act on. The whole point is that the screen has something to render.
    expect((reason as string).length).toBeGreaterThan(8)
  })
})

describe('the individual rules', () => {
  it('asks for a password first', () => {
    expect(block({ password: '', confirmPassword: '' })).toMatch(/Enter a password/)
  })

  it('names every missing character class at once', () => {
    const reason = block({ password: 'abcdefghijkl', confirmPassword: 'abcdefghijkl' })
    expect(reason).toMatch(/upper-case/)
    expect(reason).toMatch(/digit/)
    expect(reason).toMatch(/special character/)
  })

  it('asks for the confirmation before complaining it differs', () => {
    // An empty second field is not a mismatch, it is an unfinished form, and
    // saying "Passwords do not match" at the first keystroke is nagging.
    expect(block({ confirmPassword: '' })).toMatch(/Confirm your password/)
  })

  it('reports a mismatch once the second field has something in it', () => {
    expect(block({ confirmPassword: 'different' })).toBe('Passwords do not match.')
  })

  it('quotes zxcvbn’s own finding for a weak score', () => {
    const reason = block({
      strength: strength({ score: 1, reason: 'This is similar to a commonly used password' }),
    })
    expect(reason).toMatch(/too easy to guess/)
    expect(reason).toMatch(/similar to a commonly used password/)
  })

  it('still explains a weak score that came with no finding', () => {
    const reason = block({ strength: strength({ score: 0, reason: '' }) })
    expect(reason).toBe('This password is too easy to guess.')
  })

  it('returns null when everything is satisfied', () => {
    expect(block({})).toBeNull()
  })

  it('reads the threshold from the policy it is given', () => {
    // The instance's own numbers, fetched from /auth/password-policy — not a
    // constant baked in here.
    const lenient = { ...policy, min_strength_score: 1 }
    expect(block({ strength: strength({ score: 2 }), policy: lenient })).toBeNull()
    expect(block({ strength: strength({ score: 2 }) })).toMatch(/too easy/)
  })

  it('reads the minimum length from the policy it is given', () => {
    const lenient = { ...policy, min_length: 8 }
    const eight = 'Ab3$xKm9'
    expect(block({ password: eight, confirmPassword: eight, policy: lenient })).toBeNull()
    expect(block({ password: eight, confirmPassword: eight })).toMatch(/at least 12/)
  })
})
