'use client'

import * as React from 'react'
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: string
  type: ToastType
  message: string
  /** Milliseconds before auto-dismiss. Default: 5000. Set to 0 to disable. */
  duration?: number
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface ToastContextValue {
  toasts: ToastItem[]
  toast: (message: string, type?: ToastType, duration?: number) => void
  dismiss: (id: string) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = React.useCallback(
    (message: string, type: ToastType = 'info', duration = 5000) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const item: ToastItem = { id, type, message, duration }
      setToasts((prev) => [...prev, item])

      if (duration > 0) {
        setTimeout(() => dismiss(id), duration)
      }
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast(): Omit<ToastContextValue, 'toasts'> & {
  /** Convenience: show a success toast */
  success: (message: string) => void
  /** Convenience: show an error toast */
  error: (message: string) => void
  /** Convenience: show an info toast */
  info: (message: string) => void
  /** Convenience: show a warning toast */
  warning: (message: string) => void
} {
  const ctx = React.useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  const { toast, dismiss } = ctx

  return React.useMemo(
    () => ({
      toast,
      dismiss,
      success: (message: string) => toast(message, 'success'),
      error: (message: string) => toast(message, 'error'),
      info: (message: string) => toast(message, 'info'),
      warning: (message: string) => toast(message, 'warning'),
    }),
    [toast, dismiss],
  )
}

/**
 * `toast()` where a provider is not guaranteed (§228c item 5).
 *
 * `useToast` throws without one, which is right for a settings form that
 * cannot report success any other way. The video player is the other case:
 * it is mounted by the viewer, by the public share page, by both compare
 * panes and by a dozen tests that render it on its own, and one warning
 * about a LUT not being visible in the iPhone's fullscreen player is not
 * worth making any of those a provider.
 *
 * Returns a no-op when there is no provider, so the caller never branches.
 */
export function useOptionalToast(): ToastContextValue['toast'] {
  const ctx = React.useContext(ToastContext)
  const toast = ctx?.toast
  return React.useMemo(
    () => toast ?? (() => {}),
    [toast],
  )
}

// ─── Visual config ────────────────────────────────────────────────────────────

const TOAST_CONFIG: Record<
  ToastType,
  { icon: React.ElementType; containerClass: string; iconClass: string }
> = {
  success: {
    icon: CheckCircle,
    containerClass: 'border-status-success/30 bg-status-success/10',
    iconClass: 'text-status-success',
  },
  error: {
    icon: XCircle,
    containerClass: 'border-status-error/30 bg-status-error/10',
    iconClass: 'text-status-error',
  },
  warning: {
    icon: AlertCircle,
    containerClass: 'border-status-warning/30 bg-status-warning/10',
    iconClass: 'text-status-warning',
  },
  info: {
    icon: Info,
    containerClass: 'border-border bg-bg-elevated',
    iconClass: 'text-accent',
  },
}

// ─── Toast container ──────────────────────────────────────────────────────────

interface ToastContainerProps {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}

function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2"
    >
      {toasts.map((t) => (
        <ToastTile key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

// ─── Single toast tile ────────────────────────────────────────────────────────

interface ToastTileProps {
  toast: ToastItem
  onDismiss: (id: string) => void
}

function ToastTile({ toast, onDismiss }: ToastTileProps) {
  const config = TOAST_CONFIG[toast.type]
  const Icon = config.icon

  return (
    <div
      role="alert"
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-3 rounded-xl border px-4 py-3 shadow-xl',
        'animate-slide-up',
        config.containerClass,
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', config.iconClass)} />
      <p className="flex-1 text-sm text-text-primary">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="mt-0.5 shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
