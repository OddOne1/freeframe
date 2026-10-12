/**
 * §228b items 3d, 3e, 3f — the comment composer and the "All comments"
 * row on a phone.
 *
 * The owner, from his iPhone screenshot: "the timecode display has the
 * correct distance to the top, but the bottom needs the same distance to
 * it. The text should be centered", the composer has to be thinner, the
 * "All comments" row has to sit closer to the top with the first comment
 * closer to it, and the emoji button has to go — the iOS keyboard has its
 * own emoji key.
 *
 * jsdom lays nothing out, so the SHAPE is what is asserted here: which
 * classes carry the symmetry, that the emoji button is not rendered at
 * all, and that the primary 44px targets stay 44. The measured version is
 * Chromium at 390/360/320 (harness/measure.mjs): the field is 38px tall
 * with 12px above the timecode chip and 12px below it, the composer 99px
 * against 123px, and the "All comments" row 40px against 64px.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const pauseVideo = vi.fn()
vi.mock('../review-provider', () => ({
  useReview: () => ({ pauseVideo }),
}))
vi.mock('@/hooks/use-drawing', () => ({
  useDrawing: () => ({ clear: vi.fn(), undo: vi.fn(), getJSON: () => ({}) }),
}))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => []) } }))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      isDrawingMode: false,
      drawingTool: 'pen',
      drawingColor: '#AF52DE',
      playheadTime: 1.5,
      timeFormat: 'timecode',
      pendingAnnotation: null,
      focusedCommentId: null,
      toggleDrawingMode: vi.fn(),
      setIsDrawingMode: vi.fn(),
      setDrawingTool: vi.fn(),
      setDrawingColor: vi.fn(),
      setPendingAnnotation: vi.fn(),
      setActiveAnnotation: vi.fn(),
      setFocusedCommentId: vi.fn(),
    }
    return sel ? sel(state) : state
  },
}))

import { CommentInput } from '../comment-input'
import { CommentPanel } from '../comment-panel'

/**
 * jsdom has no media queries; this is what `usePhoneChrome` reads.
 *
 * §228c — `(max-height: 500px)` is answered explicitly: it is the phone-
 * on-its-side query, and the old `!isPhone` fall-through turned every
 * `md`+ assertion below into a landscape phone.
 */
function setPhone(isPhone: boolean, compactLandscape = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('max-height: 500px')
        ? compactLandscape
        : q.includes('max-width: 767px')
          ? isPhone
          : !isPhone,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  )
}

function renderComposer() {
  return render(
    <CommentInput
      assetId="a1"
      projectId="p1"
      assetType="video"
      onSubmit={vi.fn(async () => {})}
    />,
  )
}

const field = () => screen.getByTestId('comment-input-field')
const textarea = () => screen.getByPlaceholderText(/leave your comment/i)
const send = () => screen.getByTitle('Send (Enter)')

beforeEach(() => setPhone(true))
afterEach(() => vi.unstubAllGlobals())

// ─── 3e. Symmetric, and thinner ─────────────────────────────────────────

describe('§228b item 3e — the composer field is symmetric on a phone', () => {
  it('centres its row, so the gap above the timecode chip is the gap below it', () => {
    renderComposer()
    expect(field().className).toContain('items-center')
    expect(field().className).not.toContain('items-start')
  })

  it('and the chip carries no top margin of its own to break that', () => {
    renderComposer()
    // `mt-[9px]` against a 46px box is what made it 10px above and 21px
    // below (measured on the §228 build).
    const stamp = screen.getByTestId('comment-timecode-stamp')
    expect(stamp.className).not.toContain('mt-[9px]')
  })

  it('the text sits in the middle: equal padding around one fixed line box', () => {
    renderComposer()
    const cls = textarea().className
    expect(cls).toContain('py-2')
    expect(cls).toContain('h-9')
    // A fixed line box, not a ratio: the global 16px rule (item 2) changes
    // the font-size on a real phone, and a ratio would move the centring
    // with it.
    expect(cls).toContain('leading-[20px]')
    expect(cls).not.toContain('min-h-[38px]')
  })

  it('and the field is a 36px target, which is item 3g’s floor', () => {
    renderComposer()
    expect(textarea().className).toContain('h-9')
  })

  it('while at md+ the composer is exactly what §228 left', () => {
    setPhone(false)
    renderComposer()
    expect(field().className).toContain('items-start')
    const cls = textarea().className
    expect(cls).toContain('py-2.5')
    expect(cls).toContain('min-h-[38px]')
    expect(cls).toContain('hover-none:min-h-11')
    expect(screen.getByTestId('comment-timecode-stamp').className).toContain('mt-[9px]')
  })
})

