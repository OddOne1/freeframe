'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { Badge } from '@/components/shared/badge'
import { cn } from '@/lib/utils'
import type { AssetStatus } from '@/types'

const STATUS_OPTIONS: AssetStatus[] = ['draft', 'in_review', 'in_progress', 'approved', 'rejected', 'archived']

interface StatusDropdownProps {
  status: AssetStatus
  onChange?: (status: AssetStatus) => void
  readOnly?: boolean
  canArchive?: boolean
  className?: string
}

export function StatusDropdown({
  status,
  onChange,
  readOnly = false,
  canArchive = false,
  className,
}: StatusDropdownProps) {
  if (readOnly || !onChange) {
    return <Badge status={status} className={cn('h-8 px-2.5', className)} />
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-tertiary px-2.5 h-8 outline-none hover:bg-bg-hover transition-colors',
            className,
          )}
        >
          <Badge status={status} />
          <ChevronDown className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-[100] min-w-[170px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {STATUS_OPTIONS.filter((s) => s !== 'archived' || canArchive).map((s) => (
            <DropdownMenu.Item
              key={s}
              onSelect={() => onChange(s)}
              className="flex items-center justify-between gap-2.5 mx-1 px-2.5 py-1.5 rounded-lg cursor-pointer outline-none hover:bg-bg-hover transition-colors"
            >
              <Badge status={s} />
              {status === s && <Check className="h-3.5 w-3.5 text-accent shrink-0" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
