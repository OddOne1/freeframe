'use client'

import * as React from 'react'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'
import { BackupCodes } from '@/components/auth/backup-codes'
import { CodeConfirmDialog } from '@/components/auth/code-confirm-dialog'
import type {
  AuthTokens,
  TwoFactorMethod,
  TwoFactorSetupResponse,
  TwoFactorConfirmResponse,
  TwoFactorDisableResponse,
  TwoFactorBackupCodesResponse,
} from '@/types'

/** What the user calls it, rather than what the column calls it. */
const METHOD_LABEL: Record<TwoFactorMethod, string> = {
  totp: 'Authenticator app',
  email: 'Email',
}

type Stage = 'idle' | 'choose' | 'totp' | 'email' | 'backup'

/**
 * Swap in the replacement pair an action handed back (§199).
 *
 * Null-tolerant on purpose. Every §199 endpoint populates `tokens`, but
 * typing it nullable and checking here means this component keeps working
 * against an API that has not deployed the change yet — where the honest
 * behaviour is "keep the tokens we have", not "store undefined". Storing
 * undefined is exactly the bug §196 had to fix on the login screen, and
 * `setTokens` would write the literal string.
 */
function adoptTokens(tokens: AuthTokens | null | undefined) {
  if (!tokens?.access_token || !tokens?.refresh_token) return
  setTokens(tokens.access_token, tokens.refresh_token)
}

/**
 * Self-service two-factor, for the profile settings page (§197).
 *
 * Reads the user's own state from /auth/me, which §197 taught to report it.
 * Every action that WEAKENS the account — turning 2FA off, replacing the
 * backup codes, or starting a replacement enrolment (§194b) — is gated on a
 * current code first, because a valid session alone must not be enough to
 * undo the protection that exists precisely because sessions get stolen.
 * The third of those is the one easiest to forget: starting a new enrolment
 * is not obviously destructive, and it is the most destructive of all, since
 * it decides what the account will answer to next.
 */
