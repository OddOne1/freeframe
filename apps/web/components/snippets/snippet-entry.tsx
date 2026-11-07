'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Scissors, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SnippetSettingsDialog } from './snippet-settings-dialog'
import { useSnippetAccess } from './use-snippet-access'

/**
 * The SocialSnippet row the project page shows directly above Share Links,
 * in both of its mounts (the desktop column and the phone/tablet panel).
 *
 *  - enabled                  → "SocialSnippet" link to /projects/{id}/snippets
 *  - disabled, owner          → "Set up SocialSnippet", opens the settings dialog
 *  - disabled, anyone else    → nothing
 *  - 404 (not a member) / 409 → nothing
 *
 * Styled like RecentlyDeletedEntry, the row next to it in the same column.
 */
export function SnippetEntry({ projectId, onSelect }: { projectId: string; onSelect?: () => void }) {
  const pathname = usePathname()
  const { canManage, settings, settingsError, mutateSettings } = useSnippetAccess(projectId)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  const href = `/projects/${projectId}/snippets`
  const enabled = !settingsError && settings?.enabled === true
  const offerSetup = !settingsError && settings && !settings.enabled && canManage

  if (!enabled && !offerSetup) return null

  const row =
    'flex items-center gap-2 px-2 py-1 hover-none:min-h-11 rounded-md text-[13px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

  return (
    <div className="px-3 py-2 border-t border-border" data-testid="snippet-entry">
      {enabled ? (
        <Link
          href={href}
          onClick={onSelect}
          aria-current={pathname === href ? 'page' : undefined}
          className={cn(
            row,
            pathname === href
              ? 'bg-accent/10 text-accent font-medium'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
          )}
        >
          <Scissors className="h-3.5 w-3.5 shrink-0" />
          <span>SocialSnippet</span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className={cn(row, 'w-full text-left text-text-tertiary hover:text-text-secondary hover:bg-bg-hover')}
        >
          <Settings2 className="h-3.5 w-3.5 shrink-0" />
          <span>Set up SocialSnippet</span>
        </button>
      )}
      {canManage && (
        <SnippetSettingsDialog
          projectId={projectId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          settings={settings}
          onSaved={(s) => {
            void mutateSettings(s, { revalidate: false })
            onSelect?.()
          }}
        />
      )}
    </div>
  )
}
