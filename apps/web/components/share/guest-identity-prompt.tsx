'use client'

import * as React from 'react'
import type { GuestIdentity } from '@/lib/guest-identity'

/**
 * Ask a guest who they are, once per share link (§209 part C).
 *
 * Moved out of folder-share-viewer.tsx and shared, because replies now go
 * through the same gate as new comments — see useGuestIdentity. The copy is
 * no longer "Leave a comment", since this same dialog now also fronts a
 * reply.
 *
 * Deliberately NOT implying verification. The address is self-declared, and
 * nothing in FreeFrame checks it — no code is sent, no link is clicked. The
 * sentence about remembering says where it is kept and nothing more, so the
 * screen cannot be read as "we confirmed this is you".
 */
export function GuestIdentityPrompt({
  title = 'Add your name',
  onSave,
  onCancel,
  initial,
}: {
  title?: string
  onSave: (identity: GuestIdentity) => void
  onCancel: () => void
  /** Prefill, for a re-prompt after "Not you?" — never auto-submitted. */
  initial?: GuestIdentity | null
}) {
  const [name, setName] = React.useState(initial?.name ?? '')
  const [email, setEmail] = React.useState(initial?.email ?? '')

  const ready = name.trim().length > 0 && email.trim().length > 0

  function save() {
    if (!ready) return
    onSave({ name: name.trim(), email: email.trim() })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form
        className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
        <p className="text-xs text-text-tertiary mb-4">
          Your name is shown next to what you post here.
        </p>
        <div className="space-y-3">
          <div>
            <label
              htmlFor="guest-name"
              className="block text-xs font-medium text-text-secondary mb-1"
            >
              Your name
            </label>
            <input
              id="guest-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
              autoFocus
            />
          </div>
          <div>
            <label
              htmlFor="guest-email"
              className="block text-xs font-medium text-text-secondary mb-1"
            >
              Email address
            </label>
            <input
              id="guest-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            />
          </div>
        </div>
        {/* §209 — said once, here, rather than beside every box. */}
        <p className="mt-3 text-xs text-text-tertiary">
          We remember your name and email on this device for this link.
        </p>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready}
            className="px-4 py-1.5 rounded-md bg-accent text-xs font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            Continue
          </button>
        </div>
        {/* (17c) — a disabled control says why. */}
        {!ready && (
          <p className="mt-2 text-right text-xs text-text-tertiary">
            Enter a name and an email address to continue.
          </p>
        )}
      </form>
    </div>
  )
}

/**
 * "Commenting as Ada · Not you?" — shown by the composer once an identity is
 * remembered, so a guest can see which name their posts will carry before
 * they write one, and change it without clearing site data.
 */
export function GuestIdentityBadge({
  identity,
  onForget,
}: {
  identity: GuestIdentity
  onForget: () => void
}) {
  return (
    <p className="px-3 py-1.5 text-xs text-text-tertiary">
      Commenting as <span className="text-text-secondary">{identity.name}</span>
      {' · '}
      <button
        type="button"
        onClick={onForget}
        className="underline hover:text-text-primary transition-colors"
      >
        Not you?
      </button>
    </p>
  )
}
