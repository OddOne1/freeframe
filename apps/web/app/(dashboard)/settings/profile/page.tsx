'use client'

import * as React from 'react'
import { User, Camera } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { AvatarCropper } from '@/components/shared/avatar-cropper'

export default function ProfilePage() {
  const { user, fetchUser } = useAuthStore()

  const [name, setName] = React.useState(user?.name ?? '')
  const [isSavingProfile, setIsSavingProfile] = React.useState(false)
  const [profileError, setProfileError] = React.useState('')
  const [profileSuccess, setProfileSuccess] = React.useState(false)

  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [isSavingPassword, setIsSavingPassword] = React.useState(false)
  const [passwordError, setPasswordError] = React.useState('')
  const [passwordSuccess, setPasswordSuccess] = React.useState(false)
  const [avatarFile, setAvatarFile] = React.useState<File | null>(null)
  const [cropperOpen, setCropperOpen] = React.useState(false)
  const [isSavingAvatar, setIsSavingAvatar] = React.useState(false)
  const [avatarError, setAvatarError] = React.useState('')
  const avatarInputRef = React.useRef<HTMLInputElement>(null)

  // Sync name when user loads
  React.useEffect(() => {
    if (user?.name) setName(user.name)
  }, [user?.name])

  async function handleProfileSave(e: React.FormEvent) {
    e.preventDefault()
    setProfileError('')
    setProfileSuccess(false)
    if (!name.trim()) {
      setProfileError('Name is required')
      return
    }
    setIsSavingProfile(true)
    try {
      await api.patch(`/users/${user?.id}`, { name: name.trim() })
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
    const { upload_url, avatar_url } = await api.post<{ upload_url: string; key: string; avatar_url: string }>(
      '/users/me/avatar-upload',
    )
    await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: blob,
    })
    await api.patch(`/users/${user?.id}`, { avatar_url })
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
    setPasswordSuccess(false)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required')
      return
    }
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
      await api.patch('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordSuccess(true)
      setTimeout(() => setPasswordSuccess(false), 3000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to change password'
      setPasswordError(message)
    } finally {
      setIsSavingPassword(false)
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
          <Avatar src={user?.avatar_url} name={user?.name} size="lg" />
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
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-xs font-medium text-text-secondary">
              Full Name
            </label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
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
            <label htmlFor="currentPassword" className="text-xs font-medium text-text-secondary">
              Current Password
            </label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="newPassword" className="text-xs font-medium text-text-secondary">
              New Password
            </label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Min 8 characters"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="confirmPassword" className="text-xs font-medium text-text-secondary">
              Confirm New Password
            </label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat new password"
            />
          </div>

          {passwordError && (
            <p className="text-xs text-status-error">{passwordError}</p>
          )}
          {passwordSuccess && (
            <p className="text-xs text-status-success">Password changed successfully.</p>
          )}

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={isSavingPassword}
          >
            Change Password
          </Button>
        </form>
      </section>
    </div>
  )
}
