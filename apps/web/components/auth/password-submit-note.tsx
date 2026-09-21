'use client'

/**
 * The sentence that says why the submit button is disabled (§202).
 *
 * Small enough to inline, shared anyway — the point of §202 is that all four
 * password forms behave identically, and four inlined copies is exactly how
 * they drifted into sharing one silent failure instead.
 *
 * Rendered next to the button, not under the field: the question it answers is
 * "why can't I press this", and the answer belongs where the question is
 * asked. `role="status"` rather than `role="alert"` because it updates on
 * every keystroke — an assertive live region would interrupt a screen-reader
 * user mid-word on each character typed.
 */
export function PasswordSubmitNote({ reason }: { reason: string | null }) {
  if (!reason) return null
  return (
    <p role="status" className="text-sm text-text-tertiary" data-testid="submit-block-reason">
      {reason}
    </p>
  )
}
