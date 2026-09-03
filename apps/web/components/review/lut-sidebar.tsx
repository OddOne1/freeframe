'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Check, Loader2, Palette, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { CollapsibleSection } from '@/components/shared/collapsible-section'
import { LutThumbnail } from '@/components/shared/lut-thumbnail'
import type { Lut, LutGroup } from '@/types'

/** Survives a reload, like every other panel state in the review page. */
const OPEN_KEY = 'ff-lut-sidebar'

/**
 * Open/closed for the LUT sidebar.
 *
 * Read in a layout effect rather than a useState initializer, for the same
 * reason CollapsibleSection does: this page renders on the server, where
 * localStorage does not exist, so seeding state from it is a hydration
 * mismatch — and a plain effect would let a stored-open sidebar flash shut
 * first.
 */
export function useLutSidebarOpen(): [boolean, () => void] {
  const [open, setOpen] = React.useState(false)
  const useIsomorphicLayoutEffect =
    typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

  useIsomorphicLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(OPEN_KEY)
      if (stored === '1' || stored === '0') setOpen(stored === '1')
    } catch {
      // Private mode or storage disabled: it still toggles, it just forgets.
    }
  }, [])

  const toggle = React.useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
      } catch {
        // As above.
      }
      return next
    })
  }, [])

  return [open, toggle]
}

/**
 * The control that used to open a dropdown, now a sidebar toggle.
 *
 * It still lives inside the media toolbar, floating over arbitrary footage —
 * which is why it now carries a real background. It previously had none at
 * all, just a 1px border and coloured text, so over pale or busy frames the
 * whole control disappeared. `bg-black/40` + `backdrop-blur-sm` matches what
 * the compare stage's own over-media controls already use rather than
 * introducing a second treatment.
 */
export function LutSidebarToggle({
  open,
  onToggle,
  selectedName,
  isLoading,
  className,
}: {
  open: boolean
  onToggle: () => void
  selectedName: string | null
  isLoading?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Color LUT"
      title={selectedName ? `LUT: ${selectedName}` : 'No LUT applied'}
      className={cn(
        'flex h-7 shrink-0 items-center gap-1.5 rounded border px-2 text-xs',
        'bg-black/40 backdrop-blur-sm transition-colors',
        selectedName || open
          ? 'border-accent text-accent'
          : 'border-white/25 text-white/80 hover:text-white',
        className,
      )}
    >
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Palette className="h-3.5 w-3.5" />
      )}
      {/* No max-width clamp: the sidebar carries the full names, and this
          label only ever holds one of them. */}
      <span className="max-w-[160px] truncate">{selectedName ?? 'LUT'}</span>
    </button>
  )
}

