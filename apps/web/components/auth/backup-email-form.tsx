'use client'

/**
 * Set and confirm the password-reset address (§200).
 *
 * One component, two homes: the blocking onboarding gate, and the Profile
 * settings screen where somebody changes an address they already have. The
 * flow is identical in both — propose, receive a code, confirm — so it is
 * written once. What differs is only the surrounding chrome, which is the
 * caller's business.
 *
 * `onChanged` fires after any write, so the caller can refetch `/auth/me` and
 * let the SERVER's answer decide whether the gate is still up. Nothing here
 * assumes its own success: the gate is computed from stored data, and a
 * screen that unblocked itself optimistically would sit in front of an API
 * that kept returning 403.
 */

import * as React from 'react'
import { AlertTriangle, Mail, ShieldCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'
import type { BackupEmailResponse, User } from '@/types'

export function BackupEmailForm({
  user,
  onChanged,
}: {
  user: User
  onChanged: () => Promise<void> | void
}) {
  const state = user.backup_email_state ?? 'missing'
  const isVerified = state === 'verified'

  const [address, setAddress] = React.useState(user.backup_email ?? '')
  // "Am I editing?" — true whenever there is no confirmed address to show, and
  // toggled on by the Change button when there is.
  const [editing, setEditing] = React.useState(!isVerified)
  const [code, setCode] = React.useState<string[]>(EMPTY_CODE)
  const [reauthCode, setReauthCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [sameDomain, setSameDomain] = React.useState(false)

  // Follows the server, not the local edit: after a successful verify the
  // parent refetches /auth/me and this collapses back to the summary view.
  React.useEffect(() => {
    if (user.backup_email_state === 'verified') {
      setEditing(false)
      setAddress(user.backup_email ?? '')
    }
  }, [user.backup_email_state, user.backup_email])

  // Changing an address that is already confirmed needs the current second
  // factor — the server demands it, and asking for it up front is better than
  // a 401 after the user has typed an address.
  const needsReauth = isVerified && (user.two_factor_enabled ?? false)

  async function submitAddress(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    const candidate = address.trim()
    if (!candidate) {
      setError('Enter an address')
      return
    }
    // Checked here as well as on the server, so the most common mistake is
    // caught without a round-trip. The server's check is the one that counts:
    // this one is a convenience and is case-insensitive for the same reason
    // its twin is.
    if (candidate.toLowerCase() === user.email.toLowerCase()) {
      setError(
        'That is the address you sign in with. Your backup address has to be a ' +
          'different mailbox — if one inbox can receive both, it is one factor, not two.',
      )
      return
    }
    setBusy(true)
    try {
      const res = await api.post<BackupEmailResponse>('/auth/backup-email', {
        backup_email: candidate,
        ...(reauthCode ? { reauth_code: reauthCode.trim() } : {}),
      })
      setSameDomain(res.same_domain)
      setCode(EMPTY_CODE)
      setReauthCode('')
      setNotice(`We sent a 6-digit code to ${res.backup_email}.`)
      await onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not save that address')
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(entered: string) {
    setError('')
    if (entered.length < 6) {
      setError('Enter the 6-digit code')
      return
    }
    setBusy(true)
    try {
      await api.post('/auth/backup-email/verify', { code: entered })
      setNotice('')
      await onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Invalid or expired code')
      setCode(EMPTY_CODE)
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError('')
    setBusy(true)
    try {
      const res = await api.post<BackupEmailResponse>('/auth/backup-email/resend')
      setNotice(
        res.code_sent
          ? `We sent another code to ${res.backup_email}.`
          : 'That address is already confirmed.',
      )
      await onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not resend the code')
    } finally {
      setBusy(false)
    }
  }

  if (isVerified && !editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-border bg-bg-tertiary p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-status-success" />
          <div className="min-w-0">
            <p className="text-sm text-text-primary">{user.backup_email}</p>
            <p className="text-xs text-text-tertiary">
              Password reset codes go here, and nowhere else.
            </p>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Change address
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {state === 'pending' && !editing ? null : (
        <form onSubmit={submitAddress} className="space-y-3">
          <Input
            id="backup-email"
            label="Password-reset address"
            type="email"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setError('')
            }}
            placeholder="you@somewhere-else.com"
            disabled={busy}
          />
          <p className="text-2xs leading-relaxed text-text-tertiary">
            This has to be a mailbox your sign-in address cannot read. Sign-in
            codes go to <strong>{user.email}</strong>; password resets will go
            here. Keeping them apart is what stops one compromised inbox from
            being the whole account.
          </p>

          {needsReauth && (
            <Input
              id="backup-email-reauth"
              label="Code from your authenticator (or a backup code)"
              value={reauthCode}
              onChange={(e) => setReauthCode(e.target.value)}
              placeholder="6-digit code"
              disabled={busy}
            />
          )}

          <Button type="submit" variant="primary" size="sm" loading={busy}>
            {state === 'missing' ? 'Send confirmation code' : 'Save and send code'}
          </Button>
        </form>
      )}

      {sameDomain && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
          <p className="text-xs leading-relaxed text-text-secondary">
            That address is on the same domain as your sign-in address. It will
            work, but anyone who administers that domain can read both
            mailboxes — which is the thing keeping the two apart is meant to
            prevent. A personal address is a better choice.
          </p>
        </div>
      )}

      {state === 'pending' && (
        <div className="space-y-3 rounded-lg border border-border bg-bg-tertiary p-3">
          <div className="flex items-start gap-2">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
            <p className="text-xs leading-relaxed text-text-secondary">
              {notice || `Enter the 6-digit code we sent to ${user.backup_email}.`}
            </p>
          </div>
          <CodeInput
            value={code}
            onChange={(next) => {
              setCode(next)
              setError('')
            }}
            onComplete={submitCode}
            invalid={!!error}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => submitCode(code.join(''))}
            >
              Confirm
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={resend}>
              Resend code
            </Button>
            {!editing && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                Use a different address
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-status-error">{error}</p>}
      {notice && state !== 'pending' && (
        <p className="text-xs text-text-tertiary">{notice}</p>
      )}
    </div>
  )
}
