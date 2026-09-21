'use client'

/**
 * Six digit boxes, or a backup code — the keyhole the recovery path never had
 * (§205).
 *
 * Ten backup codes are issued at enrolment, the user is told to keep them
 * safe, and the re-auth dialog says in so many words that "a backup code
 * works too". The API accepts them properly: `normalize_backup_code` forgives
 * case, spaces and the dash, and `_second_factor_matches` consumes them.
 *
 * But `CodeInput` strips every non-digit, on typing and on paste, and it is
 * the ONLY code field in the app. So a `XXXX-XXXX` code over the alphabet
 * `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` could not be entered anywhere — the
 * thing people reach for exactly when nothing else works had no way in.
 *
 * **A sibling field, not a wider `CodeInput`.** Six one-character boxes are
 * the right shape for a six-digit code and the wrong shape for a nine-
 * character dashed one, and making them alphanumeric would wreck the
 * paste-fill and auto-advance behaviour §196 and §201 each deliberately kept
 * intact. `CodeInput` stays digits-only and untouched; this wraps it.
 *
 * **Only where a backup code is legitimate.** `allowBackupCode` is off by
 * default, because two of the four places this could go would be lying: the
 * magic-code screen (a backup code is not a primary credential) and the
 * enrolment-confirm screen, where `confirm_two_factor_setup` refuses one on
 * purpose — it exists to prove the NEW factor works. Offering an affordance
 * the server will reject is worse than not offering it.
 */

import * as React from 'react'
import { CodeInput } from '@/components/auth/code-input'
import { Input } from '@/components/ui/input'

export type CodeEntryMode = 'digits' | 'backup'

export function CodeOrBackupInput({
  value,
  onChange,
  onComplete,
  mode,
  onModeChange,
  invalid = false,
  autoFocus = false,
  allowBackupCode = false,
  disabled = false,
}: {
  /** One string for both modes: the six digits, or the backup code as typed.
   *  The parent gets to stay ignorant of which field produced it, and sends
   *  it raw — the server normalises. */
  value: string
  onChange: (next: string) => void
  onComplete: (value: string) => void
  mode: CodeEntryMode
  onModeChange: (mode: CodeEntryMode) => void
  invalid?: boolean
  autoFocus?: boolean
  allowBackupCode?: boolean
  disabled?: boolean
}) {
  if (mode === 'backup' && allowBackupCode) {
    return (
      <div className="space-y-2">
        <Input
          id="backup-code"
          label="Backup code"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onComplete(value)
            }
          }}
          placeholder="A7K2-9QXM"
          // Not `type="password"`: these are written down on paper and
          // retyped, and hiding them turns a transcription slip into three
          // failed attempts.
          autoComplete="one-time-code"
          // `off` on both: a backup code is not a word, and a browser
          // capitalising or correcting it produces a code the server has
          // never seen.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <p className="text-2xs text-text-tertiary">
          Upper or lower case, with or without the dash.
        </p>
        <button
          type="button"
          onClick={() => {
            onModeChange('digits')
            onChange('')
          }}
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          Enter a 6-digit code instead
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <CodeInput
        // CodeInput owns six one-character slots; this component owns one
        // string. Converting here rather than changing CodeInput is the
        // whole point — its paste-fill and auto-advance stay exactly as
        // §196 and §201 left them.
        value={Array.from({ length: 6 }, (_, i) => value[i] ?? '')}
        onChange={(next) => onChange(next.join(''))}
        onComplete={onComplete}
        invalid={invalid}
        autoFocus={autoFocus}
      />
      {allowBackupCode && (
        <button
          type="button"
          onClick={() => {
            onModeChange('backup')
            onChange('')
          }}
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          Use a backup code instead
        </button>
      )}
    </div>
  )
}
