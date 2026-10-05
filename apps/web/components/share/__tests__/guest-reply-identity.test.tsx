/**
 * One identity gate for comments AND replies, remembered per link (§209 B/C).
 *
 * Driven through a small host component that uses the real `useGuestIdentity`
 * hook, the real prompt and the real badge, with real localStorage — because
 * every property here is about what the hook and the store actually do
 * together. Mocking either would leave the thing under test unexercised.
 *
 * The behaviours, in the prompt's own numbering:
 *   e. first visit prompts; after saving, the next comment AND the next reply
 *      on the same link do not;
 *   f. a different token prompts again; "Not you?" re-prompts and removes the
 *      key;
 *   g. an expired entry re-prompts;
 *   h. localStorage throwing leaves the page working, prompting each time;
 *   j. a signed-in user is never prompted.
 *
 * (i) — the server refusing an unidentified guest reply — is asserted against
 * the real endpoint in apps/api/tests/test_comment_replies.py, where it
 * belongs: a client-side assertion about a server rule proves nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as React from 'react'

import {
  GUEST_IDENTITY_TTL_MS,
  guestIdentityKey,
  readGuestIdentity,
} from '@/lib/guest-identity'
import {
  GuestIdentityBadge,
  GuestIdentityPrompt,
} from '../guest-identity-prompt'
import { useGuestIdentity } from '../use-guest-identity'

const posted: string[] = []

/** The smallest stand-in for the share viewer's composer area: a new-comment
 *  button and a reply button, both going through the one gate. */
function Host({
  shareToken = 'tok-a',
  linkExpiresAt = null,
  isAuthenticated = false,
}: {
  shareToken?: string
  linkExpiresAt?: string | null
  isAuthenticated?: boolean
}) {
  const {
    identity,
    prompting,
    submitAsGuest,
    saveIdentity,
    cancelPrompt,
    forgetIdentity,
  } = useGuestIdentity({ shareToken, linkExpiresAt, isAuthenticated })

  return (
    <div>
      {identity && (
        <GuestIdentityBadge identity={identity} onForget={forgetIdentity} />
      )}
      <button
        onClick={() =>
          submitAsGuest(async () => {
            posted.push('comment')
          })
        }
      >
        Post comment
      </button>
      <button
        onClick={() =>
          submitAsGuest(async () => {
            posted.push('reply')
          })
        }
      >
        Post reply
      </button>
      {prompting && (
        <GuestIdentityPrompt onSave={saveIdentity} onCancel={cancelPrompt} />
      )}
    </div>
  )
}

async function fillPrompt(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/your name/i), 'Ada')
  await user.type(screen.getByLabelText(/email address/i), 'ada@example.com')
  await user.click(screen.getByRole('button', { name: /continue/i }))
}

beforeEach(() => {
  posted.length = 0
  window.localStorage.clear()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── e ──────────────────────────────────────────────────────────────────────

describe('the first post on a link asks who you are', () => {
  it('prompts instead of posting, then posts once the name is given', async () => {
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
    expect(posted).toEqual([])

    await fillPrompt(user)

    // The held post runs — the guest does not have to click again.
    await waitFor(() => expect(posted).toEqual(['comment']))
  })

  it('asks on a REPLY too, which it never used to', async () => {
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: /post reply/i }))

    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
    expect(posted).toEqual([])

    await fillPrompt(user)
    await waitFor(() => expect(posted).toEqual(['reply']))
  })

  it('does not ask again for either a comment or a reply on the same link', async () => {
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)
    await waitFor(() => expect(posted).toEqual(['comment']))

    await user.click(screen.getByRole('button', { name: /post reply/i }))
    await waitFor(() => expect(posted).toEqual(['comment', 'reply']))
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await waitFor(() =>
      expect(posted).toEqual(['comment', 'reply', 'comment']),
    )
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
  })

  it('says, once, where the name is kept', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(
      await screen.findByText(
        /we remember your name and email on this device for this link/i,
      ),
    ).toBeInTheDocument()
  })

  it('shows who you are commenting as, once remembered', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)

    expect(await screen.findByText(/commenting as/i)).toHaveTextContent('Ada')
  })

  it('cancelling drops the held post rather than sending it later', async () => {
    const user = userEvent.setup()
    render(<Host />)

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))

    expect(posted).toEqual([])
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
  })

  it('will not submit the prompt with only half an identity, and says why', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    await user.type(await screen.findByLabelText(/your name/i), 'Ada')
    const go = screen.getByRole('button', { name: /continue/i })
    expect(go).toBeDisabled()
    expect(
      screen.getByText(/enter a name and an email address to continue/i),
    ).toBeInTheDocument()
  })
})

