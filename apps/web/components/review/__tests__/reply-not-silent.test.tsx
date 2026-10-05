/**
 * Replying works, and never fails silently (§209 part A).
 *
 * The report was "replying fails for a logged-in user AND for a guest on a
 * share link, silently: nothing in the console, no failing request". The cause
 * was not in this component — two call sites passed
 * `onSubmitReply={async () => {}}`, a no-op, from the commits that introduced
 * them, so the box took the text, resolved successfully and posted nothing.
 *
 * This file pins the half that lives here: that submitting reaches the
 * handler with the right parent, that a handler which throws produces a
 * VISIBLE message rather than silence, and that a reply held back for an
 * identity prompt keeps the draft. The wiring of the two pages is covered in
 * components/share/__tests__/guest-reply-identity.test.tsx and by the real
 * API tests in apps/api/tests/test_comment_replies.py.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/stores/review-store', () => ({
  useReviewStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      focusedCommentId: null,
      setFocusedCommentId: vi.fn(),
      setActiveAnnotation: vi.fn(),
    }
    return sel ? sel(state) : state
  },
}))

import { CommentPanel } from '../comment-panel'

const PARENT = {
  id: 'parent-1',
  asset_id: 'asset-1',
  version_id: 'v1',
  parent_id: null,
  body: 'the original note',
  author: { id: 'u1', name: 'Ada', avatar_url: null },
  guest_author: null,
  resolved: false,
  created_at: new Date().toISOString(),
  timecode_start: null,
  timecode_end: null,
  annotation: null,
  reactions: [],
  replies: [],
  visibility: 'public',
}

function renderPanel(onSubmitReply?: (p: string, b: string) => Promise<void | boolean>) {
  return render(
    <CommentPanel
      comments={[PARENT] as never}
      onResolve={vi.fn()}
      onDelete={vi.fn()}
      onAddReaction={vi.fn()}
      onRemoveReaction={vi.fn()}
      onReply={vi.fn()}
      onSubmitReply={onSubmitReply}
    />,
  )
}

async function openReplyBox(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^reply$/i }))
  return screen.getByPlaceholderText(/leave your reply here/i)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a reply reaches the handler', () => {
  it('submits the typed body with its parent id', async () => {
    const user = userEvent.setup()
    const onSubmitReply = vi.fn().mockResolvedValue(undefined)
    renderPanel(onSubmitReply)

    const box = await openReplyBox(user)
    await user.type(box, 'my reply')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    await waitFor(() =>
      expect(onSubmitReply).toHaveBeenCalledWith('parent-1', 'my reply'),
    )
  })

  it('closes the box and clears the draft once it is sent', async () => {
    const user = userEvent.setup()
    renderPanel(vi.fn().mockResolvedValue(undefined))

    const box = await openReplyBox(user)
    await user.type(box, 'my reply')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/leave your reply here/i),
      ).not.toBeInTheDocument(),
    )
  })
})

describe('a reply never fails silently', () => {
  it('shows the error when the handler throws', async () => {
    const user = userEvent.setup()
    renderPanel(vi.fn().mockRejectedValue(new Error('Network request failed')))

    const box = await openReplyBox(user)
    await user.type(box, 'my reply')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    // The whole point of §209 item 2: before this, the catch was empty with
    // the comment "error handled upstream", and nothing upstream did.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /network request failed/i,
    )
  })

  it('falls back to a plain-language message when the error has none', async () => {
    const user = userEvent.setup()
    renderPanel(vi.fn().mockRejectedValue(new Error('')))

    const box = await openReplyBox(user)
    await user.type(box, 'my reply')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /was not sent/i,
    )
  })

  it('keeps the draft on screen after a failure, so it is not lost', async () => {
    const user = userEvent.setup()
    renderPanel(vi.fn().mockRejectedValue(new Error('nope')))

    const box = await openReplyBox(user)
    await user.type(box, 'words worth keeping')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    await screen.findByRole('alert')
    expect(screen.getByPlaceholderText(/leave your reply here/i)).toHaveValue(
      'words worth keeping',
    )
  })

  it('states why Send is dead while the box is empty (17c)', async () => {
    const user = userEvent.setup()
    renderPanel(vi.fn())

    await openReplyBox(user)
    const send = screen.getByRole('button', { name: /send reply/i })
    expect(send).toBeDisabled()
    expect(screen.getByText(/write a reply first/i)).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/leave your reply here/i),
      'x',
    )
    expect(send).toBeEnabled()
    expect(screen.queryByText(/write a reply first/i)).not.toBeInTheDocument()
  })
})

describe('a reply held back for an identity prompt', () => {
  it('keeps the draft and the box open when the handler returns false', async () => {
    const user = userEvent.setup()
    // `false` is the gate saying "not sent — I am asking who they are first".
    renderPanel(vi.fn().mockResolvedValue(false))

    const box = await openReplyBox(user)
    await user.type(box, 'waiting on a name')
    await user.click(screen.getByRole('button', { name: /send reply/i }))

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/leave your reply here/i),
      ).toHaveValue('waiting on a name'),
    )
    // Not an error: nothing went wrong, the guest just has to say who they are.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('with no handler at all', () => {
  it('does not offer a reply box it cannot send', async () => {
    const user = userEvent.setup()
    renderPanel(undefined)

    await user.click(screen.getByRole('button', { name: /^reply$/i }))
    // Honest: a box that cannot post is worse than no box. This is also the
    // shape the two broken call sites hid behind — they passed a no-op, which
    // is truthy, so the box rendered and swallowed everything.
    expect(
      screen.queryByPlaceholderText(/leave your reply here/i),
    ).not.toBeInTheDocument()
  })
})
