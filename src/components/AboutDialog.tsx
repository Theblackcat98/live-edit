import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Boxes, CloudOff, Keyboard, ShieldCheck, X } from 'lucide-react'
import { MODELS } from '../data/models'
import { LogoMark } from './LogoMark'

interface AboutDialogProps {
  open: boolean
  onClose: () => void
}

const SHORTCUTS = [
  ['⌘ / Ctrl K', 'Focus the command bar'],
  ['Enter', 'Send a command'],
  ['⌘ / Ctrl Z', 'Restore previous snapshot'],
  ['⌘ / Ctrl ⇧ Z', 'Reapply next snapshot'],
  ['⌘ / Ctrl Enter', 'Apply a Markdown source draft'],
  ['Esc', 'Close overlays'],
]

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

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
            A multimodal note workspace where you speak, show a document or slide, and watch a
            three-model LFM3 stack route, ground and verify every edit before it touches a line.
          </p>

          <div className="about-callout">
            <span className="about-callout-icon">
              <CloudOff size={14} />
            </span>
            <div>
              <strong>Local LFM3 runtime</strong>
              <p>
                Voice ASR (Omni-2B), chat replies (Omni-2B), routing and critic decisions
                (d1-Omni-2B over /v1/systemone) and worker XML calls (LFM3-1.7B; VL-2B covers visual crops and fallback) run against local
                llama.cpp servers on 127.0.0.1. The Runtime truth card in the rail shows live
                probes. Span grounding is a deterministic local span search; the diff engine,
                snapshots and trace format run entirely in this tab. If a model server is down,
                the stage falls back to a local deterministic layer and the trace labels it.
              </p>
            </div>
          </div>

          <div className="about-section-title">
            <Boxes size={12} />
            <span className="mono">The trinity</span>
          </div>
          <div className="about-models">
            {MODELS.map((model) => (
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
              The app does not upload audio, frames or note state: capture goes to the local Omni
              model on 127.0.0.1 only. LFM Open License v1.0 applies to the model family; this
              interface is a local demonstration build.
            </span>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  )
}
