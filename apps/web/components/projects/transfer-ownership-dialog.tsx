'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, ArrowRightLeft } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import type { ProjectRole, User } from '@/types'

interface TransferOwnershipDialogProps {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onTransferred: () => void
}

interface MemberWithUser {
  user_id: string
  role: ProjectRole
  user: User
}

/** Self-service ownership transfer for the project's true owner. Unlike
 *  the superadmin version in Admin Settings, this only lets you hand the
 *  crown to an EXISTING Project Admin (role=owner member) on this
 *  project — the backend enforces the same restriction, this dialog just
 *  narrows the picker to match instead of showing a dead-end open search. */
export function TransferOwnershipDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
  onTransferred,
}: TransferOwnershipDialogProps) {
  const [admins, setAdmins] = React.useState<MemberWithUser[]>([])
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setSelected(null)
    setError('')
    setLoading(true)
    ;(async () => {
      try {
        const rawMembers = await api.get<{ user_id: string; role: ProjectRole }[]>(
          `/projects/${projectId}/members`,
        )
        const owners = rawMembers.filter((m) => m.role === 'admin')
        if (owners.length === 0) {
          setAdmins([])
          return
        }
        const userIds = owners.map((m) => m.user_id)
        const users = await api.get<User[]>(`/users?ids=${userIds.join(',')}`)
        const userMap = new Map(users.map((u) => [u.id, u]))
        setAdmins(
          owners
            .filter((m) => userMap.has(m.user_id))
            .map((m) => ({ ...m, user: userMap.get(m.user_id)! })),
        )
      } catch {
        setAdmins([])
      } finally {
        setLoading(false)
      }
    })()
  }, [open, projectId])

  const handleSubmit = async () => {
    if (!selected) return
    setSubmitting(true)
    setError('')
    try {
      await api.post(`/projects/${projectId}/transfer-ownership`, { new_owner_id: selected })
      onTransferred()
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to transfer ownership')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">
            Transfer Ownership
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Hand &quot;{projectName}&quot; to a Manager. You&apos;ll remain a Manager, just not
            the owner.
          </Dialog.Description>

          <div className="mt-4 space-y-1 max-h-56 overflow-y-auto">
            {loading ? (
              <p className="text-xs text-text-tertiary py-4 text-center">
                Loading Managers…
              </p>
            ) : admins.length === 0 ? (
              <p className="text-xs text-text-tertiary py-4 text-center">
                No other Managers yet. Give someone Manager access in Members first.
              </p>
            ) : (
              admins.map((m) => (
                <button
                  key={m.user_id}
                  type="button"
                  onClick={() => setSelected(m.user_id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selected === m.user_id ? 'bg-accent/10' : 'hover:bg-bg-tertiary'
                  }`}
                >
                  <Avatar src={m.user.avatar_url} name={m.user.name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-text-primary">{m.user.name}</p>
                    <p className="truncate text-xs text-text-tertiary">{m.user.email}</p>
                  </div>
                </button>
              ))
            )}
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 mt-5">
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" loading={submitting} disabled={!selected} onClick={handleSubmit}>
              <ArrowRightLeft className="h-3.5 w-3.5" />
              Transfer
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
