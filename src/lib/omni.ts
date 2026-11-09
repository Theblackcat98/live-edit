/**
 * Omni turn client (design.md §2/§4, P2): every turn reaches Omni first.
 *
 * Builds the conversation messages (frame per the E2 config, note per §6),
 * streams the visible reply, and parses the outcome using E1's winning
 * mechanism — native tool calls on the local llama.cpp build (--jinja).
 * A barge-in-aborted stream yields NO outcome (returns null): a partial
 * directive must never execute. Endpoint failures throw typed errors; Omni
 * down means the turn fails honestly with the endpoint state shown.
 */
import type { OmniTurnResult } from '../types'

/** Filled in by P2 (stub contract): the single turn entry point. */
export async function runOmniTurn(
  /* input: OmniTurnInput — the P2 author defines the input shape */
  ...args: unknown[]
): Promise<OmniTurnResult | null> {
  void args
  throw new Error('omni.ts: filled in by P2 (stub contract)')
}
