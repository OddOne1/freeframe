'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { User, Camera, LogOut } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { AvatarCropper } from '@/components/shared/avatar-cropper'
import { setTokens } from '@/lib/auth'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'
import { TwoFactorSettings } from '@/components/auth/two-factor-settings'
import type {
  LoginResponse,
  SetPasswordResponse,
  VerifyCodeResponse,
  TwoFactorMethod,
} from '@/types'

export default function ProfilePage() {
  const { user, fetchUser, logout } = useAuthStore()

  const [firstName, setFirstName] = React.useState(user?.first_name ?? '')
  const [lastName, setLastName] = React.useState(user?.last_name ?? '')
  const [isSavingProfile, setIsSavingProfile] = React.useState(false)
  const [profileError, setProfileError] = React.useState('')
  const [profileSuccess, setProfileSuccess] = React.useState(false)

  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [isSavingPassword, setIsSavingPassword] = React.useState(false)
  const [passwordError, setPasswordError] = React.useState('')
  const [passwordSuccess, setPasswordSuccess] = React.useState(false)
  const [pwCodeDialogOpen, setPwCodeDialogOpen] = React.useState(false)
  const [pwCode, setPwCode] = React.useState<string[]>(EMPTY_CODE)
  const [codeError, setCodeError] = React.useState('')
  const [isVerifyingCode, setIsVerifyingCode] = React.useState(false)
  // §197 — a 2FA-enrolled user's emailed reset code does not, on its own,
  // produce a session (§193 gates it), so the password change has a second
  // step for them. The pending token is the whole of what carries across it.
  const [pwPendingToken, setPwPendingToken] = React.useState('')
  const [pw2faMethod, setPw2faMethod] = React.useState<TwoFactorMethod | null>(null)
  const [pw2faDialogOpen, setPw2faDialogOpen] = React.useState(false)
  const [pw2faCode, setPw2faCode] = React.useState<string[]>(EMPTY_CODE)
  const [avatarFile, setAvatarFile] = React.useState<File | null>(null)
  const [cropperOpen, setCropperOpen] = React.useState(false)
  const [isSavingAvatar, setIsSavingAvatar] = React.useState(false)
  const [avatarError, setAvatarError] = React.useState('')
  const avatarInputRef = React.useRef<HTMLInputElement>(null)

  // Sync name fields when user loads
  React.useEffect(() => {
    if (user?.first_name !== undefined) setFirstName(user.first_name ?? '')
    if (user?.last_name) setLastName(user.last_name)
  }, [user?.first_name, user?.last_name])

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileError('')
    setProfileSuccess(false)
    if (!lastName.trim()) {
      setProfileError('Last name is required')
      return
    }
    setIsSavingProfile(true)
    try {
      await api.patch('/users/' + user?.id, {
        first_name: firstName.trim() || null,
        last_name: lastName.trim(),
      })
      await fetchUser()
      setProfileSuccess(true)
      setTimeout(() => setProfileSuccess(false), 3000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save profile'
      setProfileError(message)
    } finally {
      setIsSavingProfile(false)
    }
  }

  function handleAvatarFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
  const f = e.target.files?.[0]
  e.target.value = ''
  if (!f) return
  setAvatarError('')
  setAvatarFile(f)
  setCropperOpen(true)
}

