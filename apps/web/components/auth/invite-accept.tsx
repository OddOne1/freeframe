'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordField } from '@/components/auth/password-field'
import { PasswordSubmitNote } from '@/components/auth/password-submit-note'
import { passwordSubmitBlock, usePasswordPolicy } from '@/lib/password-policy'
import type { AuthTokens, OrgRole, PasswordStrength } from '@/types'

/**
 * What GET /auth/invite/{token} actually returns.
 *
 * §199 — `org_name` is newly populated; it was declared on the backend's
 * response model and never filled, so this card rendered an empty line
 * where the instance name belongs.
 *
 * `inviter_name` and `role` were never on that endpoint AT ALL — not
 * declared, not returned — and they cannot be: `users` has no `invited_by`
 * column and the invite carries no role (roles are per-project in this app,
 * and /users/invite does not take one). They are typed optional here so the
 * card can omit the line rather than render "Invited by  as ". Adding them
 * for real needs a schema change and is deliberately out of §199's scope.
 */
interface InviteDetails {
  email: string
  org_name: string | null
  inviter_name?: string | null
  role?: OrgRole | null
}

interface InviteAcceptProps {
  token: string
}

interface FormErrors {
  name?: string
  password?: string
  confirmPassword?: string
  general?: string
}

function validate(name: string, password: string, confirmPassword: string): FormErrors {
  const errors: FormErrors = {}
  if (!name.trim()) errors.name = 'Name is required'
  // §200 — the `length < 8` rule is gone. It was a browser-only check that
  // the server never shared, and /auth/accept-invite now runs the real
  // policy: twelve characters, all four character classes, not in the
  // common-password blocklist, not containing the invitee's own name or
  // address, and a strength score. PasswordField shows all of that live and
  // gates the submit button; whatever gets past it comes back as a server
  // error, which is rendered in `errors.general`.
  if (!password) errors.password = 'Password is required'
  if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match'
  return errors
}

export function InviteAccept({ token }: InviteAcceptProps) {
  const router = useRouter()
  const [invite, setInvite] = useState<InviteDetails | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteLoading, setInviteLoading] = useState(true)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [strength, setStrength] = useState<PasswordStrength | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const policy = usePasswordPolicy()

  // §202 — one shared rule, and it always produces a sentence when it blocks.
  // The old condition was `!strength?.meetsPolicy || !confirmPassword`, which
  // was silently permanently true on this page: `strength` stayed null because
  // the dictionary loader threw, and nothing on screen said so.
  const submitBlock = passwordSubmitBlock({
    password,
    confirmPassword,
    strength,
    policy,
  })

  useEffect(() => {
    async function fetchInvite() {
      try {
        const data = await api.get<InviteDetails>(`/auth/invite/${token}`)
        setInvite(data)
      } catch (err) {
        if (err instanceof ApiError) {
          setInviteError(err.status === 404 ? 'This invite link is invalid or has expired.' : err.detail)
        } else {
          setInviteError('Failed to load invite details.')
        }
      } finally {
        setInviteLoading(false)
      }
    }
    fetchInvite()
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validation = validate(name, password, confirmPassword)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    setSubmitting(true)
    setErrors({})
    try {
      const res = await api.post<AuthTokens>('/auth/accept-invite', {
        token,
        name,
        password,
      })
      setTokens(res.access_token, res.refresh_token)
      await useAuthStore.getState().fetchUser()
      router.replace('/')
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ general: err.detail })
      } else {
        setErrors({ general: 'Something went wrong. Please try again.' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (inviteLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  if (inviteError) {
    return (
      <div className="text-center py-8">
        <div className="mb-4 mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-error/15">
          <svg className="h-6 w-6 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-2">Invalid invite</h2>
        <p className="text-sm text-text-secondary">{inviteError}</p>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Invite card */}
      {invite && (
        <div className="mb-8 rounded-lg border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-tertiary uppercase tracking-wider mb-2">You&apos;ve been invited to</p>
          <p className="text-base font-semibold text-text-primary mb-1">
            {invite.org_name || 'FreeFrame'}
          </p>
          {invite.inviter_name && (
            <p className="text-sm text-text-secondary">
              Invited by <span className="text-text-primary">{invite.inviter_name}</span>
              {invite.role && (
                <> as <span className="capitalize text-text-primary">{invite.role}</span></>
              )}
            </p>
          )}
          <p className="text-sm text-text-tertiary mt-1">{invite.email}</p>
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-text-primary mb-1">Accept invite</h1>
        <p className="text-sm text-text-secondary">Set up your account to get started.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {errors.general && (
          <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
            {errors.general}
          </div>
        )}

        <Input
          label="Full name"
          type="text"
          placeholder="Alex Johnson"
          autoComplete="name"
          value={name}
          onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: undefined })) }}
          error={errors.name}
        />

        <PasswordField
          label="Password"
          value={password}
          onChange={(v) => { setPassword(v); setErrors((p) => ({ ...p, password: undefined })) }}
          // Both are things the server will reject the password for
          // containing, and both are known here before any session exists.
          userInputs={[name, invite?.email ?? '', invite?.org_name ?? '']}
          onStrengthChange={setStrength}
          error={errors.password}
        />

        <Input
          label="Confirm password"
          type="password"
          placeholder="Repeat password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setErrors((p) => ({ ...p, confirmPassword: undefined })) }}
          // §202 — live, as soon as both fields have something and differ,
          // rather than only after a submit that used to be unreachable.
          error={
            errors.confirmPassword ??
            (confirmPassword && password !== confirmPassword
              ? 'Passwords do not match'
              : undefined)
          }
        />

        <PasswordSubmitNote reason={submitBlock} />

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          className="mt-2 w-full"
          disabled={!!submitBlock}
        >
          Create account &amp; join
        </Button>
      </form>
    </div>
  )
}
