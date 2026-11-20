/**
 * The Clips tab's two display settings, grid size and text size, as two CSS
 * variables set on the tab's own container (see the snippets page):
 *
 * - `--clip-scale` (grid size): the closed card's portrait frame and its
 *   controls are multiplied by it, and the clips grid's column minimum grows
 *   with it (31rem to 45rem, clip-grid.tsx). Small is 1, exactly the sizes
 *   the card had before the setting existed; Large is 1.5. An opened card
 *   sets it back to 1 on itself, so it stays as it was.
 * - `--clip-text` (text size): the quote, the speaker line, the topic chips
 *   and the transcript are multiplied by it. Normal is 1; Large brings the
 *   12 px quote and speaker line to the 14 px of the card's title; Extra
 *   large is 1.5 (18 px), clearly bigger than the title. The title itself
 *   never reads it.
 *
 * Every class below falls back to 1 when its variable is unset, so the
 * components look exactly as before anywhere outside that container, and
 * nothing here touches global styles.
 */
import type * as React from 'react'

export type ClipGridSize = 'small' | 'large'
export type ClipTextSize = 'normal' | 'large' | 'xlarge'

export const CLIP_GRID_SIZES: readonly ClipGridSize[] = ['small', 'large']
export const CLIP_TEXT_SIZES: readonly ClipTextSize[] = ['normal', 'large', 'xlarge']

export const CLIP_GRID_SCALE: Record<ClipGridSize, number> = { small: 1, large: 1.5 }
/** Large: 0.75rem × 7/6 = 0.875rem, the closed card's title. */
export const CLIP_TEXT_SCALE: Record<ClipTextSize, number> = { normal: 1, large: 7 / 6, xlarge: 1.5 }

export const isClipGridSize = (v: unknown): v is ClipGridSize => CLIP_GRID_SIZES.includes(v as ClipGridSize)
export const isClipTextSize = (v: unknown): v is ClipTextSize => CLIP_TEXT_SIZES.includes(v as ClipTextSize)

/** The two variables for the Clips container's `style`. Each setting writes its own and nothing else. */
export function clipDisplayVars(grid: ClipGridSize, text: ClipTextSize): React.CSSProperties {
  return {
    '--clip-scale': String(CLIP_GRID_SCALE[grid]),
    '--clip-text': String(CLIP_TEXT_SCALE[text]),
  } as React.CSSProperties
}

// ── Text size (`--clip-text`) ────────────────────────────────────────────────
// Literal class strings, so Tailwind finds them. Each is the scaled twin of a
// stock size: the same font size and line height at 1.

/** text-2xs (0.625rem / 0.875rem), scaled. */
export const CLIP_TEXT_2XS = 'text-[length:calc(0.625rem*var(--clip-text,1))] leading-[calc(0.875rem*var(--clip-text,1))]'
/** text-xs (0.75rem / 1rem), scaled. */
export const CLIP_TEXT_XS = 'text-[length:calc(0.75rem*var(--clip-text,1))] leading-[calc(1rem*var(--clip-text,1))]'
/** text-sm (0.875rem / 1.25rem), scaled. */
export const CLIP_TEXT_SM = 'text-[length:calc(0.875rem*var(--clip-text,1))] leading-[calc(1.25rem*var(--clip-text,1))]'
/** Font size only, for text whose line height is set beside it (leading-normal, leading-relaxed). */
export const CLIP_FONT_XS = 'text-[length:calc(0.75rem*var(--clip-text,1))]'
export const CLIP_FONT_SM = 'text-[length:calc(0.875rem*var(--clip-text,1))]'

// ── Grid size (`--clip-scale`) ───────────────────────────────────────────────

/** Icons inside the card's controls: h-3.5 and h-4, scaled. */
export const CLIP_ICON_3_5 = 'h-[calc(0.875rem*var(--clip-scale,1))] w-[calc(0.875rem*var(--clip-scale,1))]'
export const CLIP_ICON_4 = 'h-[calc(1rem*var(--clip-scale,1))] w-[calc(1rem*var(--clip-scale,1))]'
/** A closed card's 32 px control (h-8, h-10 on touch screens), scaled. */
export const CLIP_CTL_H8 = 'h-[calc(2rem*var(--clip-scale,1))] hover-none:h-[calc(2.5rem*var(--clip-scale,1))]'
export const CLIP_CTL_SQ8 =
  'h-[calc(2rem*var(--clip-scale,1))] w-[calc(2rem*var(--clip-scale,1))] hover-none:h-[calc(2.5rem*var(--clip-scale,1))] hover-none:w-[calc(2.5rem*var(--clip-scale,1))]'
