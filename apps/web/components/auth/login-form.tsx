'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'
import { BackupCodes } from '@/components/auth/backup-codes'
import { PasswordField } from '@/components/auth/password-field'
import { PasswordSubmitNote } from '@/components/auth/password-submit-note'
import { passwordSubmitBlock, usePasswordPolicy } from '@/lib/password-policy'
import type {
  VerifyCodeResponse,
  AuthTokens,
  LoginResponse,
  SetPasswordResponse,
  TwoFactorMethod,
  TwoFactorSetupResponse,
  TwoFactorConfirmResponse,
  PasswordStrength,
} from '@/types'

/**
 * `'password'` is the magic-code user CREATING a password — unrelated to the
 * two 2FA steps, which is why those are spelled out rather than shortened to
 * something that could be mistaken for it.
 *
 * `'2fa-code'`  — enrolled already, completing a login (§191).
 * `'2fa-setup'` — never enrolled, and the instance requires it, so enrolment
 *                 happens here rather than after sign-in.
 */
type Step = 'email' | 'code' | 'password' | 'classic' | '2fa-code' | '2fa-setup'

/** Where inside forced enrolment we are. Kept separate from `Step` because
 *  all four of these belong to the same step of the login itself. */
type SetupStage = 'choose' | 'totp' | 'email' | 'backup'

