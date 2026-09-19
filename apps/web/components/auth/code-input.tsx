'use client'

import { useEffect, useRef, KeyboardEvent, ClipboardEvent } from 'react'
import { cn } from '@/lib/utils'

/**
 * The six-digit code boxes — auto-advance, backspace-to-previous, paste-fill,
 * auto-submit on the sixth digit.
 *
 * §196 — extracted from login-form.tsx rather than copied. That form now asks
 * for a six-digit code in three different situations (the magic code, a 2FA
 * challenge at login, and the code that confirms a new enrolment), and the
 * behaviour here is the fiddly part: paste-fill has to land the caret on the
 * right box, and auto-submit has to fire from the pasted value rather than
 * from state that has not re-rendered yet. Three copies of that would be
 * three chances to fix a bug in one of them.
 *
 * Controlled: the parent owns the digits, because it is the parent that has
 * to clear them after a rejected code. `onComplete` fires with the full
 * string rather than leaving the parent to read state it has not received
 * yet — the same reason the original handler passed `pasted` along.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  invalid = false,
  autoFocus = false,
}: {
  value: string[]
  onChange: (next: string[]) => void
  onComplete: (code: string) => void
  invalid?: boolean
  autoFocus?: boolean
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  function handleChange(index: number, raw: string) {
    const digit = raw.replace(/\D/g, '').slice(-1)
    const next = [...value]
    next[index] = digit
    onChange(next)

    if (digit && index < 5) {
      refs.current[index + 1]?.focus()
    }

    if (digit && index === 5) {
      const full = next.join('')
      if (full.length === 6) onComplete(full)
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      refs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (pasted.length === 0) return
    onChange(Array.from({ length: 6 }, (_, i) => pasted[i] || ''))
    refs.current[Math.min(pasted.length, 5)]?.focus()
    if (pasted.length === 6) onComplete(pasted)
  }

  return (
    <div className="flex gap-2 justify-between">
      {value.map((digit, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          aria-label={`Digit ${i + 1}`}
          value={digit}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          className={cn(
            'h-12 w-full max-w-[48px] rounded-md border bg-bg-secondary text-center text-lg font-semibold text-text-primary',
            'transition-colors focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            invalid ? 'border-status-error' : 'border-border',
          )}
        />
      ))}
    </div>
  )
}

/** An empty set of digits. One spelling, so a reset cannot disagree with the
 *  initial value about how many boxes there are. */
export const EMPTY_CODE = ['', '', '', '', '', '']
