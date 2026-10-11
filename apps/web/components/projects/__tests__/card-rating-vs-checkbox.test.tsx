/**
 * §228b item 1 — the card's star rating must not cover its selection
 * checkbox.
 *
 * The owner, after deploying §228 to his iPhone: "when one or multiple
 * videos/photos are in view the star voting is so big it doesn't allow the
 * multi-selector field to appear." §228 gave every EDITABLE star a 44px
 * hit area for the viewer's Fields tab; the asset card renders the same
 * component as an overlay across the top of a 75-350px thumbnail, so five
 * of them came to a 258px bar anchored at the right edge whose LEFT edge
 * landed 79px past the card (measured in Chromium, see before-cards.txt).
 *
 * What jsdom can check is the CONTRACT: that the card asks for a display
 * rather than a control, that the stacking order puts the checkbox on top,
 * and that the CSS says what it has to say. What it cannot check — which
 * element a tap at a point actually lands on, and whether that tap votes
 * or opens — is `document.elementFromPoint` and a real tap in Chromium,
 * in harness/cards.mjs; the §228b report has those numbers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { useViewStore } from '@/stores/view-store'
import { AssetCard } from '../asset-card'
import { StarRating } from '@/components/shared/star-rating'
import type { Asset } from '@/types'

const CSS = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')

function asset(over: Partial<Asset> = {}): Asset {
  return {
    id: 'a1',
    project_id: 'p1',
    name: 'Clip',
    status: 'in_review',
    asset_type: 'video',
    created_at: '2026-08-01T00:00:00Z',
    folder_id: null,
    avg_rating: 3.4,
    rating_count: 5,
    my_rating: 4,
    ...over,
  } as unknown as Asset
}

beforeEach(() => {
  window.localStorage.clear()
  useViewStore.setState({ cardSize: 'M' })
})

function renderCard(over: Partial<Asset> = {}, props: Record<string, unknown> = {}) {
  return render(
    <AssetCard
      asset={asset(over)}
      projectId="p1"
      onSelect={() => {}}
      canVote
      onVote={() => {}}
      {...props}
    />,
  )
}

/** The chip's own element, found the way the Chromium probe finds it. */
const chip = () => document.querySelector('.asset-card-rating') as HTMLElement
const checkbox = () => screen.getByRole('button', { name: /^Select / })
const stars = () =>
  Array.from(document.querySelectorAll('.asset-card-rating button')) as HTMLElement[]

describe('§228b — the card rating is a display on touch, not a control', () => {
  it('carries no 44px star class at all', () => {
    renderCard()
    expect(stars()).toHaveLength(5)
    for (const s of stars()) {
      expect(s.className).not.toContain('hover-none:h-11')
      expect(s.className).not.toContain('hover-none:w-11')
    }
  })

  it('and asks StarRating for that explicitly, rather than relying on readOnly', () => {
    // `readOnly` would also strip the hover-none sizing, but the card's
    // rating is NOT read-only — a mouse still votes from it. The two
    // things are separate, and this is the one that must hold whatever
    // `canVote` says.
    renderCard({ rating_count: 5 }, { canVote: false })
    for (const s of stars()) expect(s.className).not.toContain('hover-none:h-11')
  })

  it('takes no taps on a touch device, so a tap on a star opens the card', () => {
    renderCard()
    // `pointer-events: none` under `hover: none` is what makes the tap fall
    // through to the grid's card handler. It is also what stops the vote,
    // which is why no `onVote` assertion is needed: the handler is never
    // reached. Verified end-to-end in Chromium (harness/cards.mjs): the tap
    // navigates to /assets/… and posts no vote.
    expect(chip().className).toContain('hover-none:pointer-events-none')
  })

  it('while the editable rating elsewhere keeps its 44px targets (§228)', () => {
    // The viewer's Fields tab passes no `touchTargets`, so the default
    // stands. Breaking that would undo §228's "voting on a phone happens
    // in the Fields tab".
    const { container } = render(<StarRating value={3} onChange={() => {}} size="md" />)
    const btns = Array.from(container.querySelectorAll('button'))
    expect(btns).toHaveLength(5)
    for (const b of btns) {
      expect(b.className).toContain('hover-none:h-11')
      expect(b.className).toContain('hover-none:w-11')
    }
  })

  it('and a read-only rating still has none, as before', () => {
    const { container } = render(<StarRating value={3} readOnly size="sm" />)
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(b.className).not.toContain('hover-none:h-11')
    }
  })
})

describe('§228b — the checkbox is the topmost thing in its corner', () => {
  it('is stacked above the rating chip', () => {
    renderCard()
    expect(checkbox().className).toContain('z-20')
    expect(chip().className).toContain('z-10')
  })

  it('keeps its 44px hit area', () => {
    renderCard()
    expect(checkbox().className).toContain('tap-target-44')
  })

  it('and is rendered for every card that can be selected', () => {
    renderCard({ rating_count: 0, my_rating: null }, { canVote: false })
    expect(screen.getByRole('button', { name: /^Select / })).toBeTruthy()
    // No votes and no vote permission: the chip is not rendered at all.
    expect(chip()).toBeNull()
  })
})

describe('§228b — the CSS that keeps them apart on the narrowest cards', () => {
  it('hides the chip below the width where both fit, on touch only', () => {
    const i = CSS.indexOf('.asset-card-rating')
    expect(i).toBeGreaterThan(0)
    const block = CSS.slice(CSS.lastIndexOf('@media (hover: none)', i), i + 80)
    expect(block).toMatch(/@media \(hover: none\)/)
    expect(block).toMatch(/@container assetcard \(max-width: \d+px\)/)
    expect(block).toMatch(/\.asset-card-rating \{ display: none; \}/)
  })

  it('at a threshold that leaves the 44px checkbox clear of the 108px chip', () => {
    const m = /@container assetcard \(max-width: (\d+)px\) \{\s*\.asset-card-rating/.exec(CSS)
    expect(m).toBeTruthy()
    const threshold = Number(m![1])
    // 108px chip + 8px right inset + the 40px the checkbox's hit area
    // reaches in from the left = 156. Anything at or below that cannot
    // hold both, so the threshold must be at least 156 — and not so large
    // that it hides the chip on cards that have room (M is 165px at
    // 390px, measured).
    expect(threshold).toBeGreaterThanOrEqual(156)
    expect(threshold).toBeLessThan(165)
  })

  it('and nothing in it can reach a mouse, so the desktop card is unchanged', () => {
    const i = CSS.indexOf('.asset-card-rating { display: none; }')
    const open = CSS.lastIndexOf('@media (hover: none)', i)
    expect(CSS.slice(open, i)).not.toMatch(/min-width|max-width: \d+px\)\s*\{\s*@media/)
  })
})
