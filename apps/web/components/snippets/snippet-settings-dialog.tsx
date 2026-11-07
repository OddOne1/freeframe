'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFolders } from '@/hooks/use-folders'
import { errorMessage, snippetApi } from '@/lib/snippet-api'
import type { FolderTreeNode, SnippetAspect, SnippetSettings } from '@/types'
import { LabelledSwitch, SnippetSelect, type SelectOption } from './snippet-ui'

const ASPECTS: SelectOption<SnippetAspect>[] = [
  { value: '9:16', label: '9:16 vertical' },
  { value: '16:9', label: '16:9 landscape' },
  { value: '1:1', label: '1:1 square' },
  { value: '4:5', label: '4:5 portrait' },
  { value: '3:4', label: '3:4 portrait' },
  { value: '4:3', label: '4:3 classic' },
]

/** Radix Select reserves "" so the whole project gets a sentinel. */
const WHOLE_PROJECT = '__whole_project__'

function flatten(nodes: FolderTreeNode[] | undefined, depth = 0): SelectOption<string>[] {
  if (!nodes) return []
  return nodes.flatMap((n) => [
    { value: n.id, label: `${'— '.repeat(depth)}${n.name}` },
    ...flatten(n.children, depth + 1),
  ])
}

const DEFAULTS: SnippetSettings = {
  enabled: false,
  source_folder_id: null,
  export_retention_days: 30,
  export_aspect: '9:16',
  caption_font: null,
}

/**
 * The owner's SocialSnippet settings. Saving does NOT queue any
 * transcription: that is POST /snippet/process, one batch of assets at a
 * time, so turning the feature on cannot saturate the worker.
 */
export function SnippetSettingsDialog({
  projectId,
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: SnippetSettings | undefined
  onSaved: (s: SnippetSettings) => void
}) {
  const { tree } = useFolders(open ? projectId : '')
  const [draft, setDraft] = React.useState<SnippetSettings>(settings ?? DEFAULTS)
  const [retentionText, setRetentionText] = React.useState('30')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    const s = settings ?? DEFAULTS
    setDraft({ ...s, enabled: settings ? s.enabled : true })
    setRetentionText(String(s.export_retention_days ?? 30))
    setError(null)
  }, [open, settings])

  const keepForever = draft.export_retention_days === null
  const folderOptions: SelectOption<string>[] = [{ value: WHOLE_PROJECT, label: 'Whole project' }, ...flatten(tree)]

  async function save(e: React.FormEvent) {
    e.preventDefault()
    let retention: number | null = null
    if (!keepForever) {
      const n = Number(retentionText)
      if (!Number.isInteger(n) || n < 1) {
        setError('Retention must be a whole number of days, at least 1.')
        return
      }
      retention = n
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await snippetApi.patchSettings(projectId, {
        enabled: draft.enabled,
        source_folder_id: draft.source_folder_id,
        export_aspect: draft.export_aspect,
        export_retention_days: retention,
      })
      onSaved(saved)
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err, 'Could not save the settings.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl max-h-[90vh] overflow-y-auto data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close
            className="absolute right-4 top-4 rounded text-text-tertiary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">SocialSnippet settings</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Find short clips in this project&apos;s transcripts. Turning it on does not transcribe anything by
            itself.
          </Dialog.Description>

          <form onSubmit={save} className="mt-5 space-y-5">
            <LabelledSwitch
              label="Enable SocialSnippet"
              description="Members see a SocialSnippet link above Share Links."
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />

            <div className="space-y-1.5">
              <p className="text-sm font-medium text-text-secondary">Source folder</p>
              <SnippetSelect
                label="Folder"
                className="w-full"
                value={draft.source_folder_id ?? WHOLE_PROJECT}
                onChange={(v) => setDraft((d) => ({ ...d, source_folder_id: v === WHOLE_PROJECT ? null : v }))}
                options={folderOptions}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium text-text-secondary">Default export shape</p>
              <SnippetSelect
                label="Aspect"
                className="w-full"
                value={draft.export_aspect}
                onChange={(export_aspect) => setDraft((d) => ({ ...d, export_aspect }))}
                options={ASPECTS}
              />
            </div>

            <div className="space-y-2">
              <LabelledSwitch
                label="Keep exports forever"
                checked={keepForever}
                onCheckedChange={(forever) =>
                  setDraft((d) => ({
                    ...d,
                    export_retention_days: forever ? null : Number(retentionText) || 30,
                  }))
                }
              />
              {!keepForever && (
                <label className="flex items-center gap-2 text-sm text-text-secondary">
                  Delete exports after
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={retentionText}
                    onChange={(e) => setRetentionText(e.target.value)}
                    className="h-8 hover-none:h-11 w-20 rounded-md border border-border bg-bg-secondary px-2 text-sm text-text-primary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    aria-label="Retention in days"
                  />
                  days
                </label>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-status-error">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={saving}>
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
