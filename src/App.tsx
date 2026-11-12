import { useEffect, useRef, useState } from 'react'
import { Cpu, FileText, MessageSquare } from 'lucide-react'
import { useWorkspace } from './state/useWorkspace'
import { TopBar } from './components/TopBar'
import { VisualPanel } from './components/VisualPanel'
import { SessionComposer, SessionPanel } from './components/SessionPanel'
import { NoteWorkspace } from './components/NoteWorkspace'
import { RuntimeRail } from './components/RuntimeRail'
import { StatusBar } from './components/StatusBar'
import { TraceDrawer } from './components/TraceDrawer'
import { ToastView } from './components/ToastView'
import { AboutDialog } from './components/AboutDialog'
import { ModelSwitchDialog } from './components/ModelSwitchDialog'
import { cx } from './lib/utils'

type PhoneView = 'session' | 'note' | 'runtime'

const PHONE_TABS = [
  { id: 'session', label: 'Session', Icon: MessageSquare },
  { id: 'note', label: 'Note', Icon: FileText },
  { id: 'runtime', label: 'Runtime', Icon: Cpu },
] as const

/** The phone surface starts where the responsive layout already hides the columns. */
const PHONE_QUERY = '(max-width: 780px)'

function usePhoneLayout(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY)
    const onChange = (event: MediaQueryListEvent) => setIsPhone(event.matches)
    setIsPhone(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return isPhone
}

