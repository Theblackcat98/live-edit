import type { SceneRegionId } from '../types'

export interface SceneRegion {
  id: SceneRegionId
  label: string
  formats: string[]
}

export const SCENE_REGIONS: Record<SceneRegionId, SceneRegion> = {
  full: { id: 'full', label: 'slide', formats: ['bullet_summary'] },
  header: { id: 'header', label: 'slide title', formats: ['verbatim_ocr'] },
  table: { id: 'table', label: 'revenue table', formats: ['markdown_table'] },
  'q3-row': { id: 'q3-row', label: 'Q3 row', formats: ['verbatim_ocr'] },
  formula: { id: 'formula', label: 'north star card', formats: ['latex_block'] },
  chart: { id: 'chart', label: 'quarterly bars', formats: ['bullet_summary'] },
  sticky: { id: 'sticky', label: 'finance note', formats: ['verbatim_ocr'] },
}

export const SCENE_META = {
  title: 'Q3 operating review',
  elements: '1 table · 1 chart · 1 note',
  framesPerSecond: 2,
  resolution: '1920 × 1080',
  audio: '16 kHz',
}

export const VISUAL_MARKDOWN = {
  formula: `**North star — LTV / CAC**

$$
\\frac{\\mathrm{LTV}}{\\mathrm{CAC}} = 3.4\\times
$$

Target floor: 3.0×. Captured from the camera feed at 14:06.`,
  table: `**Revenue snapshot**

| Quarter | Revenue | Status |
| --- | --- | --- |
| Q1 | $0.92M | Closed |
| Q2 | $1.08M | Closed |
| Q3 | $1.20M | Pending |
| Q4 | $1.35M | Forecast |`,
  chart: `**Quarterly revenue trend**

- Q1: $0.92M
- Q2: $1.08M
- Q3: $1.20M (pending)
- Q4: $1.35M (forecast)

Growth is steady at roughly 13–18% per quarter. Q3 is the only bar awaiting finance sign-off.`,
  sticky: `> Finance note: the final enterprise invoice reconciliation is still pending. Expect closure this week.`,
  full: `**Whiteboard capture — Q3 operating review**

- Revenue reached $1.20M in Q3; finance reconciliation is pending.
- LTV / CAC sits at 3.4×, above the 3.0× floor.
- Q4 forecast is $1.35M.
- Hiring plan approval is the open decision.`,
} as const

export const CONVERSATIONAL_SCENE_DESCRIPTION =
  'You are showing a Q3 operating review slide. I can see a revenue table with Q3 marked pending, a north-star card reading LTV / CAC = 3.4×, a quarterly bar chart, and a finance sticky note about invoice reconciliation.'
