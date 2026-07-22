'use client'

import * as React from 'react'
import { ChevronDown, Check } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { cn } from '@/lib/utils'
import type { MetadataField, MetadataFieldType } from '@/types'

// ─── Custom field renderer ────────────────────────────────────────────────────

export function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: MetadataField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const type = field.field_type as MetadataFieldType

  if (type === 'text') {
    return (
      <input
        type="text"
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        placeholder={`Enter ${field.name.toLowerCase()}`}
      />
    )
  }

  if (type === 'number') {
    return (
      <input
        type="number"
        value={(value as number) ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        placeholder="0"
      />
    )
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
      />
    )
  }

  if (type === 'select') {
    const opts = (field.options as string[]) ?? []
    const current = (value as string) ?? ''
    return (
      <Select.Root value={current} onValueChange={onChange}>
        <Select.Trigger className="inline-flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-8 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus w-full">
          <Select.Value placeholder={`Select ${field.name}`} />
          <ChevronDown className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl">
            <Select.Viewport className="p-1">
              {opts.map((opt) => (
                <Select.Item
                  key={opt}
                  value={opt}
                  className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  <Select.ItemIndicator className="absolute left-2">
                    <Check className="h-3.5 w-3.5 text-accent" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{opt}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    )
  }

  if (type === 'multi_select') {
    const opts = (field.options as string[]) ?? []
    const selected = (value as string[]) ?? []
    const toggle = (opt: string) => {
      if (selected.includes(opt)) {
        onChange(selected.filter((s) => s !== opt))
      } else {
        onChange([...selected, opt])
      }
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {opts.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors',
              selected.includes(opt)
                ? 'bg-accent-muted border-accent text-accent'
                : 'border-border text-text-secondary hover:border-text-secondary',
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    )
  }

  return null
}
