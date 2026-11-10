export const NOTE_PATH = 'notes/quarterly-review.md'
export const NOTE_TITLE = 'Q3 Business Review'

export const INITIAL_NOTE = `# Q3 Business Review

Prepared for the operating review on 14 November. Figures are provisional until finance sign-off. The narrative below focuses on revenue quality, product execution, and the decisions needed before the board meeting.

## 1. Executive summary

Revenue grew 18% quarter over quarter, led by self-serve expansion in the mid-market. Net revenue retention held at 112%, while gross margin improved 2.1 points.

> Decision needed: approve the Q4 hiring plan before the next board meeting.

## 2. Revenue

| Quarter | Revenue | Status |
| --- | --- | --- |
| Q1 | $0.92M | Closed |
| Q2 | $1.08M | Closed |
| Q3 | $1.2M | Pending |
| Q4 | $1.35M | Forecast |

The Q3 figure is waiting on the final enterprise invoice reconciliation. Finance expects to close the gap this week.

## 3. Product notes

- Shipped the new workspace permissions model.
- Redis cache migration was postponed to Q4.
- Mobile capture beta reached 1,200 weekly users.

## 4. Risks

1. Enterprise pipeline concentration remains high.
2. Support volume is tracking 12% above plan.
3. Hiring depends on the revised Q4 plan.

## 5. Follow-ups

- Finance to confirm Q3 revenue by Friday.
- Dana to share the revised hiring model.

## 6. Security

- Rotate production API keys before 30 November.
- Complete the SSO audit with IT.
`

export const DEMO_SEQUENCE = [
  { command: 'Update the Q3 revenue row to $1.45M Final', source: 'demo' as const },
  { command: 'Remove the bullet about Redis', source: 'demo' as const },
]