// ─── 3f. No emoji button on a phone ─────────────────────────────────────

describe('§228b item 3f — the emoji button', () => {
  it('is not rendered on a phone', () => {
    renderComposer()
    expect(screen.queryByTestId('comment-emoji-button')).toBeNull()
    expect(screen.queryByTitle('Add emoji')).toBeNull()
  })

  it('and is not merely hidden, so nothing invisible is left to tap', () => {
    const { container } = renderComposer()
    expect(container.querySelector('[title="Add emoji"]')).toBeNull()
  })

  it('but the desktop keeps it', () => {
    setPhone(false)
    renderComposer()
    expect(screen.getByTestId('comment-emoji-button')).toBeTruthy()
  })
})

// ─── 3g. The target policy inside the composer ──────────────────────────

describe('§228b item 3g — 44 for Send, 36 for the rest of the row', () => {
  it('Send is on the primary list and stays 44x44', () => {
    renderComposer()
    expect(send().className).toContain('h-11')
    expect(send().className).toContain('w-11')
  })

  it('the timecode toggle and the visibility pill drop to 36', () => {
    renderComposer()
    expect(screen.getByTestId('comment-timecode-toggle').className).toContain('h-9')
    expect(screen.getByRole('button', { name: /public/i }).className).toContain('h-9')
  })

  it('and at md+ every one of them is back to the §228 sizing', () => {
    setPhone(false)
    renderComposer()
    expect(send().className).toContain('hover-none:h-11')
    expect(send().className).toContain('h-7')
    expect(screen.getByTestId('comment-timecode-toggle').className).toContain('h-7')
  })
})

// ─── 3d. The "All comments" row ─────────────────────────────────────────

function renderPanel() {
  return render(
    <CommentPanel
      comments={[] as never}
      onResolve={vi.fn()}
      onDelete={vi.fn()}
      onAddReaction={vi.fn()}
      onRemoveReaction={vi.fn()}
      onReply={vi.fn()}
    />,
  )
}

describe('§228b item 3d — the "All comments" row sits closer to the top', () => {
  it('loses most of its vertical padding on a phone', () => {
    renderPanel()
    const bar = screen.getByTestId('comment-panel-toolbar')
    expect(bar.className).toContain('py-0.5')
    expect(bar.className).not.toContain('py-2.5')
  })

  it('and its three icon buttons drop to the 36px floor', () => {
    renderPanel()
    for (const title of ['Filter', 'Sort', 'Search']) {
      const b = screen.getByTitle(title)
      expect(b.className, title).toContain('h-9')
      expect(b.className, title).not.toContain('hover-none:h-11')
    }
  })

  it('the visibility button too', () => {
    renderPanel()
    const b = screen.getByRole('button', { name: /all comments/i })
    expect(b.className).toContain('min-h-9')
    expect(b.className).not.toContain('hover-none:min-h-11')
  })

  it('while at md+ the row is exactly what §228 left', () => {
    setPhone(false)
    renderPanel()
    expect(screen.getByTestId('comment-panel-toolbar').className).toContain('py-2.5')
    expect(screen.getByTitle('Filter').className).toContain('hover-none:h-11')
    expect(screen.getByRole('button', { name: /all comments/i }).className).toContain(
      'hover-none:min-h-11',
    )
  })
})
