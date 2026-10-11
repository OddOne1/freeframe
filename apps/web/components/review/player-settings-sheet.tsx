'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  Gauge,
  MonitorPlay,
  Palette,
  Repeat,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The player's settings, as a bottom sheet (§228 A4).
 *
 * The owner's complaint, from a 390px iPhone: "the player holds way too
 * much information for mobile ... put loop, playback speed, LUT selector
 * and captions into a separate setting, like YouTube". On a phone the
 * transport row now keeps only play/pause, the timecode, the scrubber and
 * fullscreen; everything else lives behind the `⚙` that opens this.
 *
 * Built on the Radix Dialog already in use across this app (share dialog,
 * confirm dialog, name dialog) rather than a new primitive — no dependency
 * added, and it inherits the focus trap, the Escape handler and the scrim.
 *
 * Sub-pages, not one long list: speed, quality and the LUT library are all
 * lists of their own, and stacking them would make a sheet taller than the
 * phone. The LUT sub-page renders whatever the caller passes, which is the
 * SAME `<LutSidebar>` the desktop shows in its left column, driven by the
 * same `useLut` state — not a copy of the picker.
 *
 * Row heights are `min-h-11` (44px) and nothing is smaller than `text-xs`
 * (12px), per the prompt's floor for a touch target and for legibility.
 */

type Page = 'main' | 'speed' | 'quality' | 'lut'

export interface PlayerSettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void

  /** Playback speed. Picking one CLOSES the sheet — that is the convention
   *  a speed menu follows everywhere, and it is a one-shot choice. */
  playbackRate: number
  speedOptions: readonly number[]
  onPlaybackRate: (rate: number) => void

  /** Loop. A toggle, so the sheet STAYS OPEN: the point of a toggle is to
   *  see it flip, and closing would hide the only feedback it has. */
  loop: boolean
  onToggleLoop: () => void

  /** Captions — the row is absent entirely when no transcript exists, same
   *  rule the desktop transport row already applies to its CC button. */
  captionsAvailable?: boolean
  captionsOn?: boolean
  onToggleCaptions?: () => void
  captionsLanguageLabel?: string | null

  /**
   * The HLS quality ladder. This is the control the owner's screenshot
   * showed clipped as "Au…" — it is a native `<select>` whose first option
   * is "Auto", NOT an audio control (there is no audio-track picker in
   * this player). Absent on Safari, which never exposes levels (§117).
   */
  qualityLevels?: { index: number; label: string }[]
  currentQuality?: number
  onQuality?: (index: number) => void

  /** The LUT library, rendered as a sub-page. Omitted = no LUT row. */
  lutSubPage?: React.ReactNode
  lutLabel?: string | null
}

function Row({
  icon: Icon,
  label,
  value,
  onClick,
  chevron,
  active,
  testId,
}: {
  icon: React.ElementType
  label: string
  value?: React.ReactNode
  onClick: () => void
  chevron?: boolean
  active?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 px-4 text-left transition-colors',
        'text-text-primary hover:bg-bg-hover',
      )}
    >
      <Icon
        className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-text-tertiary')}
      />
      <span className="flex-1 truncate text-xs font-medium">{label}</span>
      {value !== undefined && (
        <span className="shrink-0 text-xs text-text-tertiary">{value}</span>
      )}
      {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" />}
    </button>
  )
}

function OptionRow({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex min-h-11 w-full items-center justify-between gap-3 px-4 text-left text-xs transition-colors',
        selected ? 'text-accent' : 'text-text-primary hover:bg-bg-hover',
      )}
    >
      <span className="truncate">{label}</span>
      {selected && <Check className="h-4 w-4 shrink-0 text-accent" />}
    </button>
  )
}

