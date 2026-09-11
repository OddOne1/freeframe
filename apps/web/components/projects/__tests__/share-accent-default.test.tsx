/**
 * The appearance editor inherits the site accent (§145).
 *
 * Two halves, and the second is the one that would quietly ruin the first:
 * the swatch must SHOW the inherited colour, and the text field must stay
 * EMPTY while inheriting. Prefilling it would read as an explicit override
 * and onBlur would persist it — turning "follows the site accent" into
 * "pinned to whatever the site accent was the first time anyone opened this
 * panel".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import { DEFAULT_DARK_TOKENS, DEFAULT_LIGHT_TOKENS } from '@/lib/color-utils'

let siteThemeColors: Record<string, unknown> | null = null
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ themeColors: siteThemeColors, isLoading: false }),
}))

let linkAppearance: Record<string, unknown> = {}
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr')
  return {
    ...actual,
    default: () => ({
      data: {
        token: 'tok', has_password: false, appearance: linkAppearance,
        allowed_download_variants: [], fields_visibility: 'disabled',
        permission: 'view', is_enabled: true, show_versions: true,
      },
      mutate: vi.fn(),
      isLoading: false,
    }),
  }
})

import userEvent from '@testing-library/user-event'
import { ShareLinkSettingsPanel } from '../share-link-detail'

/** The Appearance section ships collapsed (`defaultOpen={false}`). */
async function openAppearance() {
  render(<ShareLinkSettingsPanel token="tok" />)
  await userEvent.click(await screen.findByText('Appearance'))
}

/** The colour input reflects what a viewer would get with no override. */
function accentSwatchValue() {
  const el = document.querySelector('input[type="color"]') as HTMLInputElement | null
  return el?.value ?? null
}

/** The VISIBLE swatch — a styled div, not the input. Both must agree, and
 *  they are set from separate expressions, so asserting only the input
 *  leaves the thing the user actually looks at uncovered. */
function visibleSwatchColor() {
  const input = document.querySelector('input[type="color"]')
  const div = input?.parentElement?.querySelector('div') as HTMLElement | null
  return div?.style.backgroundColor ?? null
}

/** jsdom normalises inline colours to rgb(). */
function hexToRgb(hex: string) {
  const h = hex.replace('#', '')
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`
}
function accentTextField() {
  return screen.getByPlaceholderText(/^[0-9a-f]{6}$/i) as HTMLInputElement
}

beforeEach(() => {
  siteThemeColors = null
  linkAppearance = { theme: 'dark', accent_color: null }
})

describe('a link with no accent of its own', () => {
  it("inherits the superadmin's site accent", async () => {
    siteThemeColors = { dark: { accent: '#ff8800' } }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe('#ff8800'))
    expect(visibleSwatchColor()).toBe(hexToRgb('#ff8800'))
  })

  it('falls back to the built-in default when the site sets none', async () => {
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe(DEFAULT_DARK_TOKENS.accent))
    expect(visibleSwatchColor()).toBe(hexToRgb(DEFAULT_DARK_TOKENS.accent))
  })

  it('never shows the old hardcoded colour', async () => {
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).not.toBeNull())
    expect(accentSwatchValue()).not.toBe('#6366f1')
    expect(visibleSwatchColor()).not.toBe(hexToRgb('#6366f1'))
  })

  it('follows the theme the LINK is set to, not the viewer\'s', async () => {
    siteThemeColors = { dark: { accent: '#111111' }, light: { accent: '#eeeeee' } }
    linkAppearance = { theme: 'light', accent_color: null }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe('#eeeeee'))
  })

  it('uses the LIGHT built-in default for a light link', async () => {
    linkAppearance = { theme: 'light', accent_color: null }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe(DEFAULT_LIGHT_TOKENS.accent))
  })

  it('leaves the text field EMPTY, so nothing is persisted by opening the panel', async () => {
    siteThemeColors = { dark: { accent: '#ff8800' } }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe('#ff8800'))
    const field = accentTextField()
    expect(field.value).toBe('')
    // ...but it tells the user what they are inheriting.
    expect(field.placeholder).toBe('ff8800')
  })
})

describe('a link with an explicit accent', () => {
  it('is unaffected by the site setting', async () => {
    siteThemeColors = { dark: { accent: '#ff8800' } }
    linkAppearance = { theme: 'dark', accent_color: '#00aaff' }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe('#00aaff'))
    expect(accentTextField().value).toBe('#00aaff')
  })

  it('keeps its own colour even when it equals the old hardcoded default', async () => {
    // Someone who deliberately picked #6366f1 must keep it — the fix
    // changes an unset fallback, not stored data.
    linkAppearance = { theme: 'dark', accent_color: '#6366f1' }
    await openAppearance()
    await waitFor(() => expect(accentSwatchValue()).toBe('#6366f1'))
  })
})
