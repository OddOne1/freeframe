'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { CodeInput, EMPTY_CODE } from '@/components/auth/code-input'

/**
 * "Enter a code to confirm something sensitive", once.
 *
 * §197 — the profile page needed four of these: the emailed code that
 * confirms a password change, the second factor that same change now has to
 * clear for an enrolled user, and the re-auth that gates disabling 2FA,
 * regenerating backup codes and starting a replacement enrolment (§194b).
 * Four hand-rolled dialogs in one file is how one of them ends up not
 * clearing its input, or not resetting its error, or — worse — being the one
 * that forgets the gate it exists for.
 *
 * The digits come from the shared CodeInput (§196), so this is not a fifth
 * place that knows how paste-fill works.
 *
 * `onConfirm` receives the code and owns the request. It throws to report a
 * failure, which is what keeps the dialog open with the message showing;
 * returning normally means the caller has moved on and will close it.
 */
export function CodeConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel?: string
  onConfirm: (code: string) => Promise<void>
}) {
  const [code, setCode] = useState<string[]>(EMPTY_CODE)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // A dialog reopened after a failure must not still be showing the last
  // attempt's digits or its error.
  useEffect(() => {
    if (open) {
      setCode(EMPTY_CODE)
      setError('')
    }
  }, [open])

  async function submit(value: string) {
    if (value.length < 6) {
      setError('Enter the 6-digit code')
      return
    }
    setError('')
    setBusy(true)
    try {
      await onConfirm(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.')
      setCode(EMPTY_CODE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-xl p-6">
          <Dialog.Title className="text-sm font-semibold text-text-primary">{title}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-sm text-text-tertiary leading-relaxed">
            {description}
          </Dialog.Description>

          <div className="mt-4 space-y-2">
            <CodeInput
              value={code}
              onChange={(next) => { setCode(next); setError('') }}
              onComplete={submit}
              invalid={!!error}
              autoFocus
            />
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 mt-5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => submit(code.join(''))}
              loading={busy}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
