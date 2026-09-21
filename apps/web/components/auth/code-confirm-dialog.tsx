'use client'

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import {
  CodeOrBackupInput,
  type CodeEntryMode,
} from '@/components/auth/code-or-backup-input'

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
 *
 * §205 — two additions, both because this dialog is every re-auth in the app:
 *
 *   * a backup code can now actually be typed here. The description has said
 *     "a backup code works too" since §197 while the only field in it threw
 *     away every non-digit.
 *   * `notice` and `onResend` let an email-factor user be told a code was
 *     sent and ask for another. Nothing on the disable, regenerate or
 *     replace-enrolment paths ever sent one, so for those users the dialog
 *     asked for a code that could not arrive and offered a backup code the
 *     field refused — three dead controls from two defects.
 */
export function CodeConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
  notice,
  onResend,
  allowBackupCode = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: React.ReactNode
  confirmLabel?: string
  onConfirm: (code: string) => Promise<void>
  /** §205 — "We sent a code to …", for an email-factor user. */
  notice?: string
  /** §205 — rate-limited resend. Absent for a TOTP user, who has no mail to
   *  wait for and should not be offered one. */
  onResend?: () => Promise<void>
  /** Every caller of this dialog is a re-auth, where a backup code is exactly
   *  the right thing to accept — hence the default. A caller that must refuse
   *  one says so explicitly. */
  allowBackupCode?: boolean
}) {
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<CodeEntryMode>('digits')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resending, setResending] = useState(false)

  // A dialog reopened after a failure must not still be showing the last
  // attempt's digits or its error — nor, since §205, be stuck in the backup
  // field because the previous attempt ended there.
  useEffect(() => {
    if (open) {
      setCode('')
      setMode('digits')
      setError('')
    }
  }, [open])

  async function submit(value: string) {
    // §205 — the minimum differs per field. A backup code is nine characters
    // with the dash and eight without, and the old "< 6" rule would have let
    // a half-typed one through to the server as a wrong code.
    if (mode === 'backup') {
      if (value.trim().length < 8) {
        setError('Enter your full backup code')
        return
      }
    } else if (value.length < 6) {
      setError('Enter the 6-digit code')
      return
    }
    setError('')
    setBusy(true)
    try {
      await onConfirm(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.')
      setCode('')
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

          {notice && (
            <p className="mt-3 text-xs text-text-secondary">{notice}</p>
          )}

          <div className="mt-4 space-y-2">
            <CodeOrBackupInput
              value={code}
              onChange={(next) => { setCode(next); setError('') }}
              onComplete={submit}
              mode={mode}
              onModeChange={(next) => { setMode(next); setError('') }}
              invalid={!!error}
              autoFocus
              allowBackupCode={allowBackupCode}
              disabled={busy}
            />
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 mt-5">
            {onResend && (
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto"
                loading={resending}
                disabled={busy}
                onClick={async () => {
                  setResending(true)
                  setError('')
                  try {
                    await onResend()
                  } catch (err) {
                    setError(
                      err instanceof Error ? err.message : 'Could not send a code.',
                    )
                  } finally {
                    setResending(false)
                  }
                }}
              >
                Send it again
              </Button>
            )}
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
              onClick={() => submit(code)}
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