export function PlayerSettingsSheet({
  open,
  onOpenChange,
  playbackRate,
  speedOptions,
  onPlaybackRate,
  loop,
  onToggleLoop,
  captionsAvailable,
  captionsOn,
  onToggleCaptions,
  captionsLanguageLabel,
  qualityLevels,
  currentQuality,
  onQuality,
  lutSubPage,
  lutLabel,
}: PlayerSettingsSheetProps) {
  const [page, setPage] = React.useState<Page>('main')

  // Every open starts at the top level. Reopening onto the sub-page the
  // user last left would hide the other settings behind a back button.
  React.useEffect(() => {
    if (open) setPage('main')
  }, [open])

  const hasQuality = Boolean(qualityLevels && qualityLevels.length > 0 && onQuality)
  const qualityLabel =
    currentQuality === undefined || currentQuality < 0
      ? 'Auto'
      : (qualityLevels?.find((l) => l.index === currentQuality)?.label ?? 'Auto')

  const title =
    page === 'speed'
      ? 'Playback speed'
      : page === 'quality'
        ? 'Quality'
        : page === 'lut'
          ? 'LUT'
          : 'Player settings'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="player-settings-scrim"
          className="fixed inset-0 z-[60] bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <Dialog.Content
          data-testid="player-settings-sheet"
          aria-describedby={undefined}
          className={cn(
            // A sheet, not a centred dialog: it comes up from the edge the
            // thumb is already at. `dvh` rather than `vh` for the same
            // reason the shell uses it — iOS reports `100vh` as the height
            // WITHOUT its toolbars (§224).
            'fixed inset-x-0 bottom-0 z-[61] flex max-h-[80dvh] flex-col',
            'rounded-t-2xl border-t border-border bg-bg-elevated shadow-2xl',
            // viewport-fit=cover lets the page paint under the home
            // indicator; without this the last row is beneath it.
            'pb-[env(safe-area-inset-bottom)]',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-4 duration-150',
          )}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
            {page !== 'main' ? (
              <button
                type="button"
                onClick={() => setPage('main')}
                aria-label="Back to player settings"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              // Keeps the title on the same baseline whichever page is up,
              // so it does not jump as you step in and out.
              <span className="h-11 w-2 shrink-0" aria-hidden />
            )}
            <Dialog.Title className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              {title}
            </Dialog.Title>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {page === 'main' && (
              <>
                <Row
                  icon={Gauge}
                  label="Playback speed"
                  value={`${playbackRate}x`}
                  onClick={() => setPage('speed')}
                  chevron
                  testId="sheet-row-speed"
                />
                <Row
                  icon={Repeat}
                  label="Loop"
                  value={loop ? 'On' : 'Off'}
                  active={loop}
                  // Stays open deliberately — see the prop doc above.
                  onClick={onToggleLoop}
                  testId="sheet-row-loop"
                />
                {captionsAvailable && onToggleCaptions && (
                  <Row
                    icon={Captions}
                    label={
                      captionsLanguageLabel
                        ? `Captions (${captionsLanguageLabel})`
                        : 'Captions'
                    }
                    value={captionsOn ? 'On' : 'Off'}
                    active={captionsOn}
                    onClick={onToggleCaptions}
                    testId="sheet-row-captions"
                  />
                )}
                {hasQuality && (
                  <Row
                    icon={MonitorPlay}
                    label="Quality"
                    value={qualityLabel}
                    onClick={() => setPage('quality')}
                    chevron
                    testId="sheet-row-quality"
                  />
                )}
                {lutSubPage && (
                  <Row
                    icon={Palette}
                    label="LUT"
                    value={lutLabel ?? 'None'}
                    active={Boolean(lutLabel)}
                    onClick={() => setPage('lut')}
                    chevron
                    testId="sheet-row-lut"
                  />
                )}
              </>
            )}

            {page === 'speed' && (
              <div data-testid="sheet-page-speed">
                {speedOptions.map((rate) => (
                  <OptionRow
                    key={rate}
                    label={`${rate}x`}
                    selected={playbackRate === rate}
                    onSelect={() => {
                      onPlaybackRate(rate)
                      // A one-shot choice: picking it is the whole
                      // interaction, so the sheet gets out of the way.
                      onOpenChange(false)
                    }}
                  />
                ))}
              </div>
            )}

            {page === 'quality' && hasQuality && (
              <div data-testid="sheet-page-quality">
                <OptionRow
                  label="Auto"
                  selected={(currentQuality ?? -1) < 0}
                  onSelect={() => {
                    onQuality?.(-1)
                    onOpenChange(false)
                  }}
                />
                {qualityLevels?.map((level) => (
                  <OptionRow
                    key={level.index}
                    label={level.label}
                    selected={currentQuality === level.index}
                    onSelect={() => {
                      onQuality?.(level.index)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </div>
            )}

            {page === 'lut' && (
              // The real LUT library component, handed down whole. It is a
              // 260px column on the desktop; here it is told to fill the
              // sheet instead, which is a className, not a second picker.
              <div data-testid="sheet-page-lut" className="flex min-h-[40dvh] flex-col">
                {lutSubPage}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
