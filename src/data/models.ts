import type { ModelInfo } from '../types'

export const MODELS: ModelInfo[] = [
  {
    id: 'omni',
    role: 'Interface',
    shortName: 'Omni 2B',
    name: 'LFM3-Omni-2B',
    params: '2.17B',
    contextK: 32,
    quant: 'Q4_K_M',
    memGB: 1.5,
    color: 'green',
    description: 'Listens, watches and speaks. Delegates file mutations to the worker.',
  },
  {
    id: 'd1',
    role: 'Supervisor',
    shortName: 'd1 Omni 2B',
    name: 'd1-Omni-2B',
    params: '2.17B',
    contextK: 128,
    quant: 'Q8_0',
    memGB: 2.3,
    color: 'accent',
    description: 'Zero-output-token decision head. Routes, grounds and validates every tool call.',
  },
  {
    id: 'worker',
    role: 'Worker',
    shortName: '1.7B',
    name: 'LFM3-1.7B',
    params: '1.7B',
    contextK: 256,
    quant: 'Q4_K_M',
    memGB: 1.1,
    color: 'orange',
    description: 'Reasons in <think> and emits XML tool calls against the active note.',
  },
]

export const TOTAL_MEMORY_GB = MODELS.reduce((total, model) => total + model.memGB, 0)
export const MEMORY_BUDGET_GB = 8
