/**
 * The hook that picks a byte convention without breaking SSR (§190).
 *
 * `navigator` does not exist on the server. Reading it during render would
 * either throw or — worse — produce server HTML that disagrees with the
 * first client render, which React reports as a hydration error. So the
 * hook starts at the SSR-safe default and corrects itself after mount.
 *
 * What is asserted is the ORDER: decimal on the first render even for a
 * Windows viewer, binary only afterwards. A test that only checked the
 * settled value would pass against an implementation that read `navigator`
 * during render — the one that breaks hydration.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, renderHook } from '@testing-library/react'
import { renderToString } from 'react-dom/server'

import { useByteUnitMode, useFormatBytes, useFormatBytesOrDash } from '../use-byte-units'

const REAL_FILE = 135_458_109

function setNavigator(nav: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value: nav,
    configurable: true,
    writable: true,
  })
}

const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'navigator', original)
  vi.restoreAllMocks()
})

/** Records every value the hook has produced, in order. */
function Recorder({ seen }: { seen: string[] }) {
  const format = useFormatBytes()
  const value = format(REAL_FILE)
  seen.push(value)
  return <span data-testid="size">{value}</span>
}

describe('a Windows viewer', () => {
  it('settles on binary, matching their own Explorer', async () => {
    setNavigator(WINDOWS)
    const seen: string[] = []
    render(<Recorder seen={seen} />)

    await waitFor(() => expect(screen.getByTestId('size').textContent).toBe('129.2 MB'))
  })

  it('renders the DEFAULT first, then corrects — never mid-render detection', async () => {
    /* The hydration-safety property. If the hook read `navigator` during
       render, the first recorded value would already be binary and the
       server's HTML would not match it. */
    setNavigator(WINDOWS)
    const seen: string[] = []
    render(<Recorder seen={seen} />)

    expect(seen[0]).toBe('135.5 MB')
    await waitFor(() => expect(seen[seen.length - 1]).toBe('129.2 MB'))
  })
})

describe('everyone else', () => {
  it('gets decimal, matching Finder', async () => {
    setNavigator(MAC)
    const seen: string[] = []
    render(<Recorder seen={seen} />)

    await waitFor(() => expect(screen.getByTestId('size').textContent).toBe('135.5 MB'))
  })

  it('never re-renders, because the default was already right', async () => {
    /* Non-Windows is the common case; it should not pay a render for a
       state update to the value it already held. */
    setNavigator(MAC)
    const seen: string[] = []
    render(<Recorder seen={seen} />)
    await new Promise((r) => setTimeout(r, 20))

    expect(new Set(seen)).toEqual(new Set(['135.5 MB']))
  })
})

describe('server rendering', () => {
  it('does not throw with no navigator at all', () => {
    delete (globalThis as { navigator?: unknown }).navigator

    expect(() => renderToString(<Recorder seen={[]} />)).not.toThrow()
  })

  it('renders the decimal default on the server', () => {
    delete (globalThis as { navigator?: unknown }).navigator

    expect(renderToString(<Recorder seen={[]} />)).toContain('135.5 MB')
  })

  it('a Windows client hydrates against that same decimal HTML', () => {
    /* Which is precisely why the first client render must NOT be binary:
       these two strings have to match, or React errors. */
    delete (globalThis as { navigator?: unknown }).navigator
    const serverHtml = renderToString(<Recorder seen={[]} />)

    setNavigator(WINDOWS)
    const seen: string[] = []
    render(<Recorder seen={seen} />)

    expect(serverHtml).toContain(seen[0])
  })
})

describe('the nullable variant the share viewer needs', () => {
  it('shows an em dash for a missing size', () => {
    setNavigator(MAC)
    const { result } = renderHook(() => useFormatBytesOrDash())

    expect(result.current(null)).toBe('—')
    expect(result.current(undefined)).toBe('—')
  })

  it('formats a real size like the others', async () => {
    setNavigator(MAC)
    const { result } = renderHook(() => useFormatBytesOrDash())

    await waitFor(() => expect(result.current(REAL_FILE)).toBe('135.5 MB'))
  })

  it('distinguishes zero from missing', () => {
    /* `0` is a real answer — an empty folder — and must not read as "—". */
    setNavigator(MAC)
    const { result } = renderHook(() => useFormatBytesOrDash())

    expect(result.current(0)).toBe('0 B')
  })
})

describe('the mode hook on its own', () => {
  it('reports binary on Windows after mount', async () => {
    setNavigator(WINDOWS)
    const { result } = renderHook(() => useByteUnitMode())

    await waitFor(() => expect(result.current).toBe('binary'))
  })

  it('reports decimal elsewhere', async () => {
    setNavigator(MAC)
    const { result } = renderHook(() => useByteUnitMode())

    await waitFor(() => expect(result.current).toBe('decimal'))
  })
})
