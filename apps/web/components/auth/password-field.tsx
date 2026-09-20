'use client'

/**
 * A password input with the live weak / medium / strong meter (§200).
 *
 * One component rather than the meter being wired up at each of the four
 * places a password is typed (the login screen's set-password step, invite
 * acceptance, the profile screen, and the onboarding gate). Those four
 * previously shared nothing but a `length < 8` check written twice, and two of
 * them did not check anything at all.
 *
 * The meter is **advisory**. It says what it can see; the server decides, and
 * a submission this component is happy with can still come back refused —
 * which is why callers must render the server's error and not treat a green
 * bar as permission. See `lib/password-policy.ts` for why the split is
 * deliberate rather than a gap.
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  usePasswordPolicy,
  usePasswordStrength,
  missingClasses,
} from '@/lib/password-policy'
import { cn } from '@/lib/utils'
import type { PasswordStrength } from '@/types'

interface PasswordFieldProps {
  id?: string
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  /**
   * Things about this person the password must not contain — their address,
   * their name, the instance name.
   *
   * Not optional in spirit: the server rejects a password containing any of
   * them, and zxcvbn scores them far lower when told. Omitting them gives a
   * meter that is more optimistic than the server, which is the one direction
   * it must never be wrong in.
   */
  userInputs?: string[]
  /** Reported on every change, so the caller can disable its submit button. */
  onStrengthChange?: (strength: PasswordStrength | null) => void
  error?: string
}

const BAR_CLASS: Record<string, string> = {
  weak: 'bg-status-error',
  medium: 'bg-status-warning',
  strong: 'bg-status-success',
}

const BAR_WIDTH: Record<string, string> = {
  weak: 'w-1/3',
  medium: 'w-2/3',
  strong: 'w-full',
}

export function PasswordField({
  id = 'password',
  label = 'Password',
  value,
  onChange,
  placeholder,
  autoFocus,
  disabled,
  userInputs = [],
  onStrengthChange,
  error,
}: PasswordFieldProps) {
  const policy = usePasswordPolicy()
  const strength = usePasswordStrength(value, userInputs, policy)

  React.useEffect(() => {
    onStrengthChange?.(strength)
    // `onStrengthChange` is deliberately out of the dependency list: callers
    // pass an inline arrow, which is a new function on every render, and
    // including it would fire this effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strength])

  // Computed synchronously rather than read off `strength`, which is
  // debounced: the checklist should tick the moment the character is typed,
  // even while the score is still catching up. The rules are the same ones —
  // `missingClasses` is what `scorePassword` uses too.
  const missing = value ? missingClasses(value, policy) : []
  const longEnough = value.length >= policy.min_length

  const rules: { ok: boolean; text: string }[] = [
    { ok: longEnough, text: `At least ${policy.min_length} characters` },
    { ok: !missing.includes('an upper-case letter'), text: 'An upper-case letter' },
    { ok: !missing.includes('a lower-case letter'), text: 'A lower-case letter' },
    { ok: !missing.includes('a digit'), text: 'A digit' },
    { ok: !missing.includes('a special character'), text: 'A special character' },
  ]

  return (
    <div className="space-y-2">
      <Input
        id={id}
        label={label}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? `At least ${policy.min_length} characters`}
        autoFocus={autoFocus}
        disabled={disabled}
        error={error}
        autoComplete="new-password"
      />

      {value.length > 0 && (
        <div className="space-y-2" data-testid="password-meter">
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-200',
                  strength ? BAR_CLASS[strength.label] : 'bg-bg-tertiary',
                  strength ? BAR_WIDTH[strength.label] : 'w-0',
                )}
              />
            </div>
            {/* The word matters more than the bar for anyone who cannot
                distinguish the colours, so it is text and not only a hue. */}
            <span
              className={cn(
                'w-14 text-right text-2xs font-medium capitalize',
                strength?.label === 'strong' && 'text-status-success',
                strength?.label === 'medium' && 'text-status-warning',
                strength?.label === 'weak' && 'text-status-error',
                !strength && 'text-text-tertiary',
              )}
            >
              {strength?.label ?? '…'}
            </span>
          </div>

          {/* zxcvbn's own finding — "This is similar to a commonly used
              password", "Names and surnames by themselves are easy to guess".
              This is the part that makes a weak score actionable; a partly
              filled bar tells nobody what to change. Shown only while the
              password is still below the bar, so a strong one is not nagged. */}
          {strength && !strength.meetsPolicy && strength.reason && (
            <p className="text-2xs text-text-tertiary">{strength.reason}.</p>
          )}

          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {rules.map((rule) => (
              <li
                key={rule.text}
                className={cn(
                  'flex items-center gap-1 text-2xs',
                  rule.ok ? 'text-status-success' : 'text-text-tertiary',
                )}
              >
                {rule.ok ? (
                  <Check className="h-3 w-3 shrink-0" />
                ) : (
                  <X className="h-3 w-3 shrink-0" />
                )}
                {rule.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
