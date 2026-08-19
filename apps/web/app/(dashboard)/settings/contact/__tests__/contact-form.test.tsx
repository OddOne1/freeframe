/**
 * The Contact page's form and its admin section (CLAUDE.md §47).
 *
 * The backend owns "who may read the target address"; what is asserted here
 * is the half that only exists in the browser — that the form refuses to
 * pretend it works when nothing is configured, and that the admin box can't
 * blank a configured address by being left alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    post: (path: string, body: unknown) => post(path, body),
    patch: (path: string, body: unknown) => patch(path, body),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}))

let isSuperAdmin = false
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { email: 'me@example.com' }, isSuperAdmin }),
}))

import ContactPage from '../page'

let settings: { configured: boolean; target_email: string | null; requests_last_30_days: number | null }

beforeEach(() => {
  isSuperAdmin = false
  settings = { configured: true, target_email: null, requests_last_30_days: null }
  ;[get, post, patch].forEach((m) => m.mockReset())
  post.mockResolvedValue({})
  patch.mockResolvedValue({})
  get.mockImplementation((path: string) => {
    if (path === '/contact/settings') return Promise.resolve(settings)
    if (path === '/users/admins') return Promise.resolve([])
    return Promise.resolve([])
  })
})

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ContactPage />
    </SWRConfig>,
  )
}

describe('the form', () => {
  it('posts the message, with the sender coming from the session', async () => {
    renderPage()
    await userEvent.type(await screen.findByLabelText('Message'), 'the printer is on fire')
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contact', {
        subject: null,
        message: 'the printer is on fire',
      }),
    )
    // No name or email field to disagree with the account submitting.
    expect(screen.queryByLabelText(/Your name/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Sent as me@example.com/)).toBeInTheDocument()
  })

  it('sends an entered subject through', async () => {
    renderPage()
    await userEvent.type(await screen.findByLabelText('Subject'), 'Billing')
    await userEvent.type(screen.getByLabelText('Message'), 'question')
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/contact', { subject: 'Billing', message: 'question' }),
    )
  })

  it('disables itself and says why when nothing is configured', async () => {
    settings = { configured: false, target_email: null, requests_last_30_days: null }
    renderPage()

    expect(await screen.findByText(/No contact address is configured/)).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled()
  })

  it('shows no unconfigured warning while the settings are still loading', () => {
    // A flash of "not set up" on every page load would be worse than a beat
    // of nothing.
    get.mockImplementation(() => new Promise(() => {}))
    renderPage()
    expect(screen.queryByText(/No contact address is configured/)).not.toBeInTheDocument()
  })

  it('surfaces the server’s own refusal rather than a generic failure', async () => {
    post.mockRejectedValue({ detail: 'No contact address is configured yet. Ask a superadmin to set one.' })
    renderPage()
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))

    expect(await screen.findByText(/Ask a superadmin to set one/)).toBeInTheDocument()
  })

  it('will not submit an empty message', async () => {
    renderPage()
    await screen.findByLabelText('Message')
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Message'), '   ')
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled()
    expect(post).not.toHaveBeenCalled()
  })
})

describe('the admin section', () => {
  it('is invisible to a non-superadmin', async () => {
    renderPage()
    await screen.findByLabelText('Message')
    expect(screen.queryByLabelText('Contact target email')).not.toBeInTheDocument()
    expect(screen.queryByText(/in the last 30 days/)).not.toBeInTheDocument()
  })

  it('shows the target and the 30-day count to a superadmin', async () => {
    isSuperAdmin = true
    settings = { configured: true, target_email: 'support@example.com', requests_last_30_days: 4 }
    renderPage()

    expect(await screen.findByLabelText('Contact target email')).toHaveValue('support@example.com')
    expect(screen.getByText(/in the last 30 days/)).toHaveTextContent('4')
  })

  it('saves a changed target', async () => {
    isSuperAdmin = true
    settings = { configured: true, target_email: 'old@example.com', requests_last_30_days: 0 }
    renderPage()

    const input = await screen.findByLabelText('Contact target email')
    await userEvent.clear(input)
    await userEvent.type(input, 'new@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/contact/settings', { target_email: 'new@example.com' }),
    )
  })

  it('cannot blank a configured address by being left alone', async () => {
    isSuperAdmin = true
    settings = { configured: true, target_email: 'support@example.com', requests_last_30_days: 0 }
    renderPage()

    await screen.findByLabelText('Contact target email')
    // Save stays disabled until the value actually differs, so an untouched
    // box cannot PATCH an empty string over a working address.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
