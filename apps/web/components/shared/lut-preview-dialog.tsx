'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, X } from 'lucide-react'
import { useLutPreview } from '@/hooks/use-lut-thumbnail'
import { REFERENCE_IMAGE_SRC } from '@/lib/lut/lut-thumbnail'
import type { Lut } from '@/types'

interface LutPreviewDialogProps {
  /** The LUT being looked at, or null when nothing is. Open state is derived
   *  from this rather than tracked twice. */
  lut: Lut | null
  onOpenChange: (open: boolean) => void
}

/**
 * The reference frame through one LUT, big enough to actually judge — the
 * zoom behind a Settings row's swatch.
 *
 * The frame is re-rendered at this size rather than the 48px swatch being
 * scaled up, so it is sharp; see lut-thumbnail.ts's PREVIEW variant. It is
 * shown beside the ungraded frame, since "what does this LUT do" is a
 * question about the difference, not about the graded image alone.
 */
export function LutPreviewDialog({ lut, onOpenChange }: LutPreviewDialogProps) {
  const { src, status } = useLutPreview(lut?.id ?? null, lut?.file_url)

  return (
    <Dialog.Root open={lut !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-medium text-text-primary">
                {lut?.name ?? ''}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-text-tertiary">
                A fixed reference frame, graded by this LUT.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <figure className="m-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={REFERENCE_IMAGE_SRC}
                alt=""
                aria-hidden="true"
                className="aspect-[3/2] w-full rounded-lg border border-border object-cover"
              />
              <figcaption className="mt-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
                Ungraded
              </figcaption>
            </figure>

            <figure className="m-0">
              <div
                data-testid="lut-preview-frame"
                className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-tertiary"
              >
                {status === 'ready' && src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src} alt="" aria-hidden="true" className="h-full w-full object-cover" />
                ) : status === 'error' ? (
                  <p className="px-4 text-center text-xs text-text-tertiary">
                    This LUT could not be previewed.
                  </p>
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
                )}
              </div>
              <figcaption className="mt-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
                Graded
              </figcaption>
            </figure>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