export function TwoFactorSettings() {
  const { user, fetchUser } = useAuthStore()
  const enrolled = !!user?.two_factor_enabled
  const method = (user?.two_factor_method ?? null) as TwoFactorMethod | null

  const [stage, setStage] = React.useState<Stage>('idle')
  const [pendingMethod, setPendingMethod] = React.useState<TwoFactorMethod | null>(null)
  const [reauthFor, setReauthFor] = React.useState<null | 'enrol' | 'disable' | 'regenerate'>(null)
  const [secret, setSecret] = React.useState('')
  const [qr, setQr] = React.useState('')
  const [code, setCode] = React.useState<string[]>(EMPTY_CODE)
  const [codeError, setCodeError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const [success, setSuccess] = React.useState('')
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null)
  /** Why the codes are on screen — the acknowledgement means something
   *  different for a fresh enrolment than for a replacement set. */
  const [backupReason, setBackupReason] = React.useState<'enrol' | 'regenerate'>('enrol')
  const [busy, setBusy] = React.useState(false)

  function reset() {
    setStage('idle')
    setPendingMethod(null)
    setSecret('')
    setQr('')
    setCode(EMPTY_CODE)
    setCodeError('')
    setNotice('')
    setBackupCodes(null)
  }

  /** POST /auth/2fa/setup. `reauthCode` is present exactly when the account
   *  already has a live enrolment to protect (§194b). */
  async function startSetup(m: TwoFactorMethod, reauthCode?: string) {
    const res = await api.post<TwoFactorSetupResponse>('/auth/2fa/setup', {
      method: m,
      ...(reauthCode ? { reauth_code: reauthCode } : {}),
    })
    setCode(EMPTY_CODE)
    setCodeError('')
    if (res.method === 'email') {
      setNotice(
        res.email_code_sent
          ? `We sent a 6-digit code to ${user?.email}`
          : `A code was already sent to ${user?.email} — check your inbox`,
      )
      setStage('email')
    } else {
      setSecret(res.secret ?? '')
      setQr(res.qr_code_data_uri ?? '')
      setStage('totp')
    }
  }

  async function chooseMethod(m: TwoFactorMethod) {
    setError('')
    if (enrolled) {
      // Replacing a live factor needs proof of the current one first. The
      // method is chosen before the prompt so the dialog can fail and be
      // retried without losing the choice.
      setPendingMethod(m)
      setReauthFor('enrol')
      return
    }
    setBusy(true)
    try {
      await startSetup(m)
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not start setup.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup(value: string) {
    setCodeError('')
    setBusy(true)
    try {
      const res = await api.post<TwoFactorConfirmResponse>('/auth/2fa/confirm-setup', {
        code: value,
      })
      // §199 — adopted BEFORE anything else this component does, including
      // the /auth/me refetch on the way out of the backup-codes screen.
      // Enrolling bumps token_version, so the tokens this tab is holding
      // stopped working the moment that response was written; the next
      // request would 401 and sign the user out of the enrolment they just
      // completed.
      adoptTokens(res.tokens)
      // Held, not redirected past: hashed server-side the moment they are
      // issued, so this screen is the only time they exist in readable form.
      setBackupCodes(res.backup_codes)
      setBackupReason('enrol')
      setStage('backup')
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.detail : 'Invalid code. Please try again.')
      setCode(EMPTY_CODE)
    } finally {
      setBusy(false)
    }
  }

  async function handleBackupAcknowledged() {
    const reason = backupReason
    reset()
    // /auth/me is the source of "is it on, and which method" — refetching is
    // what makes this section reflect what just happened. Worth doing after a
    // regeneration too: nothing about the enrolment changed, but the call
    // costs one request and keeps one path rather than two.
    await fetchUser()
    setSuccess(
      reason === 'enrol'
        ? 'Two-factor authentication is on.'
        : 'New backup codes issued. The old ones no longer work.',
    )
  }

  async function handleReauthConfirmed(value: string) {
    if (reauthFor === 'enrol') {
      if (!pendingMethod) return
      await startSetup(pendingMethod, value)
      setReauthFor(null)
      return
    }
    if (reauthFor === 'disable') {
      const res = await api.post<TwoFactorDisableResponse>('/auth/2fa/disable', {
        code: value,
      })
      adoptTokens(res.tokens) // §199 — see confirmSetup
      setReauthFor(null)
      reset()
      await fetchUser()
      setSuccess('Two-factor authentication is off.')
      return
    }
    if (reauthFor === 'regenerate') {
      const res = await api.post<TwoFactorBackupCodesResponse>(
        '/auth/2fa/regenerate-backup-codes',
        { code: value },
      )
      adoptTokens(res.tokens) // §199 — see confirmSetup
      setReauthFor(null)
      setBackupCodes(res.backup_codes)
      setBackupReason('regenerate')
      setStage('backup')
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (stage === 'backup' && backupCodes) {
    return (
      <section className="rounded-lg border border-border bg-bg-secondary p-5">
        <BackupCodes codes={backupCodes} onAcknowledge={handleBackupAcknowledged} />
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-text-tertiary" />
        <h2 className="text-sm font-semibold text-text-primary">Two-factor authentication</h2>
      </div>

      {stage === 'idle' && (
        <>
          <p className="text-xs text-text-secondary">
            {enrolled && method
              ? `On, using ${METHOD_LABEL[method].toLowerCase()}. You'll be asked for a code each time you sign in.`
              : 'Off. A second step at sign-in means a stolen password is not enough on its own.'}
          </p>

          {success && <p className="text-xs text-status-success">{success}</p>}
          {error && <p className="text-xs text-status-error">{error}</p>}

          <div className="flex flex-wrap items-center gap-2">
            {enrolled ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setSuccess(''); setStage('choose') }}
                >
                  Change method
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setSuccess(''); setReauthFor('regenerate') }}
                >
                  Regenerate backup codes
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="text-status-error hover:text-status-error"
                  onClick={() => { setSuccess(''); setReauthFor('disable') }}
                >
                  Turn off
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => { setSuccess(''); setStage('choose') }}
              >
                Enable two-factor authentication
              </Button>
            )}
          </div>
        </>
      )}

      {stage === 'choose' && (
        <>
          <p className="text-xs text-text-secondary">
            Choose how you&apos;d like to receive your sign-in codes.
          </p>
          {error && <p className="text-xs text-status-error">{error}</p>}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => chooseMethod('totp')}
              className="rounded-md border border-border bg-bg-primary p-3 text-left transition-colors hover:border-border-focus disabled:opacity-60"
            >
              <span className="block text-sm font-medium text-text-primary">Authenticator app</span>
              <span className="block text-xs text-text-tertiary mt-0.5">
                Codes from an app on your phone. Works without a network connection.
              </span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => chooseMethod('email')}
              className="rounded-md border border-border bg-bg-primary p-3 text-left transition-colors hover:border-border-focus disabled:opacity-60"
            >
              <span className="block text-sm font-medium text-text-primary">Email</span>
              <span className="block text-xs text-text-tertiary mt-0.5">
                A code sent to {user?.email ?? 'your inbox'} each time you sign in.
              </span>
            </button>
          </div>
          <Button variant="secondary" size="sm" onClick={reset}>Cancel</Button>
        </>
      )}

      {(stage === 'totp' || stage === 'email') && (
        <>
          {stage === 'totp' ? (
            <>
              <p className="text-xs text-text-secondary">
                Scan this with your authenticator app, then enter the 6-digit code it shows.
              </p>
              {qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qr}
                  alt="Two-factor setup QR code"
                  className="h-40 w-40 rounded-md bg-white p-2"
                />
              )}
              {secret && (
                <p className="text-2xs text-text-tertiary">
                  Can&apos;t scan? Enter this key:{' '}
                  <span className="font-mono text-text-secondary">{secret}</span>
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-text-secondary">{notice}</p>
          )}

          <div className="max-w-xs space-y-2">
            <CodeInput
              value={code}
              onChange={(next) => { setCode(next); setCodeError('') }}
              onComplete={confirmSetup}
              invalid={!!codeError}
              autoFocus
            />
            {codeError && <p className="text-xs text-status-error">{codeError}</p>}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={() => confirmSetup(code.join(''))}
            >
              Turn on two-factor
            </Button>
            <Button variant="secondary" size="sm" onClick={reset}>Cancel</Button>
          </div>

          {stage === 'email' && !enrolled && (
            <button
              type="button"
              onClick={() => chooseMethod('email')}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Send it again
            </button>
          )}
          {stage === 'email' && enrolled && (
            // No resend button while REPLACING a live factor: §194b makes
            // every /2fa/setup call on an enrolled account require fresh
            // proof, and the proof the user just gave may have been a
            // single-use backup code. Re-prompting for it behind a "send
            // again" link would be a worse surprise than starting over.
            <p className="text-2xs text-text-tertiary">
              Didn&apos;t arrive? Cancel and start again.
            </p>
          )}
        </>
      )}

      <CodeConfirmDialog
        open={reauthFor !== null}
        onOpenChange={(open) => { if (!open) setReauthFor(null) }}
        title={
          reauthFor === 'disable'
            ? 'Turn off two-factor authentication'
            : reauthFor === 'regenerate'
              ? 'Replace your backup codes'
              : 'Confirm it\'s you'
        }
        description={
          reauthFor === 'disable'
            ? 'Enter a code from your current second factor. A backup code works too.'
            : reauthFor === 'regenerate'
              ? 'Enter a current code. Your existing backup codes stop working as soon as new ones are issued.'
              : 'Enter a code from your current second factor before setting up a new one.'
        }
        confirmLabel={reauthFor === 'disable' ? 'Turn off' : 'Continue'}
        onConfirm={handleReauthConfirmed}
      />
    </section>
  )
}