// ── f ──────────────────────────────────────────────────────────────────────

describe('a different link is a different identity', () => {
  it('asks again on another token', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Host shareToken="tok-a" />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)
    await waitFor(() => expect(posted).toEqual(['comment']))
    unmount()

    render(<Host shareToken="tok-b" />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
  })

  it('"Not you?" removes the stored key and prompts on the next post', async () => {
    const user = userEvent.setup()
    render(<Host shareToken="tok-a" />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)
    await screen.findByText(/commenting as/i)
    expect(window.localStorage.getItem(guestIdentityKey('tok-a'))).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /not you/i }))

    expect(window.localStorage.getItem(guestIdentityKey('tok-a'))).toBeNull()
    expect(screen.queryByText(/commenting as/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /post reply/i }))
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
  })
})

// ── g ──────────────────────────────────────────────────────────────────────

describe('a stale identity is not reused', () => {
  it('re-prompts once the entry is past its TTL', async () => {
    // Backdated on the way in, so no timer mocking is needed — the clock
    // never has to move for this entry to be stale.
    const user = userEvent.setup()
    window.localStorage.setItem(
      guestIdentityKey('tok-a'),
      JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        savedAt: Date.now() - GUEST_IDENTITY_TTL_MS - 1000,
      }),
    )

    render(<Host shareToken="tok-a" />)
    expect(screen.queryByText(/commenting as/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
    expect(posted).toEqual([])
  })

  it('re-prompts once the LINK itself has expired', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      guestIdentityKey('tok-a'),
      JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        savedAt: Date.now(),
      }),
    )
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()

    render(<Host shareToken="tok-a" linkExpiresAt={yesterday} />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))

    expect(await screen.findByLabelText(/your name/i)).toBeInTheDocument()
  })
})

// ── h ──────────────────────────────────────────────────────────────────────

describe('with storage blocked', () => {
  it('still posts, and simply asks every time', async () => {
    const user = userEvent.setup()
    const get = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })
    const set = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })

    render(<Host />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)
    await waitFor(() => expect(posted).toEqual(['comment']))

    // Within this page session the name is held in memory, so a second post
    // does not interrogate somebody who just typed it.
    await user.click(screen.getByRole('button', { name: /post reply/i }))
    await waitFor(() => expect(posted).toEqual(['comment', 'reply']))

    // But NOTHING was persisted, which is what makes the next page load ask
    // again. Asserted on the store rather than by remounting: a remount in
    // jsdom shares the module-level store these spies are attached to, so it
    // measures the harness rather than the product.
    expect(readGuestIdentity('tok-a')).toBeNull()

    get.mockRestore()
    set.mockRestore()
    expect(window.localStorage.getItem(guestIdentityKey('tok-a'))).toBeNull()
  })

  it('does not break the badge when nothing can be read', () => {
    const get = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })
    expect(() => render(<Host />)).not.toThrow()
    // No badge, because nothing is remembered — not a crash, and not a
    // "Commenting as undefined".
    expect(screen.queryByText(/commenting as/i)).not.toBeInTheDocument()
    get.mockRestore()
  })
})

// ── j ──────────────────────────────────────────────────────────────────────

describe('a signed-in user', () => {
  it('is never prompted, and posts straight away', async () => {
    const user = userEvent.setup()
    render(<Host isAuthenticated />)

    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await waitFor(() => expect(posted).toEqual(['comment']))

    await user.click(screen.getByRole('button', { name: /post reply/i }))
    await waitFor(() => expect(posted).toEqual(['comment', 'reply']))

    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/commenting as/i)).not.toBeInTheDocument()
  })

  it('is not shown a remembered guest identity even if one is stored', async () => {
    window.localStorage.setItem(
      guestIdentityKey('tok-a'),
      JSON.stringify({
        name: 'Ada',
        email: 'ada@example.com',
        savedAt: Date.now(),
      }),
    )
    render(<Host shareToken="tok-a" isAuthenticated />)
    expect(screen.queryByText(/commenting as/i)).not.toBeInTheDocument()
  })
})

// ── the email stays out of the URL ─────────────────────────────────────────

describe('the guest email never reaches a URL', () => {
  it('is not put into the address bar or a query string', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: /post comment/i }))
    await fillPrompt(user)
    await waitFor(() => expect(posted).toEqual(['comment']))

    expect(window.location.href).not.toContain('ada@example.com')
    expect(window.location.search).toBe('')
  })
})
