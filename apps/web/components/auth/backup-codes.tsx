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
 *
 * §207 — `requireExplicitAcknowledgement` adds a tick-box in front of that
 * button, and defaults to FALSE so that every existing caller behaves exactly
 * as it did. Only forced enrolment turns it on, and only because of what
 * happens next there: dismissing the screen signs the user out, which is a
 * door that does not reopen. A single mis-click would cost them their codes
 * AND their session. The settings page's own enrolment and regeneration leave
 * the user signed in and can regenerate again, so the extra step would be
 * friction with nothing behind it (and those paths are explicitly out of
 * scope for §207).
 */
export function BackupCodes({
  codes,
  onAcknowledge,
  title = 'Save your backup codes',
  acknowledgeLabel = "I've saved these codes",
  requireExplicitAcknowledgement = false,
  acknowledgeHint,
}: {
  codes: string[]
  onAcknowledge: () => void
  title?: string
  acknowledgeLabel?: string
  /** §207 — gate the dismiss button behind a tick-box. Default false keeps
   *  every pre-§207 caller unchanged. */
  requireExplicitAcknowledgement?: boolean
  /** Shown under the codes when `requireExplicitAcknowledgement` is on, to
   *  say what dismissing will do before it happens. */
  acknowledgeHint?: string
}) {
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  // Not just `!confirmed`: with the gate off there is nothing to confirm, and
  // the button must stay enabled from the first render as it always has.
  const dismissBlocked = requireExplicitAcknowledgement && !confirmed

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

      {acknowledgeHint && requireExplicitAcknowledgement && (
        <p className="mt-3 text-xs text-text-secondary">{acknowledgeHint}</p>
      )}

      <div className="mt-4 flex flex-col gap-3">
        <Button type="button" variant="secondary" onClick={handleCopy} className="w-full">
          {copied ? 'Copied' : 'Copy codes'}
        </Button>

        {requireExplicitAcknowledgement && (
          <label className="flex items-start gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
            />
            <span>I have saved these codes somewhere I can get to them.</span>
          </label>
        )}

        <Button
          type="button"
          size="lg"
          onClick={onAcknowledge}
          disabled={dismissBlocked}
          className="w-full"
        >
          {acknowledgeLabel}
        </Button>

        {/* §207 (17c) — a disabled control that does not say why reads as a
            broken screen. Rendered only while it is actually disabled, so it
            disappears the moment the reason stops applying rather than
            lingering as advice nobody needs. */}
        {dismissBlocked && (
          <p className="text-xs text-text-tertiary">
            Tick the box above to continue — these codes are not shown again.
          </p>
        )}
      </div>
    </div>
  )
}
