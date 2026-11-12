import { describe, expect, it } from 'vitest'
// Source text of every module that produces displayed/gated numbers: the
// honesty guarantee is static (no Math.random may exist in src/lib +
// src/state), so the sources are imported raw and grepped. This test is
// the surviving half of the deleted supervisor.test.ts grep gate — the
// guarantee outlives the supervisor.
import bridgeSource from './bridge.ts?raw'
import contextSource from './context.ts?raw'
import d1checkSource from './d1check.ts?raw'
import directiveSource from './directive.ts?raw'
import bubbleSource from './flow/bubble.ts?raw'
import buildCallSource from './flow/buildCall.ts?raw'
import chatTurnSource from './flow/chatTurn.ts?raw'
import historySource from './flow/history.ts?raw'
import omniFlowSource from './flow/omniFlow.ts?raw'
import snapshotStageSource from './flow/snapshotStage.ts?raw'
import turnContextSource from './flow/turnContext.ts?raw'
import verifySource from './flow/verify.ts?raw'
import workerFlowSource from './flow/workerFlow.ts?raw'
import docSource from './doc.ts?raw'
import gatesSource from './gates.ts?raw'
import omniSource from './omni.ts?raw'
import pendingSource from './pending.ts?raw'
import pipelineSource from './pipeline.ts?raw'
import runmodeSource from './runmode.ts?raw'
import snapshotDirectiveSource from './snapshotDirective.ts?raw'
import speechSource from './speech.ts?raw'
import storageSource from './storage.ts?raw'
import suggestionsSource from './suggestions.ts?raw'
import toolsSource from './tools.ts?raw'
import utilsSource from './utils.ts?raw'
import workerSource from './worker.ts?raw'
import workerChatSource from './workerChat.ts?raw'
import xmlSource from './xml.ts?raw'
import workspaceSource from '../state/useWorkspace.ts?raw'

describe('runtime honesty (static)', () => {
  it('src/lib and src/state contain no Math.random call', () => {
    const sources: Record<string, string> = {
      bridge: bridgeSource,
      context: contextSource,
      d1check: d1checkSource,
      directive: directiveSource,
      bubble: bubbleSource,
      buildCall: buildCallSource,
      chatTurn: chatTurnSource,
      history: historySource,
      omniFlow: omniFlowSource,
      snapshotStage: snapshotStageSource,
      turnContext: turnContextSource,
      verify: verifySource,
      workerFlow: workerFlowSource,
      doc: docSource,
      gates: gatesSource,
      omni: omniSource,
      pending: pendingSource,
      pipeline: pipelineSource,
      runmode: runmodeSource,
      snapshotDirective: snapshotDirectiveSource,
      speech: speechSource,
      storage: storageSource,
      suggestions: suggestionsSource,
      tools: toolsSource,
      utils: utilsSource,
      worker: workerSource,
      workerChat: workerChatSource,
      xml: xmlSource,
      useWorkspace: workspaceSource,
    }
    for (const [name, source] of Object.entries(sources)) {
      // Comments may mention Math.random in prose ("no Math.random") — the
      // gate is about calls, so strip comments before matching.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code, `${name} must not call Math.random`).not.toMatch(/Math\.random\s*\(/)
    }
  })

  it('no module imports the deleted supervisor, route, or flags modules', () => {
    const sources = [pipelineSource, workerSource, workerChatSource, workspaceSource]
    for (const source of sources) {
      expect(source).not.toMatch(/from '\.\/(supervisor|route|flags)'/)
    }
  })
})