interface LutSidebarProps {
  luts: Lut[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onClose: () => void
  isLoading?: boolean
  /** Called after a successful inline upload so the list can revalidate. */
  onUploaded?: (lut: Lut) => void
}

/**
 * The LUT list, as a column beside the frame rather than a dropdown over it.
 *
 * It was a 240px `DropdownMenu.Content` anchored `align="end"`, which grows
 * LEFTWARD from its trigger — and the trigger sits near the left of the
 * transport bar, so the panel ran straight into the nav. A panel in its own
 * flex column cannot collide with anything by construction, and it has room
 * for group headers and full LUT names.
 *
 * Mirrors the review page's right-hand comments panel: same surface, same
 * border treatment, same shrink-0 column — flipped to the left.
 */
export function LutSidebar({
  luts,
  selectedId,
  onSelect,
  onClose,
  isLoading,
  onUploaded,
}: LutSidebarProps) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Group NAMES are not on the LUT — only group_id is (already present on
  // every LUT this receives). These two endpoints already exist and are what
  // Settings → LUTs reads; no backend change is needed to render the tree.
  const { data: ownGroups } = useSWR<LutGroup[]>('/me/lut-groups', (k: string) =>
    api.get<LutGroup[]>(k),
  )
  const { data: platformGroups } = useSWR<LutGroup[]>('/luts/platform-groups', (k: string) =>
    api.get<LutGroup[]>(k),
  )

  const groups = React.useMemo(
    () => [...(ownGroups ?? []), ...(platformGroups ?? [])],
    [ownGroups, platformGroups],
  )

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

  const row = (lut: Lut) => (
    <button
      key={lut.id}
      type="button"
      onClick={() => onSelect(lut.id)}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs',
        'transition-colors hover:bg-bg-hover',
        selectedId === lut.id ? 'text-accent' : 'text-text-primary',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <LutThumbnail lut={lut} className="h-4 w-6 shrink-0" />
        {/* Wraps rather than truncating: the old 240px dropdown clipped real
            LUT names, and a column this wide has room for two lines. */}
        <span className="min-w-0 break-words">{lut.name}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {lut.lut_size && (
          <span className="text-2xs tabular-nums text-text-tertiary">{lut.lut_size}³</span>
        )}
        {selectedId === lut.id && <Check className="h-3.5 w-3.5 text-accent" />}
      </span>
    </button>
  )

  /**
   * One group and, beneath it, its sub-groups — the same one-level nesting
   * Settings → LUTs renders (§45), resolved the same way rather than by a
   * second implementation: members are the LUTs whose group_id is this
   * group's, children are the groups whose parent_group_id is.
   *
   * `storageKey` is scoped per side so a group folded in "In this project"
   * does not silently fold the same group under "Your library".
   */
  const groupTree = (
    group: LutGroup,
    pool: Lut[],
    side: string,
    nested = false,
  ): React.ReactNode => {
    const members = pool.filter((l) => l.group_id === group.id)
    const children = nested ? [] : groups.filter((g) => g.parent_group_id === group.id)
    const childMembers = children.flatMap((c) => pool.filter((l) => l.group_id === c.id))
    if (members.length === 0 && childMembers.length === 0) return null

    return (
      <CollapsibleSection
        key={group.id}
        title={group.name}
        count={members.length + childMembers.length}
        storageKey={`lut-side-${side}-${group.id}`}
        tone="plain"
        // Stepped so the hierarchy reads at a glance: section, group,
        // sub-group. Without the first step a top-level group sits at the
        // same indent as the section holding it.
        className={nested ? 'pl-3' : 'pl-2'}
      >
        <div className="space-y-0.5">
          {members.map(row)}
          {children.map((child) => groupTree(child, pool, side, true))}
        </div>
      </CollapsibleSection>
    )
  }

  /** One side of the existing personal/shared split, with its group tree. */
  const section = (label: string, pool: Lut[], side: string, note?: string) => {
    if (pool.length === 0) return null
    const roots = groups.filter((g) => !g.parent_group_id)
    const trees = roots.map((g) => groupTree(g, pool, side)).filter(Boolean)
    // Anything whose group_id resolves to no group the viewer can see —
    // including a shared LUT filed under another user's private group, whose
    // name this client has no way to read — lands here rather than vanishing.
    const loose = pool.filter(
      (l) => !l.group_id || !groups.some((g) => g.id === l.group_id),
    )
    return (
      <CollapsibleSection
        title={label}
        count={pool.length}
        storageKey={`lut-side-${side}`}
        tone="plain"
      >
        {note && <p className="px-2 pb-1 text-2xs text-text-tertiary">{note}</p>}
        <div className="space-y-1">
          {trees}
          <div className="space-y-0.5">{loose.map(row)}</div>
        </div>
      </CollapsibleSection>
    )
  }

  const shared = luts.filter((l) => l.shared_with_project)
  const personal = luts.filter((l) => !l.shared_with_project)

  return (
    <div
      data-testid="lut-sidebar"
      className="flex w-[260px] shrink-0 flex-col border-r border-border bg-bg-secondary animate-in slide-in-from-left-2 duration-150"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-primary">LUTs</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close LUT panel"
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs',
            'transition-colors hover:bg-bg-hover',
            selectedId === null ? 'text-accent' : 'text-text-secondary',
          )}
        >
          {/* The reference frame ungraded — the before, against which every
              swatch below it is the after. */}
          <span className="flex items-center gap-2">
            <LutThumbnail lut={null} className="h-4 w-6 shrink-0" />
            None
          </span>
          {selectedId === null && <Check className="h-3.5 w-3.5 text-accent" />}
        </button>

        {isLoading && (
          <p className="px-2 py-1 text-2xs text-text-tertiary">Loading…</p>
        )}

        {section('In this project', shared, 'shared')}
        {section('Your library', personal, 'personal', 'Preview only until shared.')}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        <input ref={fileRef} type="file" accept=".cube" onChange={handleFile} className="hidden" />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload .cube…
        </button>
        {error && <p className="px-2 pt-1 text-2xs text-red-400">{error}</p>}
      </div>
    </div>
  )
}
