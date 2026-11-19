/**
 * The passphrase field when the API withholds the passphrase.
 *
 * `GET /share/{token}/details` now sends `password_value` only to the link's
 * creator and the project's owner/admin (and superadmins). Everyone else gets
 * `has_password: true` with `password_value: null`.
 *
 * The panel re-fetches the link after every save. It used to reset the field
 * to `password_value || ""` on each fetch, which for a caller who is not shown
 * the passphrase would blank the field 300 ms into typing — and the next
 * keystroke would then save a truncated passphrase. The third test pins that.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ themeColors: null, isLoading: false }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn(async () => ({})), post: vi.fn() },
}))

// SWR keeps a fetched record's identity until the next fetch; this mock does
// the same, so replacing `linkData` is what "the record was re-fetched" means.
let linkData: Record<string, unknown> = {}
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr')
  return {
    ...actual,
    default: () => ({ data: linkData, mutate: vi.fn(), isLoading: false }),
  }
})

import { ShareLinkSettingsPanel } from '../share-link-detail'

function base(overrides: Record<string, unknown>) {
  return {
    token: 'tok', title: 'Review', permission: 'view', is_enabled: true,
    show_versions: true, show_comments: true, show_watermark: false,
    allowed_download_variants: [], fields_visibility: 'disabled',
    appearance: { theme: 'dark', accent_color: null },
    has_password: false, password_value: null,
    ...overrides,
  }
}

function passphraseInput() {
  return document.querySelector(
    'input[type="password"], input[placeholder*="assphrase"]',
  ) as HTMLInputElement | null
}

beforeEach(() => {
  linkData = base({})
})

describe('passphrase field', () => {
  it('shows the passphrase to a caller the API sends it to', () => {
    linkData = base({ has_password: true, password_value: 's3cret' })
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(passphraseInput()?.value).toBe('s3cret')
  })

  it('stays empty, with a "set" placeholder, when the API withholds it', () => {
    linkData = base({ has_password: true, password_value: null })
    render(<ShareLinkSettingsPanel token="tok" />)
    const input = passphraseInput()
    expect(input).not.toBeNull()
    expect(input!.value).toBe('')
    expect(input!.placeholder).toBe('Passphrase set — type to replace it')
  })

  it('keeps what was typed when the record is re-fetched without the passphrase', async () => {
    linkData = base({ has_password: true, password_value: null })
    const { rerender } = render(<ShareLinkSettingsPanel token="tok" />)
    await userEvent.type(passphraseInput()!, 'new-pass')

    // The save's re-fetch: a NEW record object, passphrase still withheld.
    linkData = base({ has_password: true, password_value: null })
    rerender(<ShareLinkSettingsPanel token="tok" />)

    expect(passphraseInput()!.value).toBe('new-pass')
  })

  it('shows no field at all when the link has no passphrase', () => {
    render(<ShareLinkSettingsPanel token="tok" />)
    expect(passphraseInput()).toBeNull()
  })
})
