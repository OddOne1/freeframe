/**
 * Remembering a guest's name, per share link, on their own device (§209 C).
 *
 * Real localStorage in jsdom rather than a mock, because the properties worth
 * asserting here are about the store itself: that one link's entry is not
 * another's, that it goes stale, and that a browser which refuses to store
 * anything is survivable rather than fatal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  GUEST_IDENTITY_TTL_MS,
  clearGuestIdentity,
  guestIdentityKey,
  readGuestIdentity,
  writeGuestIdentity,
} from '../guest-identity'

const ADA = { name: 'Ada', email: 'ada@example.com' }

beforeEach(() => {
  window.localStorage.clear()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('per-link scoping', () => {
  it('remembers an identity for the link it was entered on', () => {
    writeGuestIdentity('tok-a', ADA)
    expect(readGuestIdentity('tok-a')).toEqual(ADA)
  })

  it('does NOT leak that identity onto a different link', () => {
    // The pre-§209 bug, in one assertion: one unscoped key meant the name
    // entered for one client's review followed the reviewer everywhere.
    writeGuestIdentity('tok-a', ADA)
    expect(readGuestIdentity('tok-b')).toBeNull()
  })

  it('keys by the token, so two links coexist', () => {
    writeGuestIdentity('tok-a', ADA)
    writeGuestIdentity('tok-b', { name: 'Grace', email: 'grace@example.com' })
    expect(readGuestIdentity('tok-a')?.name).toBe('Ada')
    expect(readGuestIdentity('tok-b')?.name).toBe('Grace')
    expect(window.localStorage.getItem(guestIdentityKey('tok-a'))).toBeTruthy()
  })

  it('clearing one link leaves the other alone', () => {
    writeGuestIdentity('tok-a', ADA)
    writeGuestIdentity('tok-b', { name: 'Grace', email: 'grace@example.com' })
    clearGuestIdentity('tok-a')
    expect(readGuestIdentity('tok-a')).toBeNull()
    expect(readGuestIdentity('tok-b')?.name).toBe('Grace')
  })
})

describe('expiry', () => {
  it('forgets an entry older than the TTL, and removes it', () => {
    writeGuestIdentity('tok-a', ADA)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + GUEST_IDENTITY_TTL_MS + 1000)

    expect(readGuestIdentity('tok-a')).toBeNull()
    // Dropped, not just ignored — otherwise it would be re-examined forever.
    expect(window.localStorage.getItem(guestIdentityKey('tok-a'))).toBeNull()
  })

  it('counts the TTL from LAST USE, not from first save', () => {
    writeGuestIdentity('tok-a', ADA)
    vi.useFakeTimers()

    // Used again on day 20 — which should reset the clock.
    vi.setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000)
    expect(readGuestIdentity('tok-a')).toEqual(ADA)

    // Day 40 overall, but only 20 days since that use.
    vi.setSystemTime(Date.now() + 20 * 24 * 60 * 60 * 1000)
    expect(readGuestIdentity('tok-a')).toEqual(ADA)
  })

  it("forgets it once the LINK has expired, even well inside the TTL", () => {
    writeGuestIdentity('tok-a', ADA)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    expect(readGuestIdentity('tok-a', yesterday)).toBeNull()
  })

  it('keeps it while the link is still alive', () => {
    writeGuestIdentity('tok-a', ADA)
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    expect(readGuestIdentity('tok-a', nextYear)).toEqual(ADA)
  })

  it('ignores an unparseable link expiry rather than discarding a good entry', () => {
    writeGuestIdentity('tok-a', ADA)
    expect(readGuestIdentity('tok-a', 'not-a-date')).toEqual(ADA)
  })

  it('treats a null link expiry as "never expires"', () => {
    writeGuestIdentity('tok-a', ADA)
    expect(readGuestIdentity('tok-a', null)).toEqual(ADA)
  })
})

describe('when the browser will not cooperate', () => {
  it('reads as "nobody remembered" when getItem throws', () => {
    // Stored FIRST, so that `null` can only be the spy's doing. Without this
    // the assertion passes against an empty store and proves nothing — and
    // the spy has to be on Storage.prototype, not on `window.localStorage`:
    // jsdom's Storage ignores an own property placed on the instance, so
    // `vi.spyOn(window.localStorage, 'getItem')` is never called at all.
    writeGuestIdentity('tok-a', ADA)
    expect(readGuestIdentity('tok-a')).toEqual(ADA)

    const spy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError: storage disabled')
      })
    expect(() => readGuestIdentity('tok-a')).not.toThrow()
    expect(readGuestIdentity('tok-a')).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('does not throw when setItem throws, and stores nothing', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    expect(() => writeGuestIdentity('tok-a', ADA)).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    // The point of surviving the throw is that nothing was half-written.
    expect(readGuestIdentity('tok-a')).toBeNull()
  })

  it('does not throw when removeItem throws', () => {
    writeGuestIdentity('tok-a', ADA)
    const spy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })
    expect(() => clearGuestIdentity('tok-a')).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('discards a corrupt entry instead of handing back half an identity', () => {
    window.localStorage.setItem(guestIdentityKey('tok-a'), '{"name":"Ada"}')
    expect(readGuestIdentity('tok-a')).toBeNull()
  })

  it('discards unparseable JSON', () => {
    window.localStorage.setItem(guestIdentityKey('tok-a'), 'not json {')
    expect(readGuestIdentity('tok-a')).toBeNull()
  })

  it('refuses to store a blank name or email', () => {
    writeGuestIdentity('tok-a', { name: '  ', email: 'ada@example.com' })
    expect(readGuestIdentity('tok-a')).toBeNull()
  })

  it('trims what it stores', () => {
    writeGuestIdentity('tok-a', { name: '  Ada  ', email: ' ada@example.com ' })
    expect(readGuestIdentity('tok-a')).toEqual(ADA)
  })
})
