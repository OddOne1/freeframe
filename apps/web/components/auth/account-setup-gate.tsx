'use client'

/**
 * The blocking onboarding screen (§200).
 *
 * Rendered instead of the dashboard while this account still has no password
 * or no confirmed password-reset address. **Order is fixed: password first,
 * then the backup address** — a reset channel is only worth confirming for an
 * account that has something to reset.
 *
 * It is not the enforcement. `middleware/account_gate.py` answers 403
 * `account_setup_required` to every protected route on its own, computed from
 * the same columns this screen reads out of `/auth/me`. So this exists to
 * explain and to offer the two forms — not to decide. A user who hid it would
 * find an app that loads nothing.
 *
 * There is deliberately no "skip" and no "remind me later". The state is
 * derived from stored data, so a dismissal would have to be stored as a flag,
 * and a flag is exactly what §200 refused: it would drift from the data,
 * survive the data being cleared, and turn a requirement into a preference.
 * The escape hatch for a genuinely stuck user is a superadmin or
 * `scripts/clear_account_gate.py`, and the sign-out button below is the way
 * to reach someone who can do that.
 */

import * as React from 'react'
import { ShieldAlert, KeyRound, Mail, LogOut } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { PasswordField } from '@/components/auth/password-field'
import { BackupEmailForm } from '@/components/auth/backup-email-form'
import { PasswordSubmitNote } from '@/components/auth/password-submit-note'
import { passwordSubmitBlock, usePasswordPolicy } from '@/lib/password-policy'
import type { PasswordStrength, SetPasswordResponse, User } from '@/types'

/** Whether this user is still blocked, from what /auth/me reports.
 *
 *  Exported so the shell and the tests ask the same question of the same
 *  fields. */
export function accountSetupOutstanding(user: User | null): boolean {
  if (!user) return false

  // NEITHER field present means this response came from an API that does not
  // have the gate — an older deployment, or a cached /auth/me from before it
  // shipped. Not gated, deliberately: the server is the enforcer, so if it
  // does not report the fields it is not refusing anything either, and
  // inventing a block here would trap the user behind a screen with nothing
  // on the other side of it.
  //
  // Checked FIRST and on both fields together. `backup_email_state ?? 'missing'`
  // on its own reads an absent field as "no address", which is the opposite
  // conclusion — it was the original shape here and a test caught it saying
  // "gated" about exactly the response this comment describes.
  if (user.must_set_password === undefined && user.backup_email_state === undefined) {
    return false
  }

  if (user.must_set_password) return true
  // Only "verified" clears it. "pending" is an address nobody has proved is a
  // mailbox, and treating that as done would be a recovery path that only
  // looks like one.
  return (user.backup_email_state ?? 'missing') !== 'verified'
}

export function AccountSetupGate({ user }: { user: User }) {
  const { fetchUser, logout } = useAuthStore()

  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [strength, setStrength] = React.useState<PasswordStrength | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const policy = usePasswordPolicy()

  const needsPassword = !!user.must_set_password
  // §202 — see lib/password-policy.passwordSubmitBlock. Shared with the three
  // other password forms so a fix in one is a fix in all, which is precisely
  // what four copies of `!strength?.meetsPolicy` did not give us.
  const submitBlock = passwordSubmitBlock({
    password,
    confirmPassword: confirm,
    strength,
    policy,
  })

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('The two passwords do not match')
      return
    }
    setBusy(true)
    try {
      const res = await api.post<SetPasswordResponse>('/auth/set-password', {
        password,
      })
      // §199 — setting a password bumps token_version, which ends every
      // session this user holds INCLUDING this tab's. Adopting the pair the
      // response carries is what stops the next request 401ing. Guarded
      // rather than unpacked blind, per §196's rule about never storing
      // `undefined` over working tokens.
      if (res?.access_token && res?.refresh_token) {
        setTokens(res.access_token, res.refresh_token)
      }
      setPassword('')
      setConfirm('')
      // The server decides whether the gate lifts, not this component.
      await fetchUser()
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'Could not set that password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-start justify-center overflow-y-auto p-6">
      <div className="w-full max-w-lg space-y-6 py-8">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted">
            <ShieldAlert className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">
              Finish securing your account
            </h1>
            {/* One sentence, as the spec asked — the reason, not a policy
                lecture. Somebody who is blocked wants to know why and what to
                do, in that order. */}
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Until now a single mailbox could both receive your sign-in codes
              and reset your password, which made it the whole account — so
              every account now needs a password and a separate address for
              password resets.
            </p>
          </div>
        </div>

        {/* Step 1 — password. Shown as done rather than hidden once it is
            set, so the screen reads as progress instead of as a new demand
            appearing each time one is met. */}
        <section className="rounded-lg border border-border bg-bg-secondary p-5">
          <div className="flex items-center gap-2">
            <KeyRound
              className={
                needsPassword
                  ? 'h-4 w-4 text-accent'
                  : 'h-4 w-4 text-status-success'
              }
            />
            <h2 className="text-sm font-semibold text-text-primary">
              1. Set a password
            </h2>
            {!needsPassword && (
              <span className="text-xs text-status-success">Done</span>
            )}
          </div>

          {needsPassword ? (
            <form onSubmit={submitPassword} className="mt-4 space-y-4">
              <PasswordField
                id="gate-password"
                label="New password"
                value={password}
                onChange={(v) => {
                  setPassword(v)
                  setError('')
                }}
                disabled={busy}
                // The meter scores against the same things the server rejects
                // for — see PasswordField's own note on why this is not
                // optional in spirit.
                userInputs={[user.email, user.name, user.first_name ?? '', user.last_name]}
                onStrengthChange={setStrength}
                autoFocus
              />
              <div className="space-y-1.5">
                <label
                  htmlFor="gate-password-confirm"
                  className="text-sm font-medium text-text-secondary"
                >
                  Confirm password
                </label>
                <input
                  id="gate-password-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setError('') }}
                  disabled={busy}
                  autoComplete="new-password"
                  className="flex h-10 w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary transition-all duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              {error && <p className="text-xs text-status-error">{error}</p>}
              {/* §202 — a blocked submit always says why. Never disabled by a
                  score that is merely pending or unavailable: the server runs
                  the real policy, including the two rules the browser cannot
                  check at all. */}
              <PasswordSubmitNote reason={submitBlock} />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!!submitBlock}
              >
                Set password
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-xs text-text-tertiary">
              Your password is set. You can change it later in Settings →
              Profile.
            </p>
          )}
        </section>

        {/* Step 2 — backup address. Deliberately inert until step 1 is done:
            confirming where to send a reset is meaningless for an account
            that has nothing to reset, and doing both at once turns one
            blocking screen into two half-finished ones. */}
        <section
          className={
            needsPassword
              ? 'rounded-lg border border-border bg-bg-secondary p-5 opacity-50'
              : 'rounded-lg border border-border bg-bg-secondary p-5'
          }
        >
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-text-primary">
              2. Add a password-reset address
            </h2>
          </div>

          {needsPassword ? (
            <p className="mt-2 text-xs text-text-tertiary">
              Set your password first.
            </p>
          ) : (
            <div className="mt-4">
              <BackupEmailForm user={user} onChanged={fetchUser} />
            </div>
          )}
        </section>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <p className="text-2xs text-text-tertiary">
            Stuck? An administrator can unblock your account.
          </p>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
    </div>
  )
}
