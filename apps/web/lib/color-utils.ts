/**
 * Color math + token derivation for the per-theme custom color feature
 * (Branding settings -> Theme colors). A superadmin picks from 9 "base"
 * colors per theme; everything else in globals.css (bg-tertiary,
 * accent-hover, etc.) is derived from those 9 via the HSL math below,
 * mirroring the relationships already present in FreeFrame's original
 * hand-tuned palette (see git commit d70f67c6, the last commit before the
 * navy/ivory test).
 *
 * IMPORTANT: derivation and CSS output are both *sparse*. Only base tokens
 * the user actually picked get emitted, plus the specific derived tokens
 * that depend on them. Untouched tokens are omitted entirely from the
 * generated <style> block so they keep resolving through globals.css's own
 * var() chain (e.g. --nav-border: var(--border-primary)) instead of being
 * frozen to a snapshot value. Without this, customizing just "Accent" would
 * force nav-border to a fixed hex computed from nav-bg's *default*, and a
 * later change to "Border" would have no visible effect on the nav rail --
 * exactly the bug reported after the first version of this feature shipped.
 */

export interface ThemeColorTokens {
  bgPrimary: string
  bgSecondary: string
  textPrimary: string
  textSecondary: string
  borderPrimary: string
  accent: string
  accentForeground: string
  navBg: string
  navText: string
}

export interface FullThemeTokens extends ThemeColorTokens {
  bgTertiary: string
  bgElevated: string
  bgHover: string
  borderSecondary: string
  borderFocus: string
  textTertiary: string
  textInverse: string
  accentHover: string
  accentMuted: string
  navBorder: string
}

export interface ThemeColorsPayload {
  light?: Partial<ThemeColorTokens>
  dark?: Partial<ThemeColorTokens>
}

// Original FreeFrame palette (pre navy/ivory test, commit d70f67c6) -- the
// values every theme falls back to when no custom color is set.
export const DEFAULT_DARK_TOKENS: ThemeColorTokens = {
  bgPrimary: '#0d0d10',
  bgSecondary: '#16161a',
  textPrimary: '#eaeaed',
  textSecondary: '#94949e',
  borderPrimary: '#2e2e3a',
  accent: '#5b8def',
  accentForeground: '#0d0d10',
  navBg: '#16161a',
  navText: '#eaeaed',
}

