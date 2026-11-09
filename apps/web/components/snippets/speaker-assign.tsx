'use client'

/**
 * Naming the speaker on a file's audio track, shared by the Files tab and the
 * clip cards: the speaker select (the roster plus "Add new speaker"), the
 * add-speaker dialog, and the clip card's "Tracks" control.
 *
 * PUT /media-files/{id}/snippet/tracks/{n}/speaker also re-runs clip
 * detection for that file. Detection only replaces untouched auto
 * suggestions: edited, approved, rejected, imported and manual clips stay.
 */
import * as React from 'react'
import useSWR, { useSWRConfig } from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import * as Select from '@radix-ui/react-select'
import { AlertTriangle, AudioLines, Check, ChevronDown, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { errorMessage, snippetApi, snippetFetcher, snippetKeys } from '@/lib/snippet-api'
import { detectSummaryText } from '@/lib/snippet-files'
import { Button } from '@/components/ui/button'
import { useOptionalToast } from '@/components/shared/toast'
import type { SnippetSpeaker, SnippetTrack, SnippetTrackSpeakerResponse } from '@/types'

/** What a person is told after naming a speaker from a clip. */
export const REDETECT_NOTE =
  'Clips of this file are re-detected. Edited and approved clips are kept.'

/** Radix Select reserves "" (it shows the placeholder), so "add" gets a sentinel. */
const ADD_NEW = '__add_new_speaker__'

export function SpeakerSelect({
  value,
  fallbackName,
  hasSpeech = true,
  warn = false,
  speakers,
  disabled,
  busy,
  label,
  onChange,
  onAdd,
  className,
  placeholder,
  autoFocus,
}: {
  value: string | null
  /** The name the list row carries, for a speaker the roster has not loaded yet. */
  fallbackName: string | null
  /** False for a track the last run found no speech on. */
  hasSpeech?: boolean
  /** No speaker on a track of a processed file that may have speech. */
  warn?: boolean
  speakers: SnippetSpeaker[]
  disabled: boolean
  busy: boolean
  label: string
  onChange: (speakerId: string) => void
  onAdd: () => void
  className?: string
  /** Shown with no speaker; by default whether the track has speech. */
  placeholder?: string
  autoFocus?: boolean
}) {
  const options =
    value && !speakers.some((s) => s.id === value)
      ? [{ id: value, name: fallbackName ?? 'Unknown' }, ...speakers]
      : speakers
  const missing = !value && warn
  return (
    <Select.Root
      value={value ?? ''}
      disabled={disabled || busy}
      onValueChange={(v) => {
        if (v === ADD_NEW) onAdd()
        else if (v && v !== value) onChange(v)
      }}
    >
      <Select.Trigger
        aria-label={label}
        aria-busy={busy || undefined}
        autoFocus={autoFocus}
        className={cn(
          'inline-flex h-8 hover-none:h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border bg-bg-primary px-2.5 text-xs text-text-primary transition-colors hover:bg-bg-tertiary focus:outline-none focus:ring-1 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50 lg:max-w-[14rem]',
          missing ? 'border-status-warning/50' : 'border-border',
          className,
        )}
      >
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            !value && (missing ? 'font-medium text-status-warning' : 'text-text-tertiary'),
          )}
        >
          {missing && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="truncate">
            <Select.Value placeholder={placeholder ?? (hasSpeech ? 'no speaker yet' : 'no speech found')} />
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-[70] min-w-[12rem] max-h-[60vh] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl"
        >
          <Select.Viewport className="p-1">
            {options.map((s) => (
              <Select.Item
                key={s.id}
                value={s.id}
                className="relative flex cursor-pointer items-center gap-2 rounded-sm px-7 py-1.5 hover-none:py-2.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
              >
                <Select.ItemIndicator className="absolute left-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </Select.ItemIndicator>
                <Select.ItemText>{s.name}</Select.ItemText>
              </Select.Item>
            ))}
            {options.length > 0 && <Select.Separator className="my-1 h-px bg-border" />}
            <Select.Item
              value={ADD_NEW}
              className="relative flex cursor-pointer items-center gap-2 rounded-sm px-7 py-1.5 hover-none:py-2.5 text-sm text-accent outline-none data-[highlighted]:bg-bg-hover"
            >
              <Plus className="absolute left-2 h-3.5 w-3.5" aria-hidden />
              <Select.ItemText>Add new speaker…</Select.ItemText>
            </Select.Item>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export interface AddSpeakerTarget {
  fileName: string
  trackLabel: string | null
}

export function AddSpeakerDialog({
  target,
  onOpenChange,
  onAdd,
}: {
  /** Keep this object stable while the dialog is open: a new one resets the field. */
  target: AddSpeakerTarget | null
  onOpenChange: (open: boolean) => void
  onAdd: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (target) {
      setName('')
      setError(null)
    }
  }, [target])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Enter a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onAdd(name.trim())
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err, 'Could not add the speaker.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={target !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold text-text-primary">Add a speaker</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1.5 text-sm text-text-tertiary">
            Added to this project&apos;s speakers and put on {target?.trackLabel ?? 'the track'} of {target?.fileName}.
          </Dialog.Description>
          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs text-text-secondary">Name</span>
              <input
                autoFocus
                value={name}
                maxLength={255}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 h-9 hover-none:h-11 w-full rounded-md border border-border bg-bg-primary px-3 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-border-focus"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-status-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                Add and assign
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ─── From a clip ─────────────────────────────────────────────────────────────

/**
 * Assigning speakers to one file's tracks from a clip card. After a change
 * the tracks, this file's transcripts and the clip list are read again
 * (`onChanged`), and `note` says what happened.
 */
export function useTrackSpeakerAssign({
  projectId,
  mediaFileId,
  fileName,
  onChanged,
}: {
  projectId: string
  mediaFileId: string
  fileName: string
  onChanged: (res: SnippetTrackSpeakerResponse) => void
}) {
  const toast = useOptionalToast()
  const { mutate } = useSWRConfig()
  const [busyTrack, setBusyTrack] = React.useState<number | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<{ track: number; label: string | null } | null>(null)
  const addingTarget = React.useMemo<AddSpeakerTarget | null>(
    () => (adding ? { fileName, trackLabel: adding.label } : null),
    [adding, fileName],
  )

  const assign = React.useCallback(
    async (trackIndex: number, speakerId: string) => {
      setBusyTrack(trackIndex)
      try {
        const res = await snippetApi.setTrackSpeaker(mediaFileId, trackIndex, speakerId)
        const detectFailed = res.detect_summary?.reason?.startsWith('Clip detection failed') ?? false
        toast(detectSummaryText(res.detect_summary), detectFailed ? 'error' : 'success')
        setNote(REDETECT_NOTE)
        const transcriptPrefix = `/media-files/${mediaFileId}/snippet/transcript`
        await Promise.all([
          mutate(snippetKeys.tracks(mediaFileId)),
          mutate((key) => typeof key === 'string' && key.startsWith(transcriptPrefix)),
        ])
        onChanged(res)
      } catch (err) {
        toast(errorMessage(err, 'Could not save the speaker.'), 'error')
      } finally {
        setBusyTrack(null)
      }
    },
    [mediaFileId, mutate, onChanged, toast],
  )

  const addAndAssign = React.useCallback(
    async (name: string) => {
      if (!adding) return
      const speaker = await snippetApi.createSpeaker(projectId, name)
      await mutate(
        snippetKeys.speakers(projectId),
        (cur: SnippetSpeaker[] | undefined) =>
          cur?.some((s) => s.id === speaker.id) ? cur : [...(cur ?? []), speaker],
        { revalidate: false },
      )
      await assign(adding.track, speaker.id)
    },
    [adding, assign, mutate, projectId],
  )

  const dialog = (
    <AddSpeakerDialog
      target={addingTarget}
      onOpenChange={(open) => {
        if (!open) setAdding(null)
      }}
      onAdd={addAndAssign}
    />
  )

  return {
    busyTrack,
    note,
    assign,
    startAdd: (track: number, label: string | null) => setAdding({ track, label }),
    dialog,
  }
}

export type TrackSpeakerAssign = ReturnType<typeof useTrackSpeakerAssign>

/**
 * The expanded card's "Tracks" button: every track of the clip's file with
 * a speaker select. `focusTrack` opens it on one track (a transcript
 * speaker label was clicked).
 */
export function ClipTracksControl({
  mediaFileId,
  fileName,
  speakers,
  assignApi,
  open,
  onOpenChange,
  focusTrack,
}: {
  mediaFileId: string
  fileName: string
  speakers: SnippetSpeaker[]
  assignApi: TrackSpeakerAssign
  open: boolean
  onOpenChange: (open: boolean) => void
  focusTrack: number | null
}) {
  const tracks = useSWR<SnippetTrack[]>(open ? snippetKeys.tracks(mediaFileId) : null, snippetFetcher, {
    shouldRetryOnError: false,
  })
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs" aria-label={`Speakers per track of ${fileName}`}>
          <AudioLines className="h-3.5 w-3.5" aria-hidden />
          Tracks
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-[60] w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-border bg-bg-secondary p-3 shadow-xl"
        >
          <div>
            <p className="text-sm font-semibold text-text-primary">Speakers per track</p>
            <p className="truncate text-xs text-text-tertiary" title={fileName}>
              {fileName}
            </p>
          </div>
          {tracks.isLoading && !tracks.data ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className="h-8 animate-pulse rounded bg-bg-tertiary" />
              ))}
            </div>
          ) : tracks.error && !tracks.data ? (
            <div className="space-y-2 text-xs text-text-secondary">
              <p role="alert">Could not load the tracks. {errorMessage(tracks.error)}</p>
              <Button type="button" size="sm" variant="secondary" onClick={() => void tracks.mutate()}>
                Retry
              </Button>
            </div>
          ) : (tracks.data ?? []).length === 0 ? (
            <p className="text-xs text-text-tertiary">No audio tracks known for this file yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {(tracks.data ?? []).map((t) => (
                <li
                  key={t.track_index}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md p-1',
                    focusTrack === t.track_index && 'bg-accent/10 ring-1 ring-accent/40',
                  )}
                >
                  <span className="w-24 shrink-0 truncate text-xs text-text-tertiary" title={t.label}>
                    {t.label}
                  </span>
                  <SpeakerSelect
                    value={t.speaker_id}
                    fallbackName={t.speaker_name}
                    speakers={speakers}
                    disabled={false}
                    busy={assignApi.busyTrack === t.track_index}
                    label={`Speaker on ${t.label}, ${fileName}`}
                    onChange={(id) => void assignApi.assign(t.track_index, id)}
                    onAdd={() => {
                      onOpenChange(false)
                      assignApi.startAdd(t.track_index, t.label)
                    }}
                    autoFocus={focusTrack === t.track_index}
                    className="lg:max-w-none"
                  />
                </li>
              ))}
            </ul>
          )}
          <p className="text-2xs text-text-tertiary" role="status">
            {assignApi.note ?? 'Naming a speaker re-detects this file’s clip suggestions; edited and approved clips are kept.'}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
