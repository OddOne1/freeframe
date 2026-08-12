'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { X, ImagePlus, Globe, Lock, Star, Users } from 'lucide-react'
import { cn, resolveApiMediaUrl, formatBytes } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import type { Project } from '@/types'

const GB = 1024 ** 3

interface ProjectSettingsDialogProps {
  /** Supplied by whichever parent renders both dialogs. Rendered
   *  unconditionally within Settings: today, opening Settings at all
   *  already requires isProjectAdmin, which is the same rule that gates
   *  managing members — so anyone who can see this can already use it.
   *  If those two gates ever diverge, this needs its own check. */
  onOpenMembers?: () => void
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated,
  onOpenMembers,
}: ProjectSettingsDialogProps) {
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description || '')
  // §14. Locked once the project's first upload has frozen the prefix.
  // `storage_locked` comes from the server rather than being re-derived
  // here, and the server rejects a locked change regardless — this only
  // saves the user a pointless round-trip.
  const [storageSlug, setStorageSlug] = React.useState(project.storage_slug || '')
  const [slugError, setSlugError] = React.useState('')
  const storageLocked = Boolean(project.storage_locked)
  const [isPublic, setIsPublic] = React.useState(project.is_public ?? false)
  const [posterPreview, setPosterPreview] = React.useState<string | null>(resolveApiMediaUrl(project.poster_url))
  const [posterFile, setPosterFile] = React.useState<File | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [ratingsVisible, setRatingsVisible] = React.useState(project.ratings_visible_to_all ?? false)
  const [savingRatingsVisible, setSavingRatingsVisible] = React.useState(false)
  const [storageLimitGB, setStorageLimitGB] = React.useState<string>(
    project.storage_limit_bytes ? String(Math.round(project.storage_limit_bytes / (1024 ** 3))) : ''
  )
  const [storageError, setStorageError] = React.useState('')
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Same two numbers OwnedProjectsView/EditableStorageLimit already compute
  // (settings/projects/page.tsx) -- personal total from the auth store,
  // other-owned-projects allocation from /projects filtered to role==owner
  // excluding this project, kept consistent with that surface on purpose.
  const { user } = useAuthStore()
  const { data: ownedProjects } = useSWR<Project[]>('/projects', () => api.get<Project[]>('/projects'))
  const personalTotalBytes = user?.storage_limit_bytes ?? null
  const otherAllocatedBytes = React.useMemo(
    () =>
      (ownedProjects ?? [])
        .filter((p) => p.role === 'owner' && p.id !== project.id)
        .reduce((sum, p) => sum + (p.storage_limit_bytes ?? 0), 0),
    [ownedProjects, project.id],
  )
  const remainingBytes = personalTotalBytes === null ? null : Math.max(personalTotalBytes - otherAllocatedBytes, 0)

  // Sync state when project changes
  React.useEffect(() => {
    setName(project.name)
    setDescription(project.description || '')
    setStorageLimitGB(project.storage_limit_bytes ? String(Math.round(project.storage_limit_bytes / (1024 ** 3))) : '')
    setIsPublic(project.is_public ?? false)
    setRatingsVisible(project.ratings_visible_to_all ?? false)
    setPosterPreview(resolveApiMediaUrl(project.poster_url))
    setPosterFile(null)
    setStorageError('')
  }, [project])

  const handlePosterSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPosterFile(file)
    setPosterPreview(URL.createObjectURL(file))
  }

  const handleToggleRatingsVisible = async (next: boolean) => {
    const previous = ratingsVisible
    setRatingsVisible(next)
    setSavingRatingsVisible(true)
    try {
      await api.patch(`/projects/${project.id}`, { ratings_visible_to_all: next })
      onUpdated()
    } catch {
      setRatingsVisible(previous)
    } finally {
      setSavingRatingsVisible(false)
    }
  }

  const handleSave = async () => {
    setStorageError('')
    setSlugError('')
    const trimmedSlug = storageSlug.trim().toLowerCase()
    // Same rule as validate_slug server-side: case is normalised, but
    // spaces and punctuation are rejected rather than silently rewritten,
    // because this string ends up visible in the bucket.
    if (!storageLocked && trimmedSlug && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(trimmedSlug)) {
      setSlugError('Lowercase letters, numbers and single underscores only — no spaces, and not at either end.')
      return
    }
    if (!storageLocked && trimmedSlug.length > 40) {
      setSlugError('Must be at most 40 characters.')
      return
    }
    const trimmedStorage = storageLimitGB.trim()
    if (trimmedStorage && (Number.isNaN(parseFloat(trimmedStorage)) || parseFloat(trimmedStorage) <= 0)) {
      setStorageError('Enter a positive number, or leave empty to use your remaining storage.')
      return
    }
    const storageBytes = trimmedStorage ? Math.round(parseFloat(trimmedStorage) * GB) : null
    // Mirrors _check_owner_storage_allocation server-side (routers/projects.py)
    // so the UI can reject before the round-trip -- the server still
    // re-validates, this is purely a faster/clearer error for the common case.
    if (storageBytes !== null && personalTotalBytes !== null) {
      const projected = otherAllocatedBytes + storageBytes
      if (projected > personalTotalBytes) {
        setStorageError(
          `Exceeds your ${formatBytes(personalTotalBytes)} total by ${formatBytes(projected - personalTotalBytes)}.`,
        )
        return
      }
    }

    setSaving(true)
    try {
      // Upload poster if changed
      if (posterFile) {
        const formData = new FormData()
        formData.append('file', posterFile)
        await api.upload(`/projects/${project.id}/poster`, formData)
      }

      // Update project fields
      await api.patch(`/projects/${project.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        is_public: isPublic,
        storage_limit_bytes: storageBytes,
        // Omitted entirely once locked: sending an unchanged value would
        // still trip the server's 409, failing a save of unrelated fields.
        ...(storageLocked ? {} : { storage_slug: trimmedSlug || null }),
      })

      onUpdated()
      onOpenChange(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save changes'
      // A taken slug is a slug problem, so it belongs under that field
      // rather than in the storage-limit error slot.
      if (/slug/i.test(message)) setSlugError(message)
      else setStorageError(message)
    } finally {
      setSaving(false)
    }
  }

  const gradient = getGradientForProject(project.id)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <Dialog.Title className="text-base font-semibold text-text-primary">
              Project settings
            </Dialog.Title>
            <Dialog.Close className="text-text-tertiary hover:text-text-primary transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="p-6">
            <div className="flex gap-6">
              {/* Left: Poster + Name */}
              <div className="flex flex-col items-center gap-3 w-56 shrink-0">
                {/* Poster area */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="relative w-full aspect-square rounded-xl overflow-hidden border-2 border-dashed border-border hover:border-accent/50 transition-colors group"
                >
                  {posterPreview ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={posterPreview} alt="Poster" className="h-full w-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <ImagePlus className="h-6 w-6 text-white" />
                      </div>
                    </>
                  ) : (
                    <div className={cn('h-full w-full bg-gradient-to-br flex items-center justify-center', gradient)}>
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/20 text-white/80 group-hover:bg-black/30 transition-colors">
                        <ImagePlus className="h-6 w-6" />
                      </div>
                    </div>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handlePosterSelect}
                />

                {/* Project name input */}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full text-center text-sm font-semibold text-text-primary bg-bg-tertiary rounded-lg px-3 py-2 border border-border focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
                  placeholder="Project name"
                />
              </div>

              {/* Right: Settings */}
            <div className="flex-1 space-y-5">
              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Description</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional project description..."
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
                />
              </div>

              {/* Storage folder name (§14) */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-tertiary uppercase tracking-wider">
                  Storage folder name
                </label>
                <input
                  type="text"
                  value={storageSlug}
                  disabled={storageLocked}
                  onChange={(e) => { setStorageSlug(e.target.value); setSlugError('') }}
                  placeholder="auto-generated from the project name"
                  className={cn(
                    'w-full rounded-lg border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary font-mono transition-colors',
                    'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
                    slugError ? 'border-status-error' : 'border-border',
                    storageLocked && 'opacity-60 cursor-not-allowed',
                  )}
                />
                {slugError ? (
                  <p className="text-2xs text-status-error">{slugError}</p>
                ) : storageLocked ? (
                  <p className="text-2xs text-text-tertiary">
                    Locked — set when this project&apos;s first upload started, so
                    that already-stored files keep matching it.{' '}
                    {project.storage_date_prefix && project.storage_slug && (
                      <span className="font-mono text-text-secondary">
                        {project.storage_date_prefix}_{project.storage_slug}
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-2xs text-text-tertiary">
                    Used to name this project&apos;s folder in storage. Lowercase
                    letters, numbers and underscores. Editable until the first
                    upload, then locked.
                  </p>
                )}
              </div>

              {/* Public / Private toggle */}
              <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg mt-0.5',
                    isPublic ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary',
                  )}>
                    {isPublic ? <Globe className="h-4.5 w-4.5" /> : <Lock className="h-4.5 w-4.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">
                        {isPublic ? 'Public Project' : 'Private Project'}
                      </span>
                      <Switch.Root
                        checked={isPublic}
                        onCheckedChange={setIsPublic}
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
                          isPublic ? 'bg-accent' : 'bg-bg-tertiary',
                        )}
                      >
                        <Switch.Thumb className={cn(
                          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          isPublic ? 'translate-x-[18px]' : 'translate-x-0.5',
                          'mt-0.5',
                        )} />
                      </Switch.Root>
                    </div>
                    <p className="text-xs text-text-tertiary mt-0.5">
                      {isPublic
                        ? 'All users in the system can view this project.'
                        : 'Only invited members can access this project.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Ratings visibility — owner/superadmin only setting, saves
                  immediately on toggle rather than waiting for the main Save
                  button (see handleToggleRatingsVisible). */}
              <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
                <div className="flex items-start gap-3">
                  <div className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg mt-0.5',
                    ratingsVisible ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary',
                  )}>
                    <Star className="h-4.5 w-4.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-text-primary">
                        Show ratings to everyone
                      </span>
                      <Switch.Root
                        checked={ratingsVisible}
                        onCheckedChange={handleToggleRatingsVisible}
                        disabled={savingRatingsVisible}
                        className={cn(
                          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                          ratingsVisible ? 'bg-accent' : 'bg-bg-tertiary',
                        )}
                      >
                        <Switch.Thumb className={cn(
                          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                          ratingsVisible ? 'translate-x-[18px]' : 'translate-x-0.5',
                          'mt-0.5',
                        )} />
                      </Switch.Root>
                    </div>
                    <p className="text-xs text-text-tertiary mt-0.5">
                      {ratingsVisible
                        ? 'Everyone can see the overall rating and who voted. Off by default — only you and superadmins see it otherwise.'
                        : 'Only you and superadmins see the overall rating and voter breakdown. Everyone else only sees their own vote.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Storage limit */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Storage Limit (GB)</label>
                <input
                  type="number"
                  min="1"
                  value={storageLimitGB}
                  onChange={(e) => {
                    setStorageLimitGB(e.target.value)
                    setStorageError('')
                  }}
                  placeholder="Unlimited"
                  className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
                />
                {personalTotalBytes !== null && (
                  <p className="text-xs text-text-tertiary">
                    {formatBytes(remainingBytes ?? 0)} remaining of your {formatBytes(personalTotalBytes)} total.
                  </p>
                )}
                <p className="text-xs text-text-tertiary">
                  {personalTotalBytes === null
                    ? 'Leave empty for unlimited storage.'
                    : `Leave empty to use your remaining storage (~${formatBytes(remainingBytes ?? 0)}).`}
                </p>
                {storageError && <p className="text-xs text-status-error">{storageError}</p>}
              </div>
            </div>
          </div>
        </div>

          {/* Footer */}
          <div className="flex items-center gap-2 px-6 py-4 border-t border-border">
            {/* Unconditional within Settings -- see the prop's doc comment:
                opening Settings already requires isProjectAdmin, the same
                rule that gates managing members. */}
            {onOpenMembers && (
              <button
                type="button"
                onClick={onOpenMembers}
                className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary font-medium transition-colors"
              >
                <Users className="h-3.5 w-3.5" />
                Members
              </button>
            )}
            <div className="flex-1" />
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">Cancel</Button>
            </Dialog.Close>
            <Button size="sm" onClick={handleSave} loading={saving} disabled={!name.trim()}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
