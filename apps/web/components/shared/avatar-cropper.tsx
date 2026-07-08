'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface AvatarCropperProps {
  file: File | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCropped: (blob: Blob) => void
  saving?: boolean
}

// Visual size of the circular crop preview, in CSS px.
const CROP_SIZE = 240
// Final exported square, in px. Kept small on purpose — this is a low-res
// thumbnail (avatar), not a full-size photo, to keep S3 storage cheap.
const OUTPUT_SIZE = 256
const MIN_ZOOM = 1
const MAX_ZOOM = 3

/**
 * Lets a user pan/zoom their uploaded photo within a circular frame before
 * it's saved as their avatar. Deliberately built on plain <canvas> + pointer
 * events instead of a cropping library — this app has no existing image-crop
 * dependency, and the math here is small enough not to justify adding one.
 */
export function AvatarCropper({ file, open, onOpenChange, onCropped, saving }: AvatarCropperProps) {
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
  const [imgSize, setImgSize] = React.useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const dragRef = React.useRef<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null)
  const imgElRef = React.useRef<HTMLImageElement | null>(null)

  // Load the file into an object URL + read its natural dimensions
  React.useEffect(() => {
    if (!file || !open) return
    const url = URL.createObjectURL(file)
    setObjectUrl(url)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    const img = new Image()
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file, open])

  const baseScale = imgSize ? CROP_SIZE / Math.min(imgSize.w, imgSize.h) : 1
  const effectiveScale = baseScale * zoom
  const displayW = imgSize ? imgSize.w * effectiveScale : 0
  const displayH = imgSize ? imgSize.h * effectiveScale : 0

  const clampOffset = React.useCallback(
    (next: { x: number; y: number }, currentDisplayW = displayW, currentDisplayH = displayH) => {
      const maxX = Math.max(0, (currentDisplayW - CROP_SIZE) / 2)
      const maxY = Math.max(0, (currentDisplayH - CROP_SIZE) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      }
    },
    [displayW, displayH],
  )

  function handlePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: offset }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setOffset(clampOffset({ x: dragRef.current.origin.x + dx, y: dragRef.current.origin.y + dy }))
  }

  function handlePointerUp() {
    dragRef.current = null
  }

  function handleZoomChange(next: number) {
    setZoom(next)
    // Re-clamp with the new effective scale so panning to an edge, then
    // zooming out, doesn't leave a gap inside the circle.
    const newDisplayW = imgSize ? imgSize.w * baseScale * next : 0
    const newDisplayH = imgSize ? imgSize.h * baseScale * next : 0
    setOffset((prev) => clampOffset(prev, newDisplayW, newDisplayH))
  }

  function handleSave() {
    const img = imgElRef.current
    if (!img || !imgSize) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const imgLeftInPreview = CROP_SIZE / 2 - displayW / 2 + offset.x
    const imgTopInPreview = CROP_SIZE / 2 - displayH / 2 + offset.y
    const sx = Math.max(0, Math.min(imgSize.w, -imgLeftInPreview / effectiveScale))
    const sy = Math.max(0, Math.min(imgSize.h, -imgTopInPreview / effectiveScale))
    const sSize = CROP_SIZE / effectiveScale

    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    canvas.toBlob(
      (blob) => {
        if (blob) onCropped(blob)
      },
      'image/webp',
      0.85,
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-5 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-3 top-3 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="text-sm font-semibold text-text-primary">
            Adjust your photo
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-tertiary">
            Drag to reposition, use the slider to zoom.
          </Dialog.Description>

          <div className="mt-4 flex justify-center">
            <div
              className="relative overflow-hidden rounded-full border border-border bg-bg-tertiary touch-none cursor-grab active:cursor-grabbing"
              style={{ width: CROP_SIZE, height: CROP_SIZE }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              {objectUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={imgElRef}
                  src={objectUrl}
                  alt="Crop preview"
                  draggable={false}
                  className="absolute top-1/2 left-1/2 select-none"
                  style={{
                    width: displayW || undefined,
                    height: displayH || undefined,
                    transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                  }}
                />
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2.5">
            <ZoomIn className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              value={zoom}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={!objectUrl} loading={saving}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
