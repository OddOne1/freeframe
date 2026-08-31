'use client'

import * as React from 'react'
import { renderedMediaBox } from '@/lib/media-frame'

/**
 * Wraps children so they sit exactly over the visible picture, excluding the
 * empty bands `object-contain` leaves around it.
 *
 * Annotations are AUTHORED inside this constraint (image-frame coordinates), so
 * every viewer that renders them must mount the overlay in the same space —
 * otherwise the same drawing lands somewhere else whenever the container's
 * aspect ratio differs from the one it was drawn in.
 *
 * PORTING NOTE (§107): upstream's current version of this file also consumes a
 * `MediaFrameContext` from a later refactor, which this fork deliberately does
 * NOT take — that context is what would put image annotations on a different
 * coordinate basis from our video ones. What IS taken is the pure geometry
 * (`lib/media-frame`), because the first version written here measured the
 * PARENT CONTAINER and that is simply wrong for an `<img>`: with
 * `max-w-full max-h-full` the element already hugs the picture and never scales
 * up, so deriving the box from the container silently enlarges it for any image
 * smaller than its pane. Measuring the element's own box is correct for that
 * and for the `w-full h-full` case <video> uses, which is why
 * VideoFrameConstraint's container-based math agrees with it wherever the
 * element fills its container.
 */
export function ImageFrameConstraint({
  imgRef,
  children,
  className,
}: {
  imgRef: React.RefObject<HTMLImageElement>
  children: React.ReactNode
  className?: string
}) {
  const [style, setStyle] = React.useState<React.CSSProperties>({})

  React.useEffect(() => {
    const img = imgRef.current
    if (!img) return

    const calc = () => {
      const box = renderedMediaBox({
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        elementWidth: img.offsetWidth,
        elementHeight: img.offsetHeight,
        offsetLeft: img.offsetLeft,
        offsetTop: img.offsetTop,
      })
      // Not laid out yet — fill the parent, same fallback the video
      // constraint uses before metadata arrives. The `load` listener and the
      // observer below re-run this once there is something to measure.
      if (!box) {
        setStyle({ position: 'absolute', inset: 0 })
        return
      }
      setStyle({ position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height })
    }

    calc()
    // `load` is the image equivalent of the video's `loadedmetadata`: before it
    // fires naturalWidth is 0 and only the element box is known.
    img.addEventListener('load', calc)

    // Absent in SSR and older browsers; the measurement above still stands.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(calc) : null
    ro?.observe(img)
    if (img.parentElement) ro?.observe(img.parentElement)

    return () => {
      img.removeEventListener('load', calc)
      ro?.disconnect()
    }
  }, [imgRef])

  return (
    <div style={style} className={className}>
      {children}
    </div>
  )
}
