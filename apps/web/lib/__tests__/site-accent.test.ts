/**
 * The accent a link inherits when it sets none of its own (§145).
 *
 * The share-link appearance editor used to show a hardcoded `#6366f1` —
 * a value matching neither built-in default and stored nowhere, so the
 * swatch disagreed with both the product palette and any customisation.
 */
import { describe, it, expect } from 'vitest'
import { siteAccentColor, DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from '../color-utils'

describe('siteAccentColor', () => {
  it('uses the superadmin-configured accent for the requested theme', () => {
    const colors = { dark: { accent: '#ff0000' }, light: { accent: '#00ff00' } }
    expect(siteAccentColor(colors, 'dark')).toBe('#ff0000')
    expect(siteAccentColor(colors, 'light')).toBe('#00ff00')
  })

  it('falls back to the built-in default per theme, not one shared value', () => {
    expect(siteAccentColor(null, 'dark')).toBe(DEFAULT_DARK_TOKENS.accent)
    expect(siteAccentColor(null, 'light')).toBe(DEFAULT_LIGHT_TOKENS.accent)
    expect(DEFAULT_DARK_TOKENS.accent).not.toBe(DEFAULT_LIGHT_TOKENS.accent)
  })

  it('never returns the old hardcoded colour', () => {
    // #6366f1 was not a default of anything — it is the bug.
    for (const t of ['dark', 'light'] as const) {
      expect(siteAccentColor(null, t)).not.toBe('#6366f1')
      expect(siteAccentColor({}, t)).not.toBe('#6366f1')
    }
  })

  it('falls back when only the OTHER theme is customised', () => {
    const colors = { light: { accent: '#123456' } }
    expect(siteAccentColor(colors, 'dark')).toBe(DEFAULT_DARK_TOKENS.accent)
    expect(siteAccentColor(colors, 'light')).toBe('#123456')
  })

  it('ignores malformed entries rather than rendering them into a colour input', () => {
    // theme_colors is free-form JSONB on the wire, so this is reachable.
    const cases: unknown[] = [
      { dark: 'not-an-object' },
      { dark: { accent: 42 } },
      { dark: { accent: 'red' } },       // named colours are not #rrggbb
      { dark: { accent: '#fff' } },      // shorthand is not accepted by the input
      { dark: {} },
      { dark: null },
    ]
    for (const c of cases) {
      expect(siteAccentColor(c as Record<string, unknown>, 'dark')).toBe(DEFAULT_DARK_TOKENS.accent)
    }
  })

  it('is safe with undefined, which is what the hook returns while loading', () => {
    expect(siteAccentColor(undefined, 'dark')).toBe(DEFAULT_DARK_TOKENS.accent)
  })
})
