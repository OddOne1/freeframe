'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Loader2, Palette, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { Lut } from '@/types'

interface LutPickerProps {
  luts: Lut[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  isLoading?: boolean
  /** Called after a successful inline upload so the list can revalidate. */
  onUploaded?: (lut: Lut) => void
  className?: string
}

/**
 * "None" / this project's shared LUTs / your own unshared ones, plus an
 * inline upload. Styled to match the quality-select beside it in the video
 * transport bar rather than introducing a second dropdown language.
 */
export function LutPicker({
  luts,
  selectedId,
  onSelect,
  isLoading,
  onUploaded,
  className,
}: LutPickerProps) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const selected = luts.find((l) => l.id === selectedId) ?? null

  // Shared LUTs are what the whole team sees; personal-only ones are
  // preview-only until shared, so they're grouped separately rather than
  // mixed in and silently behaving differently when applied.
  const shared = luts.filter((l) => l.shared_with_project)
  const personal = luts.filter((l) => !l.shared_with_project)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked after a failure
    if (!file) return

    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const lut = await api.upload<Lut>('/me/luts', form)
      onUploaded?.(lut)
      onSelect(lut.id)
    } catch (err: unknown) {
      const detail = err && typeof err === 'object' && 'message' in err ? String(err.message) : ''
      setError(detail || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function renderItem(lut: Lut) {
    return (
      <DropdownMenu.Item
        key={lut.id}
        onSelect={() => onSelect(lut.id)}
        className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
      >
        <span className="truncate">{lut.name}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          {lut.lut_size && (
            <span className="text-2xs text-text-tertiary tabular-nums">{lut.lut_size}³</span>
          )}
          {selectedId === lut.id && <Check className="h-3.5 w-3.5 text-accent" />}
        </span>
      </DropdownMenu.Item>
    )
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".cube"
        onChange={handleFile}
        className="hidden"
      />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors shrink-0',
              selected
                ? 'border-accent text-accent'
                : 'border-border text-text-secondary hover:text-text-primary',
              className,
            )}
            aria-label="Color LUT"
            title={selected ? `LUT: ${selected.name}` : 'No LUT applied'}
          >
            {uploading || isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Palette className="h-3.5 w-3.5" />
            )}
            <span className="max-w-[110px] truncate">{selected ? selected.name : 'LUT'}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-[100] w-60 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-xl py-1"
          >
            <DropdownMenu.Item
              onSelect={() => onSelect(null)}
              className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-text-secondary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
            >
              None
              {selectedId === null && <Check className="h-3.5 w-3.5 text-accent" />}
            </DropdownMenu.Item>

            {shared.length > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Label className="px-2.5 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                  In this project
                </DropdownMenu.Label>
                {shared.map(renderItem)}
              </>
            )}

            {personal.length > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Label className="px-2.5 py-1 text-2xs uppercase tracking-wide text-text-tertiary">
                  Your library — preview only
                </DropdownMenu.Label>
                {personal.map(renderItem)}
              </>
            )}

            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault()
                fileRef.current?.click()
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-text-secondary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload .cube…
            </DropdownMenu.Item>

            {error && (
              <p className="px-2.5 py-1.5 text-2xs text-red-400">{error}</p>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}