export default function App() {
  const workspace = useWorkspace()
  const workspaceRef = useRef(workspace)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [phoneView, setPhoneView] = useState<PhoneView>('session')
  const isPhone = usePhoneLayout()

  // A verified edit brings the note forward on the phone surface; switching
  // back to the session tab stays manual.
  const lastSwitchDiff = useRef(workspace.diff)
  useEffect(() => {
    if (!workspace.diff) {
      lastSwitchDiff.current = null
      return
    }
    if (workspace.diff === lastSwitchDiff.current) return
    lastSwitchDiff.current = workspace.diff
    setPhoneView('note')
  }, [workspace.diff])

  useEffect(() => {
    workspaceRef.current = workspace
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      const current = workspaceRef.current
      const overlayOpen = aboutOpen || current.traceOpen || Boolean(current.pendingSwitch)
      if (overlayOpen && event.key !== 'Escape') return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        const input = document.getElementById('command-input') as HTMLInputElement | null
        input?.focus()
        return
      }

      if (!editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) current.redo()
        else current.undo()
        return
      }

      if (event.key === 'Escape') {
        if (aboutOpen) {
          setAboutOpen(false)
          return
        }
        if (current.pendingSwitch) {
          current.cancelPendingSwitch()
          return
        }
        if (current.traceOpen) {
          current.closeTrace()
          return
        }
      }

      if (!editing && !event.metaKey && !event.ctrlKey && event.key === '?') {
        setAboutOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [aboutOpen])

  const handleSubmit = (command: string) => {
    void workspace.submitCommand(command, 'text')
  }

  const handleOpenTrace = (runId?: string) => {
    workspace.openTrace(runId)
  }

  return (
    <div className="shell" data-phone-view={phoneView}>
      <TopBar
        title={workspace.title}
        path={workspace.path}
        elapsedSeconds={workspace.elapsedSeconds}
        speakerOn={workspace.speakerOn}
        micOn={workspace.micOn}
        traceAvailable={Boolean(workspace.trace) || workspace.runs.length > 0}
        mode={workspace.mode}
        onSetMode={workspace.setMode}
        onToggleSpeaker={workspace.toggleSpeaker}
        onToggleMic={workspace.toggleMic}
        onOpenTrace={() => handleOpenTrace()}
        onOpenHelp={() => setAboutOpen(true)}
      />

      <main className="workspace-grid">
        <div className="phone-tabs" role="tablist" aria-label="Workspace view" data-testid="phone-tabs">
          {PHONE_TABS.map((tab) => {
            const active = phoneView === tab.id
            const live =
              tab.id === 'session'
                ? workspace.micOn || workspace.asrBusy
                : tab.id === 'note'
                  ? Boolean(workspace.diff) && !active
                  : false
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={cx('phone-tab', active && 'is-active')}
                data-testid={`phone-tab-${tab.id}`}
                onClick={() => setPhoneView(tab.id)}
              >
                <tab.Icon size={15} />
                <span>{tab.label}</span>
                {live && <span className="phone-tab-dot" aria-hidden="true" />}
              </button>
            )
          })}
        </div>

        <div className="column left-column">
          <VisualPanel
            stage={workspace.stage}
            micOn={workspace.micOn}
            micActive={workspace.micActive}
            speaking={workspace.speaking}
            getMicLevel={workspace.getMicLevel}
            elapsedSeconds={workspace.elapsedSeconds}
            mode={workspace.mode}
          />
          <SessionPanel
            messages={workspace.messages}
            elapsedSeconds={workspace.elapsedSeconds}
            busy={workspace.busy}
            micOn={workspace.micOn}
            micActive={workspace.micActive}
            asrBusy={workspace.asrBusy}
            demoRunning={workspace.demoRunning}
            speaking={workspace.speaking}
            ttsBusy={workspace.ttsBusy}
            suggestions={workspace.suggestions}
            commandInput={workspace.commandInput}
            onInputChange={workspace.setCommandInput}
            onSubmit={handleSubmit}
            onToggleMic={workspace.toggleMic}
            onStopSpeech={workspace.stopSpeech}
            onResetChat={workspace.resetChat}
            onRunDemo={() => void workspace.runDemo()}
            onOpenTrace={handleOpenTrace}
            pendingEdits={workspace.pendingEdits}
            onApplyPending={workspace.applyPendingEdit}
            onDismissPending={workspace.dismissPendingEdit}
            mode={workspace.mode}
            showComposer={!isPhone}
          />
        </div>

        <div className="column center-column">
          <NoteWorkspace
            note={workspace.note}
            title={workspace.title}
            path={workspace.path}
            diff={workspace.diff}
            busy={workspace.busy}
            sourceMode={workspace.sourceMode}
            setSourceMode={workspace.setSourceMode}
            applySourceEdit={workspace.applySourceEdit}
            canUndo={workspace.canUndo}
            canRedo={workspace.canRedo}
            undo={workspace.undo}
            redo={workspace.redo}
            newNote={workspace.newNote}
            history={workspace.history}
            historyIndex={workspace.historyIndex}
            trace={workspace.trace}
            openTrace={() => handleOpenTrace()}
            nowTick={workspace.nowTick}
          />
        </div>

        <div className="column right-column">
          <RuntimeRail
            activeModel={workspace.activeModel}
            trace={workspace.trace}
            stageStates={workspace.stageStates}
            contextUsage={workspace.contextUsage}
            history={workspace.history}
            historyIndex={workspace.historyIndex}
            busy={workspace.busy}
            nowTick={workspace.nowTick}
            restoreSnapshot={workspace.restoreSnapshot}
            openTrace={() => handleOpenTrace()}
            runtimeHealth={workspace.runtimeHealth}
            refreshRuntime={workspace.refreshRuntime}
            mode={workspace.mode}
            onSetMode={workspace.setMode}
            canOpenTrace={Boolean(workspace.trace) || workspace.runs.length > 0}
          />
        </div>

        {isPhone && (
          <div className="phone-composer" data-testid="phone-composer">
            <SessionComposer
              busy={workspace.busy}
              micOn={workspace.micOn}
              micActive={workspace.micActive}
              asrBusy={workspace.asrBusy}
              commandInput={workspace.commandInput}
              onInputChange={workspace.setCommandInput}
              onSubmit={handleSubmit}
              onToggleMic={workspace.toggleMic}
              mode={workspace.mode}
            />
          </div>
        )}
      </main>

      <StatusBar
        stage={workspace.stage}
        trace={workspace.trace}
        micOn={workspace.micOn}
        micActive={workspace.micActive}
        asrBusy={workspace.asrBusy}
        runtimeHealth={workspace.runtimeHealth}
        mode={workspace.mode}
      />

      <TraceDrawer
        open={workspace.traceOpen}
        trace={workspace.selectedTrace}
        runs={workspace.runs}
        rejectedTraces={workspace.rejectedTraces}
        mode={workspace.mode}
        onSelectRun={(id) => workspace.openTrace(id)}
        onClose={workspace.closeTrace}
      />

      <ToastView toast={workspace.toast} onDismiss={workspace.dismissToast} />

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} mode={workspace.mode} />

      {workspace.pendingSwitch && (
        <ModelSwitchDialog
          plan={workspace.pendingSwitch}
          from={workspace.mode}
          switching={workspace.switchingModels}
          onConfirm={workspace.confirmPendingSwitch}
          onCancel={workspace.cancelPendingSwitch}
        />
      )}
    </div>
  )
}
