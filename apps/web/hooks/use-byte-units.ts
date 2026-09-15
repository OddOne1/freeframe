'use client'

import * as React from 'react'

import {
  DEFAULT_BYTE_UNIT_MODE,
  detectByteUnitMode,
  formatBytesIn,
  type ByteUnitMode,
} from '@/lib/byte-units'

/**
 * The byte convention this viewer's OS uses (§190).
 *
 * Detected ONCE, here, rather than at each of the ~15 call sites that show
 * a file size. Four independent copies of the byte maths is what produced
 * the bug this fixes; fifteen copies of the platform sniffing would be the
 * same mistake in a new place.
 *
 * Starts at `decimal` and re-renders after mount if this turns out to be
 * Windows. That is deliberate and is the standard trade for client-only
 * detection under SSR: `navigator` does not exist on the server, so reading
 * it during render would either throw or — worse — produce server HTML that
 * disagrees with the first client render, which React reports as a
 * hydration error. A Windows viewer instead sees one frame of the decimal
 * number before it settles on binary. A brief flash beats a hydration
 * failure, and beats every non-Windows viewer paying for it.
 *
 * No cookie/header plumbing: nothing in this app's request pipeline carries
 * the platform today (checked — the only `navigator` use anywhere is
 * `navigator.clipboard`), and building that for a units label would be a
 * large amount of new infrastructure for a one-frame improvement.
 */
export function useByteUnitMode(): ByteUnitMode {
  const [mode, setMode] = React.useState<ByteUnitMode>(DEFAULT_BYTE_UNIT_MODE)

  React.useEffect(() => {
    const detected = detectByteUnitMode()
    // Only on a real change: setting state to the value it already holds
    // still costs a render pass on every mount of every component using
    // this, and non-Windows is the common case.
    if (detected && detected !== mode) setMode(detected)
    // Platform cannot change during a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return mode
}

/**
 * `formatBytes`, already bound to this viewer's convention.
 *
 * The shape most call sites want: they were calling a bare
 * `formatBytes(n)`, and this keeps that call unchanged at the usage point
 * while the convention comes from one place.
 */
export function useFormatBytes(): (bytes: number) => string {
  const mode = useByteUnitMode()
  return React.useCallback((bytes: number) => formatBytesIn(bytes, mode), [mode])
}

/**
 * The same, for the nullable sizes the share viewer deals in.
 *
 * It had its own `formatFileSize` returning an em dash for null (§190);
 * that behaviour is worth keeping and is the only reason this exists
 * separately rather than every caller writing the same ternary.
 */
export function useFormatBytesOrDash(): (bytes: number | null | undefined) => string {
  const format = useFormatBytes()
  return React.useCallback(
    (bytes: number | null | undefined) => (bytes == null ? '—' : format(bytes)),
    [format],
  )
}
