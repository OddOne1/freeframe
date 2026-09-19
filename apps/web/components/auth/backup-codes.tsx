'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * The one-time view of a set of backup codes, with the acknowledgement that
 * gates whatever comes next.
 *
 * §197 — shared the moment it was needed twice (forced enrolment on the
 * login screen, and enrolling or regenerating from settings) rather than
 * copied. This codebase has paid for the other choice: §190 found the same
 * file-size logic in four places and §193 found the same login-response
 * branch in two, each having drifted. This one is worse to get wrong than
 * either: the codes are hashed server-side the instant they are issued, so
 * a screen that skips past them has destroyed them, and a copy that forgot
 * the gate would do exactly that.
 *
 * `onAcknowledge` is what the caller uses to move on — redirecting,
 * refetching, closing a dialog. Nothing here decides that.
 */
export function BackupCodes({
  codes,
  onAcknowledge,
  title = 'Save your backup codes',
  acknowledgeLabel = "I've saved these codes",
}: {
  codes: string[]
  onAcknowledge: () => void
  title?: string
  acknowledgeLabel?: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(codes.join('\n'))
      setCopied(true)
    } catch {
      // A blocked clipboard is not worth blocking on: the codes are on
      // screen and can be written down.
      setCopied(false)
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Each code works once, if you ever lose access to your second factor.
          This is the only time they are shown.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-bg-secondary p-3 font-mono text-sm text-text-primary">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <Button type="button" variant="secondary" onClick={handleCopy} className="w-full">
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button type="button" size="lg" onClick={onAcknowledge} className="w-full">
          {acknowledgeLabel}
        </Button>
      </div>
    </div>
  )
}
