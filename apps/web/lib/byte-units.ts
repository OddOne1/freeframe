/**
 * Whether to divide by 1000 or 1024 when showing a file size (§190).
 *
 * The bug this exists for: `formatBytes` divided by 1024 and labelled the
 * result "MB", which by SI definition means 1000-based. So a 135,458,109-byte
 * file that macOS Finder calls "135,5 MB" appeared in FreeFrame as
 * "129.2 MB". Same file, same byte count — verified straight from the
 * database, which was never wrong — and two different numbers on screen.
 * A storage system that disagrees with the user's own Finder is a storage
 * system they stop trusting.
 *
 * The obvious fix, "just use decimal", is wrong, because file managers do
 * not agree with each other:
 *
 *   macOS Finder, iOS, Android, GNOME Files   decimal (1000), labelled MB
 *   Windows Explorer                          BINARY (1024), still labelled MB
 *   KDE Dolphin                               binary, labelled MiB (correct)
 *
 * Windows' labelling is a long-standing Microsoft inconsistency, but it is
 * what is on a Windows user's screen. Switching everything to decimal would
 * fix the mismatch for most people and CREATE one for Windows users, who
 * currently agree with FreeFrame only because both are wrong in the same
 * direction. So the convention follows the viewer's own OS.
 *
 * KDE is not detectable from a browser and gets the majority default; that
 * is a deliberate compromise, not an oversight.
 */

export type ByteUnitMode = 'decimal' | 'binary'

/**
 * The server-render default, and the answer for any client we cannot place.
 *
 * Decimal because it is what the majority of viewers' own file managers
 * show, and because it is what the units actually mean.
 */
export const DEFAULT_BYTE_UNIT_MODE: ByteUnitMode = 'decimal'

/**
 * Whether this platform string is Windows.
 *
 * Split out from any DOM access so the rule can be tested against real
 * user-agent strings without a browser. `userAgentData.platform` is the
 * modern answer and reports exactly "Windows"; the `Win` substring covers
 * the classic user-agent ("Windows NT 10.0", and the older "Win64"/"WOW64"
 * tokens). Deliberately no attempt to tell macOS from Linux from Android —
 * they all take the same branch, so distinguishing them would be
 * unverifiable code with no behaviour behind it.
 */
export function isWindowsPlatform(platform: string | undefined | null): boolean {
  if (!platform) return false
  // Whole tokens, NOT a bare `/win/i` substring — which was the first
  // version of this and was wrong in the most embarrassing possible way:
  // "darwin" contains "win", so every Mac would have been served Windows'
  // convention. jsdom reports "Mozilla/5.0 (darwin) ..." and the test suite
  // caught it immediately; `process.platform` on macOS is literally
  // "darwin" too.
  //
  // These four cover what browsers actually send: userAgentData.platform is
  // exactly "Windows", and the classic user-agent carries "Windows NT"
  // alongside the older Win32/Win64/WOW64 architecture tokens.
  return /\b(windows|win32|win64|wow64)\b/i.test(platform)
}

/**
 * The convention this browser's OS uses, or `null` when it cannot be read.
 *
 * Null rather than a guess, so the caller decides what an unknown platform
 * means — during SSR there is no `navigator` at all, and silently answering
 * "decimal" here would make a missing browser indistinguishable from a
 * confirmed Mac.
 */
export function detectByteUnitMode(): ByteUnitMode | null {
  if (typeof navigator === 'undefined') return null

  const uaData = (navigator as Navigator & {
    userAgentData?: { platform?: string }
  }).userAgentData
  const platform = uaData?.platform || navigator.userAgent
  if (!platform) return null

  return isWindowsPlatform(platform) ? 'binary' : 'decimal'
}

/**
 * Bytes as a human-readable size, in the given convention.
 *
 * `mode` is a parameter rather than something detected in here: this is
 * called from server-rendered code where `navigator` does not exist, and
 * detecting per call site would put the same UA parsing in fourteen places
 * — which is the exact shape of the bug being fixed (four independent
 * copies of the byte maths, each wrong the same way).
 */
export function formatBytesIn(bytes: number, mode: ByteUnitMode): string {
  if (!bytes) return '0 B'

  const base = mode === 'binary' ? 1024 : 1000
  const units = ['B', 'KB', 'MB', 'GB', 'TB']

  const i = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(base)),
    units.length - 1,
  )
  if (i <= 0) return `${Math.round(bytes)} B`

  const value = bytes / Math.pow(base, i)
  return `${parseFloat(value.toFixed(1))} ${units[i]}`
}
