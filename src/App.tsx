import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from './state/useWorkspace'
import { TopBar } from './components/TopBar'
import { VisualPanel } from './components/VisualPanel'
import { SessionPanel } from './components/SessionPanel'
import { NoteWorkspace } from './components/NoteWorkspace'
import { RuntimeRail } from './components/RuntimeRail'
import { StatusBar } from './components/StatusBar'
import { TraceDrawer } from './components/TraceDrawer'
import { ToastView } from './components/ToastView'
import { AboutDialog } from './components/AboutDialog'

export default function App() {
  const workspace = useWorkspace()
  const workspaceRef = useRef(workspace)
  const [aboutOpen, setAboutOpen] = useState(false)

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
      const overlayOpen = aboutOpen || current.traceOpen
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
    <div className="shell">
      <TopBar
        title={workspace.title}
        path={workspace.path}
        elapsedSeconds={workspace.elapsedSeconds}
        speakerOn={workspace.speakerOn}
        micOn={workspace.micOn}
        traceAvailable={Boolean(workspace.trace)}
        onToggleSpeaker={workspace.toggleSpeaker}
        onToggleMic={workspace.toggleMic}
        onOpenTrace={() => handleOpenTrace()}
        onOpenHelp={() => setAboutOpen(true)}
      />

      <main className="workspace-grid">
        <div className="column left-column">
          <VisualPanel
            bbox={workspace.bbox}
            stage={workspace.stage}
            micOn={workspace.micOn}
            speaking={workspace.speaking}
            getMicLevel={workspace.getMicLevel}
            elapsedSeconds={workspace.elapsedSeconds}
          />
          <SessionPanel
            messages={workspace.messages}
            elapsedSeconds={workspace.elapsedSeconds}
            busy={workspace.busy}
            micOn={workspace.micOn}
            asrBusy={workspace.asrBusy}
            demoRunning={workspace.demoRunning}
            commandInput={workspace.commandInput}
            onInputChange={workspace.setCommandInput}
            onSubmit={handleSubmit}
            onToggleMic={workspace.toggleMic}
            onRunDemo={() => void workspace.runDemo()}
            onOpenTrace={handleOpenTrace}
          />
        </div>

        <div className="column center-column">
          <NoteWorkspace
            note={workspace.note}
            title={workspace.title}
            path={workspace.path}
            span={workspace.span}
            diff={workspace.diff}
            busy={workspace.busy}
            sourceMode={workspace.sourceMode}
            setSourceMode={workspace.setSourceMode}
            applySourceEdit={workspace.applySourceEdit}
            canUndo={workspace.canUndo}
            canRedo={workspace.canRedo}
            undo={workspace.undo}
            redo={workspace.redo}
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
          />
        </div>
      </main>

      <StatusBar
        stage={workspace.stage}
        trace={workspace.trace}
        micOn={workspace.micOn}
        asrBusy={workspace.asrBusy}
        runtimeHealth={workspace.runtimeHealth}
      />

      <TraceDrawer
        open={workspace.traceOpen}
        trace={workspace.selectedTrace}
        onClose={workspace.closeTrace}
      />

      <ToastView toast={workspace.toast} onDismiss={workspace.dismissToast} />

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
