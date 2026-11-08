import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { Toast } from '../types'
import { cx } from '../lib/utils'

interface ToastViewProps {
  toast: Toast | null
  onDismiss: () => void
}

export function ToastView({ toast, onDismiss }: ToastViewProps) {
  if (!toast) return null
  const Icon =
    toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? AlertTriangle : Info
  return (
    <div
      className={cx('toast', toast.tone && `is-${toast.tone}`)}
      role="status"
      aria-live="polite"
    >
      <span className="toast-icon">
        <Icon size={14} />
      </span>
      <div className="toast-copy">
        <span className="toast-title">{toast.title}</span>
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </div>
      <button
        type="button"
        className="toast-close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </div>
  )
}
