'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Hash, Search, User, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import type { SnippetSpeaker, SnippetSuggest } from '@/types'

/** Debounce for the suggest call, per the prompt. */
const SUGGEST_DEBOUNCE_MS = 200

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

type Option =
  | { kind: 'name'; speaker: SnippetSpeaker }
  | { kind: 'topic'; topic: string; count: number }

/**
 * The search field with name and topic suggestions: an ARIA combobox.
 *
 * Up/Down move through the list, Enter picks the highlighted suggestion (a
 * name becomes a speaker filter, a topic a topic filter) or, with nothing
 * highlighted, runs the text as a search. Escape closes the list, a second
 * Escape clears the text.
 */
export function SnippetSearchBox({
  projectId,
  value,
  onChange,
  onSubmit,
  onPickSpeaker,
  onPickTopic,
}: {
  projectId: string
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  onPickSpeaker: (s: SnippetSpeaker) => void
  onPickTopic: (t: string) => void
}) {
  const listId = React.useId()
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)
  const debounced = useDebounced(value, SUGGEST_DEBOUNCE_MS)
  const { data, isLoading } = useSWR<SnippetSuggest>(
    open ? snippetKeys.suggest(projectId, debounced) : null,
    snippetFetcher,
    { keepPreviousData: true, shouldRetryOnError: false },
  )

  const options: Option[] = React.useMemo(
    () => [
      ...(data?.names ?? []).map((speaker) => ({ kind: 'name' as const, speaker })),
      ...(data?.topics ?? []).map((t) => ({ kind: 'topic' as const, topic: t.topic, count: t.count })),
    ],
    [data],
  )

  React.useEffect(() => setActive(-1), [debounced])

  function pick(o: Option) {
    if (o.kind === 'name') onPickSpeaker(o.speaker)
    else onPickTopic(o.topic)
    onChange('')
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (options.length ? (i + 1) % options.length : -1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (options.length ? (i <= 0 ? options.length - 1 : i - 1) : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (open && active >= 0 && options[active]) pick(options[active])
      else {
        onSubmit(value)
        setOpen(false)
      }
    } else if (e.key === 'Escape') {
      // A type="search" input clears itself on Escape natively, which
      // would throw the text away when all that was asked was to close
      // the list. The first Escape closes, the second clears, by hand.
      e.preventDefault()
      if (open) setOpen(false)
      else if (value) {
        onChange('')
        onSubmit('')
      }
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`
  const names = options.filter((o) => o.kind === 'name')
  const showList = open && options.length > 0

  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
      <input
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
        aria-label="Search clips, speakers and topics"
        placeholder="Search clips, speakers, topics…"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-secondary pl-9 pr-9 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            onSubmit('')
          }}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        hidden={!showList}
        className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-bg-secondary p-1 shadow-xl"
      >
        {options.map((o, i) => {
          const first = i === 0 || options[i - 1].kind !== o.kind
          return (
            <React.Fragment key={o.kind === 'name' ? `n-${o.speaker.id}` : `t-${o.topic}`}>
              {first && (
                <li role="presentation" className="px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-text-tertiary">
                  {o.kind === 'name' ? 'Speakers' : 'Topics'}
                </li>
              )}
              <li
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover-none:py-2.5 text-sm text-text-primary',
                  i === active && 'bg-bg-hover',
                )}
              >
                {o.kind === 'name' ? (
                  <>
                    <User className="h-3.5 w-3.5 text-text-tertiary" aria-hidden />
                    <span className="truncate">{o.speaker.name}</span>
                  </>
                ) : (
                  <>
                    <Hash className="h-3.5 w-3.5 text-text-tertiary" aria-hidden />
                    <span className="truncate">{o.topic}</span>
                    <span className="ml-auto text-2xs tabular-nums text-text-tertiary">{o.count}</span>
                  </>
                )}
              </li>
            </React.Fragment>
          )
        })}
      </ul>
      <span className="sr-only" aria-live="polite">
        {showList ? `${names.length} speakers, ${options.length - names.length} topics suggested` : isLoading ? 'Loading suggestions' : ''}
      </span>
    </div>
  )
}
