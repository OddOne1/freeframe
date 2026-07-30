'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { SwatchBook, Upload, Trash2, Share2, Loader2, MoreHorizontal, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/empty-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { Lut, Project } from '@/types'

export default function LutsSettingsPage() {
  const { data: luts, isLoading, mutate } = useSWR<Lut[]>(
    '/me/luts',
    (key: string) => api.get<Lut[]>(key),
  )
  // Sharing targets: only projects the user is actually a member of.
  const { data: projects } = useSWR<Project[]>(
    '/projects',
    (key: string) => api.get<Project[]>(key),
  )

  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<Lut | null>(null)
  const [sharing, setSharing] = React.useState<Record<string, string>>({})

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      await api.upload<Lut>('/me/luts', form)
      await mutate()
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : ''
      setError(msg || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    await api.delete(`/me/luts/${target.id}`)
    await mutate()
  }

  async function handleShare(lut: Lut, project: Project) {
    setSharing((s) => ({ ...s, [lut.id]: project.id }))
    try {
      await api.post(`/projects/${project.id}/luts/${lut.id}/share`, {})
    } finally {
      // Cleared regardless: the tick is a transient confirmation, and a
      // failure should not leave a permanent "shared" marker.
      setTimeout(() => setSharing((s) => {
        const next = { ...s }
        delete next[lut.id]
        return next
      }), 1500)
    }
  }

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <SwatchBook className="h-5 w-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text-primary">LUTs</h1>
          <p className="text-sm text-text-secondary">
            Your personal color LUTs, available in every project you work on.
          </p>
        </div>
        <input ref={fileRef} type="file" accept=".cube" onChange={handleFile} className="hidden" />
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload .cube
        </Button>
      </div>

      {error && (
        <p className="text-xs text-red-400 border border-red-400/30 bg-red-400/5 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 rounded-lg border border-border bg-bg-secondary animate-pulse" />
          ))}
        </div>
      ) : !luts || luts.length === 0 ? (
        <EmptyState
          icon={SwatchBook}
          title="No LUTs yet"
          description="Upload a .cube file to preview it on any video or image, and share it into a project when you want the team to see it too."
        />
      ) : (
        <div className="space-y-3">
          {luts.map((lut) => (
            <div
              key={lut.id}
              className="flex items-center gap-3 p-4 rounded-lg border border-border bg-bg-secondary"
            >
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-text-primary truncate">{lut.name}</h3>
                <p className="text-xs text-text-tertiary mt-0.5">
                  {lut.lut_size ? `${lut.lut_size}³ · ` : ''}
                  added {formatRelativeTime(lut.created_at)}
                </p>
              </div>

              {sharing[lut.id] && (
                <span className="flex items-center gap-1 text-xs text-accent shrink-0">
                  <Check className="h-3.5 w-3.5" />
                  Shared
                </span>
              )}

              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    className="flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
                    aria-label={`Actions for ${lut.name}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-[100] w-56 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1"
                  >
                    <DropdownMenu.Label className="px-2.5 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                      Share into project
                    </DropdownMenu.Label>
                    {(projects ?? []).length === 0 ? (
                      <p className="px-2.5 py-1.5 text-xs text-text-tertiary">
                        You&apos;re not on any projects yet
                      </p>
                    ) : (
                      (projects ?? []).map((p) => (
                        <DropdownMenu.Item
                          key={p.id}
                          onSelect={() => handleShare(lut, p)}
                          className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                        >
                          <Share2 className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                          <span className="truncate">{p.name}</span>
                        </DropdownMenu.Item>
                      ))
                    )}
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      onSelect={() => setDeleting(lut)}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-red-400 outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete LUT"
        description={
          deleting
            ? `"${deleting.name}" will be removed from your library and unshared from every project. Any shot currently graded with it falls back to no grade.`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
      />
    </div>
  )
}