export function LoginForm() {
  const router = useRouter()
  const { requireTwoFactor, isLoading: settingsLoading } = useSiteSettings()

  const [step, setStep] = useState<Step | null>(null)
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [code, setCode] = useState<string[]>(EMPTY_CODE)
  const [codeError, setCodeError] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [generalError, setGeneralError] = useState('')
  const [loading, setLoading] = useState(false)

  // Classic login fields
  const [classicEmail, setClassicEmail] = useState('')
  const [classicPassword, setClassicPassword] = useState('')
  const [classicError, setClassicError] = useState('')

  // ─── Two-factor state (§191-§195) ────────────────────────────────────────
  // The pending token is the whole of what the 2FA steps carry forward: it
  // is inert everywhere except /auth/2fa/*, so holding it in component state
  // grants nothing that surviving a reload would be worth.
  const [pendingToken, setPendingToken] = useState('')
  const [twoFactorMethod, setTwoFactorMethod] = useState<TwoFactorMethod | null>(null)
  const [twoFactorEmail, setTwoFactorEmail] = useState('')
  const [twoFactorNotice, setTwoFactorNotice] = useState('')
  const [setupStage, setSetupStage] = useState<SetupStage>('choose')
  const [setupSecret, setSetupSecret] = useState('')
  const [setupQr, setSetupQr] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  // §200 — the live meter's verdict, so the submit button reflects the real
  // rules rather than a length check that no longer matches any of them.
  const [passwordStrength, setPasswordStrength] =
    useState<PasswordStrength | null>(null)
  const passwordPolicy = usePasswordPolicy()
  const [enrolledTokens, setEnrolledTokens] = useState<AuthTokens | null>(null)

  /**
   * Which screen to open on, before the user has navigated anywhere.
   *
   * Derived rather than stored, so the answer can arrive late without a
   * flash: `null` means site settings are still loading and nothing is
   * painted yet. In practice they are seeded server-side by the (auth)
   * layout, so the very first render already has the answer.
   *
   * With `require_2fa` on, magic-code sign-in is refused by the API (§195),
   * so opening on it would be offering a button that always fails.
   */
  const activeStep: Step | null =
    step ?? (settingsLoading ? null : requireTwoFactor ? 'classic' : 'email')

  // ─── One place that reads a login response (§193's lesson, client-side) ──

  /**
   * What both /auth/login and /auth/verify-magic-code return, handled once.
   *
   * The backend collapsed its two copies of this branch into
   * `_login_outcome` for exactly this reason: two independent readings of
   * the same union drift, and the half that drifts is the half nobody signs
   * in through that week. `res.requires_2fa` is the only thing branched on —
   * never whether `access_token` happens to be present, which is the check
   * that silently produced `setTokens(undefined, undefined)` before §196.
   */
  async function handleLoginResponse(res: LoginResponse, emailUsed: string) {
    if (res.requires_2fa) {
      setPendingToken(res.pending_token)
      setTwoFactorMethod(res.method)
      setTwoFactorEmail(emailUsed)
      setCode(EMPTY_CODE)
      setCodeError('')
      setTwoFactorNotice(
        res.email_code_sent ? `We sent a 6-digit code to ${emailUsed}` : '',
      )
      if (res.setup_required) {
        setSetupStage('choose')
        setStep('2fa-setup')
      } else {
        setStep('2fa-code')
      }
      return
    }
    await completeLogin(res)
  }

  /** Tokens in hand: the end of every path through this form. */
  async function completeLogin(res: VerifyCodeResponse) {
    setTokens(res.access_token, res.refresh_token)
    if (res.needs_password) {
      setStep('password')
      return
    }
    await useAuthStore.getState().fetchUser()
    router.replace('/projects')
  }

  // ─── Step 1: Send magic code ──────────────────────────────────────────────

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setEmailError('')
    setGeneralError('')

    if (!email) {
      setEmailError('Email is required')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Enter a valid email address')
      return
    }

    setLoading(true)
    try {
      await api.post('/auth/send-magic-code', { email })
      setCode(EMPTY_CODE)
      setStep('code')
    } catch (err) {
      if (err instanceof ApiError) {
        setGeneralError(err.detail)
      } else {
        setGeneralError('Failed to send code. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  // ─── Step 2: Verify code ─────────────────────────────────────────────────

  async function submitCode(codeStr: string) {
    setCodeError('')
    setGeneralError('')
    setLoading(true)
    try {
      const res = await api.post<LoginResponse>('/auth/verify-magic-code', {
        email,
        code: codeStr,
      })
      await handleLoginResponse(res, email)
    } catch (err) {
      if (err instanceof ApiError) {
        setCodeError(err.detail)
      } else {
        setCodeError('Invalid or expired code. Please try again.')
      }
      setCode(EMPTY_CODE)
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault()
    const codeStr = code.join('')
    if (codeStr.length < 6) {
      setCodeError('Enter the 6-digit code')
      return
    }
    await submitCode(codeStr)
  }

  // ─── Step 3: Set password ────────────────────────────────────────────────

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError('')
    setGeneralError('')

    if (!password) {
      setPasswordError('Password is required')
      return
    }
    // §200 — the `length < 8` rule is gone, not relaxed. It was the only
    // password rule this app had, it lived in the browser only, and it is
    // now four rules plus a strength score enforced by the server.
    // PasswordField shows them live; the submit button below is disabled
    // until they pass, and `generalError` renders the server's refusal for
    // the two rules the browser cannot check.
    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setLoading(true)
    try {
      // §199 — typed against what this endpoint actually returns. It was
      // typed `AuthTokens` while the backend returned only a user, so
      // `setTokens` stored the literal string "undefined" over the tokens
      // the magic-code step had just set. The endpoint now returns a real
      // pair (it has to: setting a password bumps token_version and ends
      // the session that did it), so the fields this already read exist.
      const res = await api.post<SetPasswordResponse>('/auth/set-password', {
        email,
        code: code.join(''),
        password,
      })
      setTokens(res.access_token, res.refresh_token)
      await useAuthStore.getState().fetchUser()
      router.replace('/projects')
    } catch (err) {
      if (err instanceof ApiError) {
        setGeneralError(err.detail)
      } else {
        setGeneralError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  // ─── Classic login ───────────────────────────────────────────────────────

  async function handleClassicLogin(e: React.FormEvent) {
    e.preventDefault()
    setClassicError('')

    if (!classicEmail || !classicPassword) {
      setClassicError('Email and password are required')
      return
    }

    setLoading(true)
    try {
      const res = await api.post<LoginResponse>('/auth/login', {
        email: classicEmail,
        password: classicPassword,
      })
      await handleLoginResponse(res, classicEmail)
    } catch (err) {
      if (err instanceof ApiError) {
        setClassicError(err.detail)
      } else {
        setClassicError('Invalid email or password')
      }
    } finally {
      setLoading(false)
    }
  }

  // ─── Two-factor: completing a login ──────────────────────────────────────

  async function submitTwoFactorCode(codeStr: string) {
    setCodeError('')
    setLoading(true)
    try {
      // Returns real tokens directly (TokenResponse), not another union —
      // verify_two_factor_login is past the gate by definition.
      const res = await api.post<VerifyCodeResponse>('/auth/2fa/verify-login', {
        pending_token: pendingToken,
        code: codeStr,
      })
      await completeLogin(res)
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.detail : 'Invalid code. Please try again.')
      setCode(EMPTY_CODE)
    } finally {
      setLoading(false)
    }
  }

  async function handleTwoFactorSubmit(e: React.FormEvent) {
    e.preventDefault()
    const codeStr = code.join('')
    if (codeStr.length < 6) {
      setCodeError('Enter the 6-digit code')
      return
    }
    await submitTwoFactorCode(codeStr)
  }

  /**
   * Resend, for an email-primary user completing a login.
   *
   * /auth/2fa/send-email-fallback is the `force=True` path server-side: it
   * replaces whatever code is outstanding, because reaching this button IS
   * the user saying the one they have did not arrive. Safe to press twice.
   * It only does anything for a user who is ENROLLED, which is exactly the
   * case this step covers — the enrolment screen needs a different call.
   */
  async function handleResendLoginCode() {
    setCodeError('')
    setLoading(true)
    try {
      await api.post('/auth/2fa/send-email-fallback', { pending_token: pendingToken })
      setTwoFactorNotice(`We sent a new 6-digit code to ${twoFactorEmail}`)
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.detail : 'Could not send a new code.')
    } finally {
      setLoading(false)
    }
  }

  // ─── Two-factor: forced enrolment ────────────────────────────────────────

  async function chooseMethod(method: TwoFactorMethod) {
    setCodeError('')
    setGeneralError('')
    setLoading(true)
    try {
      const res = await api.post<TwoFactorSetupResponse>('/auth/2fa/setup', {
        pending_token: pendingToken,
        method,
      })
      setTwoFactorMethod(res.method)
      setCode(EMPTY_CODE)
      if (res.method === 'email') {
        setTwoFactorNotice(
          res.email_code_sent
            ? `We sent a 6-digit code to ${twoFactorEmail}`
            : `A code was already sent to ${twoFactorEmail} — check your inbox`,
        )
        setSetupStage('email')
      } else {
        setSetupSecret(res.secret ?? '')
        setSetupQr(res.qr_code_data_uri ?? '')
        setSetupStage('totp')
      }
    } catch (err) {
      setGeneralError(err instanceof ApiError ? err.detail : 'Could not start setup.')
    } finally {
      setLoading(false)
    }
  }

  /**
   * "Send it again" during ENROLMENT, which is a different endpoint from the
   * one the login step uses — traced rather than assumed, because the
   * obvious choice is the wrong one:
   *
   *  - /auth/2fa/send-email-fallback checks `user.two_factor_enabled` and
   *    does nothing at all for someone who is still enrolling. It would
   *    return 200 and send no mail.
   *  - /auth/2fa/setup re-stages the same enrolment (harmless) and calls the
   *    mailer with force=False, so a code that is still live is NOT replaced
   *    — the one already in the inbox stays valid.
   *
   * So this cannot promise a fresh code, and does not: `email_code_sent`
   * says which of the two happened, and the copy follows it.
   */
  async function handleResendSetupCode() {
    await chooseMethod('email')
  }

  async function submitSetupCode(codeStr: string) {
    setCodeError('')
    setLoading(true)
    try {
      const res = await api.post<TwoFactorConfirmResponse>('/auth/2fa/confirm-setup', {
        pending_token: pendingToken,
        code: codeStr,
      })
      // Shown once, and nothing can read them back. The tokens are held
      // rather than used until the user says they have saved the codes —
      // redirecting on arrival would destroy them by design.
      setBackupCodes(res.backup_codes)
      setEnrolledTokens(res.tokens)
      setSetupStage('backup')
    } catch (err) {
      setCodeError(err instanceof ApiError ? err.detail : 'Invalid code. Please try again.')
      setCode(EMPTY_CODE)
    } finally {
      setLoading(false)
    }
  }

  async function handleSetupCodeSubmit(e: React.FormEvent) {
    e.preventDefault()
    const codeStr = code.join('')
    if (codeStr.length < 6) {
      setCodeError('Enter the 6-digit code')
      return
    }
    await submitSetupCode(codeStr)
  }

  /** Only after the user confirms they have the codes. */
  async function handleBackupCodesSaved() {
    if (!enrolledTokens?.access_token) {
      // confirm-setup returns tokens for a forced first login, so this is
      // not expected here — but sending them to a dead end would be worse
      // than asking them to sign in again with the factor they just set up.
      setStep('classic')
      setGeneralError('Two-factor authentication is set up. Please sign in.')
      return
    }
    setTokens(enrolledTokens.access_token, enrolledTokens.refresh_token)
    await useAuthStore.getState().fetchUser()
    router.replace('/projects')
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (activeStep === null) {
    // Site settings not in yet (only when the server-side seed failed).
    // Deliberately blank rather than a guessed screen: showing magic-code
    // sign-in to an instance that refuses it is the bug this avoids.
    return <div className="h-64 animate-pulse rounded-md bg-bg-tertiary/40" aria-hidden />
  }

  if (activeStep === '2fa-setup') {
    if (setupStage === 'backup') {
      // Shared with the settings page's own enrolment (§197) — the codes are
      // hashed the instant they are issued, so the acknowledgement gate is
      // the only thing standing between a user and having destroyed them.
      return (
        <div className="animate-slide-up">
          <BackupCodes codes={backupCodes ?? []} onAcknowledge={handleBackupCodesSaved} />
        </div>
      )
    }

    if (setupStage === 'totp') {
      return (
        <div className="animate-slide-up">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-text-primary mb-1">Set up your authenticator</h1>
            <p className="text-sm text-text-secondary">
              Scan this with your authenticator app, then enter the 6-digit code it shows.
            </p>
          </div>

          {setupQr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={setupQr}
              alt="Two-factor setup QR code"
              className="mx-auto mb-4 h-40 w-40 rounded-md bg-white p-2"
            />
          )}

          {setupSecret && (
            <p className="mb-6 text-center text-xs text-text-tertiary">
              Can&apos;t scan? Enter this key:{' '}
              <span className="font-mono text-text-secondary">{setupSecret}</span>
            </p>
          )}

          <form onSubmit={handleSetupCodeSubmit} className="flex flex-col gap-6">
            <CodeInput
              value={code}
              onChange={(next) => { setCode(next); setCodeError('') }}
              onComplete={submitSetupCode}
              invalid={!!codeError}
              autoFocus
            />
            {codeError && <p className="text-sm text-status-error -mt-3">{codeError}</p>}
            <Button type="submit" size="lg" loading={loading} className="w-full">
              Turn on two-factor
            </Button>
          </form>
        </div>
      )
    }

    if (setupStage === 'email') {
      return (
        <div className="animate-slide-up">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-text-primary mb-1">Confirm your email</h1>
            <p className="text-sm text-text-secondary">{twoFactorNotice}</p>
          </div>

          <form onSubmit={handleSetupCodeSubmit} className="flex flex-col gap-6">
            <CodeInput
              value={code}
              onChange={(next) => { setCode(next); setCodeError('') }}
              onComplete={submitSetupCode}
              invalid={!!codeError}
              autoFocus
            />
            {codeError && <p className="text-sm text-status-error -mt-3">{codeError}</p>}
            <Button type="submit" size="lg" loading={loading} className="w-full">
              Turn on two-factor
            </Button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={handleResendSetupCode}
              className="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Send it again
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="animate-slide-up">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text-primary mb-1">Set up two-factor sign-in</h1>
          <p className="text-sm text-text-secondary">
            This workspace requires a second step at sign-in. Choose how you&apos;d like to
            receive it.
          </p>
        </div>

        {generalError && (
          <div className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
            {generalError}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => chooseMethod('totp')}
            disabled={loading}
            className="rounded-md border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-border-focus disabled:opacity-60"
          >
            <span className="block text-sm font-medium text-text-primary">Authenticator app</span>
            <span className="block text-xs text-text-tertiary mt-0.5">
              Codes from an app on your phone. Works without a network connection.
            </span>
          </button>

          <button
            type="button"
            onClick={() => chooseMethod('email')}
            disabled={loading}
            className="rounded-md border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-border-focus disabled:opacity-60"
          >
            <span className="block text-sm font-medium text-text-primary">Email</span>
            <span className="block text-xs text-text-tertiary mt-0.5">
              A code sent to your inbox each time you sign in.
            </span>
          </button>
        </div>
      </div>
    )
  }

  if (activeStep === '2fa-code') {
    const byEmail = twoFactorMethod === 'email'
    return (
      <div className="animate-slide-up">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-text-primary mb-1">
            {byEmail ? 'Check your email' : 'Enter your code'}
          </h1>
          <p className="text-sm text-text-secondary">
            {byEmail
              ? twoFactorNotice || `We sent a 6-digit code to ${twoFactorEmail}`
              : 'Open your authenticator app and enter the 6-digit code.'}
          </p>
        </div>

        <form onSubmit={handleTwoFactorSubmit} className="flex flex-col gap-6">
          <CodeInput
            value={code}
            onChange={(next) => { setCode(next); setCodeError('') }}
            onComplete={submitTwoFactorCode}
            invalid={!!codeError}
            autoFocus
          />

          {codeError && <p className="text-sm text-status-error -mt-3">{codeError}</p>}

          <Button type="submit" size="lg" loading={loading} className="w-full">
            Verify code
          </Button>
        </form>

        {byEmail && (
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={handleResendLoginCode}
              className="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Resend code
            </button>
          </div>
        )}
      </div>
    )
  }

  if (activeStep === 'classic') {
    return (
      <div className="animate-slide-up">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-text-primary mb-1">Sign in with password</h1>
          <p className="text-sm text-text-secondary">Enter your email and password to continue.</p>
        </div>

        <form onSubmit={handleClassicLogin} className="flex flex-col gap-4">
          {(classicError || generalError) && (
            <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
              {classicError || generalError}
            </div>
          )}

          <Input
            label="Email address"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={classicEmail}
            onChange={(e) => setClassicEmail(e.target.value)}
          />

          <Input
            label="Password"
            type="password"
            placeholder="Your password"
            autoComplete="current-password"
            value={classicPassword}
            onChange={(e) => setClassicPassword(e.target.value)}
          />

          <Button type="submit" size="lg" loading={loading} className="mt-2 w-full">
            Sign in
          </Button>
        </form>

        {/* No way back to the magic-code screen on an instance that requires
            2FA: /auth/send-magic-code refuses every purpose but a password
            reset there (§195), so the link would lead to a button that
            always fails. */}
        {!requireTwoFactor && (
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => { setStep('email'); setClassicError('') }}
              className="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Back to magic link
            </button>
          </div>
        )}
      </div>
    )
  }

  const setPasswordBlock = passwordSubmitBlock({
    password,
    confirmPassword,
    strength: passwordStrength,
    policy: passwordPolicy,
  })

  if (activeStep === 'password') {
    return (
      <div className="animate-slide-up">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-text-primary mb-1">Create your password</h1>
          <p className="text-sm text-text-secondary">
            Set a password to secure your account going forward.
          </p>
        </div>

        <form onSubmit={handleSetPassword} className="flex flex-col gap-4">
          {generalError && (
            <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
              {generalError}
            </div>
          )}

          <PasswordField
            label="Password"
            value={password}
            onChange={(v) => { setPassword(v); setPasswordError('') }}
            // The address is all this screen knows about the person — there
            // is no session yet — and it is the token most likely to end up
            // inside the password.
            userInputs={[email]}
            onStrengthChange={setPasswordStrength}
            error={passwordError}
          />

          <Input
            label="Confirm password"
            type="password"
            placeholder="Repeat password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError('') }}
            // §202 — live, as soon as both fields differ.
            error={
              confirmPassword && password !== confirmPassword
                ? 'Passwords do not match'
                : undefined
            }
          />

          {/* §202 — shared with the other three password forms. Always says
              why it is blocked, and a pending or unavailable score does not
              block at all. */}
          <PasswordSubmitNote reason={setPasswordBlock} />

          <Button
            type="submit"
            size="lg"
            loading={loading}
            className="mt-2 w-full"
            disabled={!!setPasswordBlock}
          >
            Set password &amp; continue
          </Button>
        </form>
      </div>
    )
  }

  if (activeStep === 'code') {
    return (
      <div className="animate-slide-up">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-text-primary mb-1">Check your email</h1>
          <p className="text-sm text-text-secondary">
            We sent a 6-digit code to{' '}
            <span className="text-text-primary font-medium">{email}</span>
          </p>
        </div>

        <form onSubmit={handleVerifyCode} className="flex flex-col gap-6">
          <CodeInput
            value={code}
            onChange={(next) => { setCode(next); setCodeError('') }}
            onComplete={submitCode}
            invalid={!!codeError}
            autoFocus
          />

          {codeError && (
            <p className="text-sm text-status-error -mt-3">{codeError}</p>
          )}

          <Button type="submit" size="lg" loading={loading} className="w-full">
            Verify code
          </Button>
        </form>

        <div className="mt-6 text-center space-y-2">
          <button
            type="button"
            onClick={() => { setStep('email'); setCode(EMPTY_CODE); setCodeError('') }}
            className="block w-full text-sm text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Use a different email
          </button>
        </div>
      </div>
    )
  }

  // Step 1: Email
  return (
    <div className="animate-slide-up">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-text-primary mb-1">Sign in to FreeFrame</h1>
        <p className="text-sm text-text-secondary">
          Enter your email and we&apos;ll send you a sign-in code.
        </p>
      </div>

      <form onSubmit={handleSendCode} className="flex flex-col gap-4">
        {generalError && (
          <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
            {generalError}
          </div>
        )}

        <Input
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError('') }}
          error={emailError}
        />

        <Button type="submit" size="lg" loading={loading} className="mt-2 w-full">
          Send magic code
        </Button>
      </form>

      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => { setStep('classic'); setGeneralError('') }}
          className="text-sm text-text-tertiary hover:text-text-secondary transition-colors"
        >
          Sign in with password instead
        </button>
      </div>
    </div>
  )
}
