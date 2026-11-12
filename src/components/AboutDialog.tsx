import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Boxes, CloudOff, Keyboard, ShieldCheck, X } from 'lucide-react'
import { modeDef } from '../lib/modes'
import type { RunMode } from '../lib/runmode'
import { LogoMark } from './LogoMark'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
  /** Active run mode — the roster and copy name the models actually serving it. */
  mode: RunMode
}

const SHORTCUTS = [
  ['⌘ / Ctrl K', 'Focus the command bar'],
  ['Enter', 'Send a command'],
  ['⌘ / Ctrl Z', 'Restore previous snapshot'],
  ['⌘ / Ctrl ⇧ Z', 'Reapply next snapshot'],
  ['⌘ / Ctrl Enter', 'Apply a Markdown source draft'],
  ['Esc', 'Close overlays'],
]

export function AboutDialog({ open, onClose, mode }: AboutDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  const def = modeDef(mode)

  return createPortal(
    <div className="about-overlay">
      <div className="about-backdrop" onClick={onClose} aria-hidden="true" />
      <section className="about-dialog" role="dialog" aria-modal="true" aria-label="About LiquidScribe">
        <header className="about-header">
          <div className="about-brand">
            <LogoMark size={30} />
            <div>
              <h2>LiquidScribe</h2>
              <span className="mono">v0.9.0 · local-first workspace</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close about dialog"
          >
            <X size={15} />
          </button>
        </header>

        <div className="about-body">
          <p className="about-lede">
            A local-first note workspace where you talk to {def.chat.author} and watch the
            1.7B author each edit, checked by d1 before it touches a line.
          </p>

          <div className="about-callout">
            <span className="about-callout-icon">
              <CloudOff size={14} />
            </span>
            <div>
              <strong>Local LFM3 runtime</strong>
              <p>
                Chat replies ({def.chat.author}), worker XML calls (LFM3-1.7B) and the d1
                safety check (d1-Omni-2B over /v1/systemone) run against local llama.cpp servers
                on 127.0.0.1, started by scripts/start-models.sh. The Runtime truth card in the
                rail probes them live. The worker grounds its own span; the diff engine,
                snapshots and trace format run entirely in this tab. If a model server is down,
                the affected stage degrades honestly — the trace labels it, nothing fakes a call.
              </p>
            </div>
          </div>

          <div className="about-section-title">
            <Boxes size={12} />
            <span className="mono">The trinity</span>
          </div>
          <div className="about-models">
            {def.roster.map((model) => (
              <div className="about-model" key={model.id}>
                <span className={`status-dot is-${model.color}`} />
                <div>
                  <span className="about-model-name">{model.shortName}</span>
                  <span className="about-model-role mono">{model.role}</span>
                </div>
                <span className="about-model-spec mono">
                  {model.params} · {model.contextK}K · {model.quant}
                </span>
              </div>
            ))}
          </div>

          <div className="about-section-title">
            <Keyboard size={12} />
            <span className="mono">Keyboard</span>
          </div>
          <div className="about-shortcuts">
            {SHORTCUTS.map(([keys, action]) => (
              <div className="about-shortcut" key={keys}>
                <kbd className="mono">{keys}</kbd>
                <span>{action}</span>
              </div>
            ))}
          </div>

          <div className="about-footer">
            <ShieldCheck size={12} />
            <span>
              The app does not upload audio or note state: every model call stays on 127.0.0.1.
              Active mode: {def.info.label}. LFM Open License v1.0 applies to the model
              family; this interface is a local demonstration build.
            </span>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