export const DEFAULT_LIGHT_TOKENS: ThemeColorTokens = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f8f8fa',
  textPrimary: '#1a1a2e',
  textSecondary: '#5a5a6e',
  borderPrimary: '#e0e0e6',
  accent: '#4a7de8',
  accentForeground: '#ffffff',
  navBg: '#f8f8fa',
  navText: '#1a1a2e',
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean
  const num = parseInt(full, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d) % 6; break
      case g: h = (b - r) / d + 2; break
      case b: h = (r - g) / d + 4; break
    }
    h *= 60
    if (h < 0) h += 360
  }
  return [h, s * 100, l * 100]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x; b = 0 }
  else if (h < 120) { r = x; g = c; b = 0 }
  else if (h < 180) { r = 0; g = c; b = x }
  else if (h < 240) { r = 0; g = x; b = c }
  else if (h < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/** Lightness (0-100) of a hex color. */
export function getLightness(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  const [, , l] = rgbToHsl(r, g, b)
  return l
}

/** Whether a color reads as "dark" (lightness below 50). */
export function isDarkColor(hex: string): boolean {
  return getLightness(hex) < 50
}

/** Shift a hex color's HSL lightness by deltaPercent (can be negative), clamped to 0-100. */
export function adjustLightness(hex: string, deltaPercent: number): string {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  const newL = clamp(l + deltaPercent, 0, 100)
  const [nr, ng, nb] = hslToRgb(h, s, newL)
  return rgbToHex(nr, ng, nb)
}

/** Linear RGB blend of two hex colors. weight=0 -> a, weight=1 -> b. */
export function mix(hexA: string, hexB: string, weight: number): string {
  const w = clamp(weight, 0, 1)
  const [ar, ag, ab] = hexToRgb(hexA)
  const [br, bg, bb] = hexToRgb(hexB)
  return rgbToHex(
    ar + (br - ar) * w,
    ag + (bg - ag) * w,
    ab + (bb - ab) * w,
  )
}

/**
 * Expands whichever base tokens the user has actually overridden into their
 * dependent derived tokens (bg-tertiary, accent-hover, nav-border, etc).
 * Returns ONLY the overridden bases plus the derived tokens whose direct
 * dependency was touched -- everything else is omitted so it keeps
 * resolving through globals.css's own var() chain. `defaults` is used only
 * to decide dark-vs-light derivation direction (via bgPrimary) when the
 * user hasn't touched bgPrimary itself, and as a blend anchor for
 * text-tertiary / accent-muted -- it never leaks into an *emitted* value
 * for a token the user didn't touch.
 */
export function deriveThemeTokens(
  overrides: Partial<ThemeColorTokens>,
  defaults: ThemeColorTokens,
): Partial<FullThemeTokens> {
  const bgPrimaryForMath = overrides.bgPrimary ?? defaults.bgPrimary
  const dark = isDarkColor(bgPrimaryForMath)
  const bgStep = dark ? 4 : -2
  const hoverStep = dark ? 8 : -7

  const out: Partial<FullThemeTokens> = { ...overrides }

  if (overrides.bgSecondary) {
    out.bgTertiary = adjustLightness(overrides.bgSecondary, bgStep)
    out.bgElevated = adjustLightness(overrides.bgSecondary, bgStep * 1.75)
    out.bgHover = adjustLightness(overrides.bgSecondary, bgStep * 2.5)
  }

  if (overrides.borderPrimary) {
    out.borderSecondary = adjustLightness(overrides.borderPrimary, -5)
  }

  if (overrides.accent) {
    out.accentHover = adjustLightness(overrides.accent, hoverStep)
    out.accentMuted = mix(overrides.accent, bgPrimaryForMath, 0.85)
    out.borderFocus = adjustLightness(overrides.accent, hoverStep)
  }

  if (overrides.textSecondary) {
    out.textTertiary = mix(overrides.textSecondary, bgPrimaryForMath, 0.35)
  }

  if (overrides.accentForeground) {
    out.textInverse = overrides.accentForeground
  }


  return out
}

const CSS_VAR_NAMES: Record<keyof FullThemeTokens, string> = {
  bgPrimary: '--bg-primary',
  bgSecondary: '--bg-secondary',
  bgTertiary: '--bg-tertiary',
  bgElevated: '--bg-elevated',
  bgHover: '--bg-hover',
  borderPrimary: '--border-primary',
  borderSecondary: '--border-secondary',
  borderFocus: '--border-focus',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  textInverse: '--text-inverse',
  accent: '--accent',
  accentHover: '--accent-hover',
  accentMuted: '--accent-muted',
  accentForeground: '--accent-foreground',
  navBg: '--nav-bg',
  navBorder: '--nav-border',
  navText: '--nav-text',
}

/**
 * Builds a `selector { --var: value; ... }` CSS block containing only the
 * tokens present in `tokens` -- anything omitted is left for globals.css's
 * own defaults / var() chain to resolve. Returns an empty string if nothing
 * is set (selector block would otherwise be empty).
 */
export function buildCssText(tokens: Partial<FullThemeTokens>, selector: string): string {
  const keys = (Object.keys(CSS_VAR_NAMES) as (keyof FullThemeTokens)[]).filter(
    (key) => tokens[key] !== undefined,
  )
  if (keys.length === 0) return ''
  const lines = keys.map((key) => `  ${CSS_VAR_NAMES[key]}: ${tokens[key]};`).join('\n')
  return `${selector} {\n${lines}\n}\n`
}
