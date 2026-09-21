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
 *
 * §201 — layout only: the row is centred as one tight group with the usual
 * `123 456` break, instead of six boxes spread to the edges of whatever card
 * they are in. Every handler below is byte-for-byte unchanged, which matters
 * more here than the appearance does — paste-fill, auto-advance and
 * backspace-to-previous all index a single flat array of six refs, and the
 * obvious way to draw a `123 456` gap (two nested flex containers) is exactly
 * what would break that indexing.
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
    // §201 — `justify-center`, not `justify-between`.
    //
    // The boxes were `w-full max-w-[48px]` inside a `justify-between` row, so
    // they capped at 48px and then the LEFTOVER space was pushed between
    // them. In a wide card that is most of the card: six boxes marooned at
    // the edges, reading as six separate fields rather than as one number.
    // Centring a tight group is the fix, and it is the whole change — the
    // handlers below are untouched.
    <div className="flex justify-center gap-1.5 sm:gap-2">
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
            // 44px at sm+, 40px below it, both sized to FIT rather than to
            // rely on flex-shrink. The binding container is not the gate but
            // `max-w-xs` (320px) in two-factor-settings: six 44px boxes plus
            // 5x8px gaps plus the 8px break is 312px, which leaves 8px of
            // slack — too thin to also absorb a phone's narrower card. At
            // 390px the gate's nested padding leaves ~278px, and 6x40 + 5x6 +
            // 4 = 274px fits with nothing borrowed.
            //
            // `min-w-0` is still required and is not belt-and-braces: a flex
            // item's automatic minimum size for an <input> is its intrinsic
            // preferred width (~20 characters), which would stop it shrinking
            // and push the row into a horizontal overflow. It is the backstop
            // for any container narrower than the two measured above.
            //
            // One line at every width is the point of the change; wrapping to
            // two rows would undo it entirely.
            'h-12 w-10 sm:w-11 min-w-0 rounded-md border bg-bg-secondary text-center text-lg font-semibold text-text-primary',
            // Tabular figures so the digits sit on the same optical centre as
            // each other — a proportional `1` is narrower than a `0` and the
            // group visibly wobbles as someone types without this.
            'tabular-nums',
            'transition-colors focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
            // The conventional `123 456` break. A margin on the fourth box
            // rather than a second flex container, so paste-fill and
            // auto-advance keep indexing one flat list of six refs — splitting
            // the row into two groups is how box 4 stops receiving focus after
            // box 3.
            i === 3 && 'ml-1 sm:ml-2',
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
