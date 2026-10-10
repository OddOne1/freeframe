'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Switch from '@radix-ui/react-switch'
import {
  LayoutGrid, List, RectangleHorizontal, Square, RectangleVertical,
  ChevronDown, SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useViewStore,
  type ViewLayout, type CardSize, type AspectRatio,
  type ThumbnailScale, type TitleLines,
} from '@/stores/view-store'

// ─── Segmented control ──────────────────────────────────────────────────────

interface SegmentOption<T extends string> {
  value: T
  label?: string
  icon?: React.ReactNode
}

function Segment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-md border border-white/10 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            // §224 — 44px minimum where there is no mouse. `min-w` and
            // `min-h` rather than fixed sizes, so the desktop popover keeps
            // its compact row exactly as it was.
            'flex items-center justify-center px-3 py-1.5 text-xs transition-colors min-w-[36px]',
            'hover-none:min-h-11 hover-none:min-w-11',
            value === opt.value
              ? 'bg-accent text-white'
              : 'bg-white/5 text-text-tertiary hover:text-text-secondary hover:bg-white/10',
          )}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Toggle switch row ──────────────────────────────────────────────────────

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors outline-none',
          checked ? 'bg-accent' : 'bg-white/15',
        )}
      >
        <Switch.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </Switch.Root>
    </div>
  )
}

// ─── Select dropdown row ────────────────────────────────────────────────────

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none bg-white/5 border border-white/10 rounded-md pl-2.5 pr-7 py-1 text-xs text-text-primary outline-none cursor-pointer hover:bg-white/10 transition-colors"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#232328]">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-text-tertiary pointer-events-none" />
      </div>
    </div>
  )
}

// ─── The controls themselves ───────────────────────────────────────────────

/**
 * Every appearance control, without the popover around it (§224).
 *
 * Split out so the phone Settings tab can render the same controls bound to
 * the same `useViewStore` rather than growing a parallel set — two copies
 * of "set card size" is how one of them ends up writing a different key.
 *
 * `sizeFirst` reorders rather than adds: on a phone the card size is the
 * setting people actually reach for (it decides how many clips fit on a
 * 390px screen), so it goes above Layout there. The desktop popover keeps
 * Layout first, which is what it has always shown.
 */
export function AppearanceControls({ sizeFirst = false }: { sizeFirst?: boolean }) {
  const {
    layout, setLayout,
    cardSize, setCardSize,
    aspectRatio, setAspectRatio,
    thumbnailScale, setThumbnailScale,
    showCardInfo, setShowCardInfo,
    titleLines, setTitleLines,
    flattenFolders, setFlattenFolders,
    showFileSize, setShowFileSize,
    showUploader, setShowUploader,
  } = useViewStore()

  const layoutRow = (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">Layout</span>
      <Segment<ViewLayout>
        options={[
          { value: 'grid', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
          { value: 'list', icon: <List className="h-3.5 w-3.5" /> },
        ]}
        value={layout}
        onChange={setLayout}
      />
    </div>
  )

  const sizeRows = layout === 'grid' && (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-secondary">Card Size</span>
        <Segment<CardSize>
          // Ascending, smallest first (§51).
          options={[
            { value: 'XS', label: 'XS' },
            { value: 'S', label: 'S' },
            { value: 'M', label: 'M' },
            { value: 'L', label: 'L' },
          ]}
          value={cardSize}
          onChange={setCardSize}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-secondary">Thumbnail Scale</span>
        <Segment<ThumbnailScale>
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'fill', label: 'Fill' },
          ]}
          value={thumbnailScale}
          onChange={setThumbnailScale}
        />
      </div>
    </>
  )

  return (
    <>
      {sizeFirst ? (
        <>
          {sizeRows}
          {layoutRow}
        </>
      ) : (
        <>
          {layoutRow}
          {sizeRows}
        </>
      )}

      {/* Aspect Ratio — only in grid mode */}
      {layout === 'grid' && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Aspect Ratio</span>
          <Segment<AspectRatio>
            options={[
              { value: 'landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" /> },
              { value: 'square', icon: <Square className="h-3.5 w-3.5" /> },
              { value: 'portrait', icon: <RectangleVertical className="h-3.5 w-3.5" /> },
            ]}
            value={aspectRatio}
            onChange={setAspectRatio}
          />
        </div>
      )}

      {/* Show Card Info */}
      <ToggleRow label="Show Card Info" checked={showCardInfo} onCheckedChange={setShowCardInfo} />

      {/* Titles */}
      {showCardInfo && (
        <SelectRow
          label="Titles"
          value={titleLines}
          options={[
            { value: '1', label: '1 Line' },
            { value: '2', label: '2 Lines' },
            { value: '3', label: '3 Lines' },
          ]}
          onChange={(v) => setTitleLines(v as TitleLines)}
        />
      )}

      {/* Flatten Folders */}
      <ToggleRow label="Flatten Folders" checked={flattenFolders} onCheckedChange={setFlattenFolders} />

      {/* Fields section */}
      <div className="pt-1 border-t border-white/10">
        <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2.5">Fields</p>
        <div className="space-y-3">
          <ToggleRow label="File Size" checked={showFileSize} onCheckedChange={setShowFileSize} />
          <ToggleRow label="Uploaded By" checked={showUploader} onCheckedChange={setShowUploader} />
        </div>
      </div>
    </>
  )
}

// ─── Main popover ───────────────────────────────────────────────────────────

export function AppearancePopover() {
  // No store read here any more — AppearanceControls owns that, so the
  // popover is just the trigger and the surface.
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors">
          <SlidersHorizontal className="h-4 w-4" />
          Appearance
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-xl border border-white/10 bg-[#1a1a1f] shadow-2xl p-4 space-y-4
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <AppearanceControls />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