async function handleAvatarCropped(blob: Blob) {
  setIsSavingAvatar(true)
  setAvatarError('')
  try {
    // Uploaded straight through the API (matches the project-poster
    // upload pattern in project-settings-dialog.tsx) rather than a
    // presigned browser->S3 PUT -- see apps/api/routers/users.py::
    // upload_avatar for why: a direct presigned URL to AIStor's LAN-only
    // HTTP endpoint gets blocked as mixed content on this HTTPS page in
    // any browser without an override already set, which is what broke
    // this in Safari. One request now does the upload and persists
    // avatar_url server-side, instead of upload-URL + PUT + PATCH.
    const formData = new FormData()
    formData.append('file', blob, 'avatar.webp')
    await api.upload('/users/me/avatar', formData)
    await fetchUser()
    setCropperOpen(false)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to save avatar'
    setAvatarError(message)
  } finally {
    setIsSavingAvatar(false)
  }
}

  async function handlePasswordSave(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError('')
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }
    setIsSavingPassword(true)
    try {
      await api.post('/auth/send-magic-code', { email: user?.email, purpose: 'password_reset' })
      setPwCodeDialogOpen(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send verification code'
      setPasswordError(message)
    } finally {
      setIsSavingPassword(false)
    }
  }

  /** Sets the password and clears the form. Shared by both routes into it —
   *  straight through for a user without 2FA, and after the second factor
   *  for a user with it. */
  async function finishPasswordChange(tokens: VerifyCodeResponse) {
    setTokens(tokens.access_token, tokens.refresh_token)
    const res = await api.post<SetPasswordResponse>('/auth/set-password', {
      password: newPassword,
    })
    // §199 — setting a password bumps token_version, which ends every
    // session this user holds INCLUDING this tab's. The pair the response
    // carries is the replacement; without adopting it, the next request from
    // this page would 401 and the user would be signed out by the act of
    // changing their own password. Guarded rather than unpacked blind — the
    // §196 rule about not storing `undefined` over working tokens.
    if (res?.access_token && res?.refresh_token) {
      setTokens(res.access_token, res.refresh_token)
    }
    setPwCodeDialogOpen(false)
    setPw2faDialogOpen(false)
    setPwCode(EMPTY_CODE)
    setPw2faCode(EMPTY_CODE)
    setPwPendingToken('')
    setNewPassword('')
    setConfirmPassword('')
    setPasswordSuccess(true)
    setTimeout(() => setPasswordSuccess(false), 3000)
  }

  async function handleConfirmPasswordCode(value?: string) {
    const entered = value ?? pwCode.join('')
    setCodeError('')
    if (entered.length < 6) {
      setCodeError('Enter the 6-digit code')
      return
    }
    setIsVerifyingCode(true)
    try {
      // §196's rule, on the surface it deliberately left alone: branch on
      // `requires_2fa`, never on whether a token happens to be present.
      // Unpacking this unguarded is what used to overwrite an enrolled
      // user's working session with `undefined` halfway through a password
      // change.
      //
      // §197 — `purpose` names the pool this code was minted into. Reset
      // codes no longer share the login pool, so verifying without it would
      // check a slot this code was never written to.
      const res = await api.post<LoginResponse>('/auth/verify-magic-code', {
        email: user?.email,
        code: entered,
        purpose: 'password_reset',
      })

      if (res.requires_2fa) {
        // Correct, not a failure: /auth/verify-magic-code hands back a real
        // session, so an enrolled user still has to clear the second factor
        // before one is issued. Nothing is stored until they do.
        setPwPendingToken(res.pending_token)
        setPw2faMethod(res.method)
        setPwCode(EMPTY_CODE)
        setPw2faCode(EMPTY_CODE)
        setPwCodeDialogOpen(false)
        setPw2faDialogOpen(true)
        return
      }

      await finishPasswordChange(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid or expired code'
      setCodeError(message)
    } finally {
      setIsVerifyingCode(false)
    }
  }

  async function handleConfirmSecondFactor(value?: string) {
    const entered = value ?? pw2faCode.join('')
    setCodeError('')
    if (entered.length < 6) {
      setCodeError('Enter the 6-digit code')
      return
    }
    setIsVerifyingCode(true)
    try {
      const res = await api.post<VerifyCodeResponse>('/auth/2fa/verify-login', {
        pending_token: pwPendingToken,
        code: entered,
      })
      await finishPasswordChange(res)
    } catch (err: unknown) {
      setCodeError(err instanceof Error ? err.message : 'Invalid code')
      setPw2faCode(EMPTY_CODE)
    } finally {
      setIsVerifyingCode(false)
    }
  }

  return (
    <div className="p-6 max-w-xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <User className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Profile</h1>
          <p className="text-sm text-text-secondary">
            Manage your profile and account settings
          </p>
        </div>
      </div>

      {/* Profile section */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-2">
          Profile
        </h2>

        <div className="flex items-center gap-4">
          <button type="button" onClick={() => avatarInputRef.current?.click()} className="group relative inline-flex shrink-0 rounded-full">
          <Avatar src={user?.avatar_url} name={user?.name} colorSeed={user?.id} size="lg" />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Camera className="h-4 w-4 text-white" />
          </span>
          </button>
          <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarFileSelected} />
          <div>
          <p className="text-sm font-medium text-text-primary">{user?.name ?? 'Loading...'}</p>
          <p className="text-xs text-text-tertiary">{user?.email ?? ''}</p>
          {avatarError && <p className="mt-1 text-xs text-status-error">{avatarError}</p>}
          </div>
          </div>
          <AvatarCropper file={avatarFile} open={cropperOpen} onOpenChange={setCropperOpen} onCropped={handleAvatarCropped} saving={isSavingAvatar} />

        <form onSubmit={handleProfileSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="firstName" className="text-xs font-medium text-text-secondary">
                First Name
              </label>
              <Input
                id="firstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="lastName" className="text-xs font-medium text-text-secondary">
                Last Name
              </label>
              <Input
                id="lastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Required"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-xs font-medium text-text-secondary">
              Email
            </label>
            <Input
              id="email"
              value={user?.email ?? ''}
              disabled
              className="opacity-60 cursor-not-allowed"
            />
            <p className="text-2xs text-text-tertiary">
              Email cannot be changed. Contact your admin for help.
            </p>
          </div>

          {profileError && (
            <p className="text-xs text-status-error">{profileError}</p>
          )}
          {profileSuccess && (
            <p className="text-xs text-status-success">Profile saved successfully.</p>
          )}

          <Button type="submit" variant="primary" size="sm" loading={isSavingProfile}>
            Save Profile
          </Button>
        </form>
      </section>

      {/* Password section */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary border-b border-border pb-2">
          Change Password
        </h2>

        <form onSubmit={handlePasswordSave} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="newPassword" className="text-xs font-medium text-text-secondary">New Password</label>
            <Input id="newPassword" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 characters" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="confirmPassword" className="text-xs font-medium text-text-secondary">Confirm New Password</label>
            <Input id="confirmPassword" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Repeat new password" />
          </div>
          {passwordError && <p className="text-xs text-status-error">{passwordError}</p>}
          {passwordSuccess && <p className="text-xs text-status-success">Password changed successfully.</p>}
          <Button type="submit" variant="secondary" size="sm" loading={isSavingPassword}>Save Password</Button>
        </form>
      </section>

      <TwoFactorSettings />

      {/* Log out lives here now that the sidebar avatar is a plain link
          rather than a menu (§46). Removing the popup should not remove the
          only way out. */}
      <section className="rounded-lg border border-border bg-bg-secondary p-5">
        <h2 className="text-sm font-semibold text-text-primary">Session</h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Signed in as {user?.email ?? 'this account'}.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={logout}
          className="mt-4 text-status-error hover:text-status-error"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </Button>
      </section>

      <Dialog.Root open={pwCodeDialogOpen} onOpenChange={setPwCodeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-xl p-6">
            <Dialog.Title className="text-sm font-semibold text-text-primary">Confirm password change</Dialog.Title>
            <Dialog.Description className="mt-1.5 text-sm text-text-tertiary leading-relaxed">
              We emailed a verification code to {user?.email}. Enter it below to finish changing your password. If you did not request this, ignore the email and your password will stay the same.
            </Dialog.Description>
            <div className="mt-4 space-y-2">
              {/* The shared digit boxes (§196), rather than a seventh
                  free-text code field. */}
              <CodeInput
                value={pwCode}
                onChange={(next) => { setPwCode(next); setCodeError('') }}
                onComplete={(code) => handleConfirmPasswordCode(code)}
                invalid={!!codeError}
                autoFocus
              />
              {codeError && <p className="text-xs text-status-error">{codeError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setPwCodeDialogOpen(false)} disabled={isVerifyingCode}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => handleConfirmPasswordCode()} loading={isVerifyingCode}>Confirm</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Second factor, for an enrolled user finishing a password change. */}
      <Dialog.Root open={pw2faDialogOpen} onOpenChange={setPw2faDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-xl p-6">
            <Dialog.Title className="text-sm font-semibold text-text-primary">One more step</Dialog.Title>
            <Dialog.Description className="mt-1.5 text-sm text-text-tertiary leading-relaxed">
              {pw2faMethod === 'email'
                ? 'Enter the sign-in code we emailed you.'
                : 'Enter the 6-digit code from your authenticator app.'}
              {' '}A backup code works too.
            </Dialog.Description>
            <div className="mt-4 space-y-2">
              <CodeInput
                value={pw2faCode}
                onChange={(next) => { setPw2faCode(next); setCodeError('') }}
                onComplete={(code) => handleConfirmSecondFactor(code)}
                invalid={!!codeError}
                autoFocus
              />
              {codeError && <p className="text-xs text-status-error">{codeError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setPw2faDialogOpen(false)} disabled={isVerifyingCode}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => handleConfirmSecondFactor()} loading={isVerifyingCode}>Confirm</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
