# Project Plan: LFM3 Multimodal Agentic Note & File Workspace ("LiquidScribe")

> **⚠ SUPERSEDED IN PART (2026-11-09).** The authoritative design is now
> [`docs/design.md`](./docs/design.md) — the owner's corrected, **Omni-first** spec:
> Omni converses and silently delegates via a typed directive, the 1.7B worker
> **authors** edits, d1-Omni is a **safety check only**, and d1 rejections go to the
> user as pending edits (✓ / ✗). **§1–§6 of this plan describe the earlier
> supervisor-first design (d1 routing/grounding, deterministic pre-authoring) and
> are superseded wherever they conflict with design.md.** §7 is the original
> roadmap; §9–§10 remain valid as the build record of what actually shipped.
> See §11 below for the correction summary.

## 1. Executive Summary & Core Concept

**LiquidScribe** is a local-first, real-time multimodal workspace where a user can talk naturally, show documents/screens/whiteboards via camera or screen-share, and collaboratively build, edit, and organize notes/files hands-free.

Instead of relying on a single monolithic cloud LLM or a brittle pipeline of separate ASR + VLM + LLM + TTS models, this project leverages three specialized models from **Liquid AI's LFM3 family** sharing the 24-layer tri-hybrid backbone:

1. **The Interface (`LiquidAI/LFM3-Omni-2B`):** Listens (16kHz audio), watches (2fps video / native-res images), converses with the user in real-time (24kHz speech + text), and delegates actionable file tasks.
2. **The Supervisor (`LiquidAI/d1-Omni-2B`):** A zero-output-token multimodal decision model that runs single-forward-pass (~6–12ms) checks over the live audio, visual frame, conversation context, and note state. It constantly guides the worker model by routing tools, extracting exact target text spans/bounding boxes, and validating proposed tool calls before execution.
3. **The Agentic Worker (`LiquidAI/LFM3-1.7B`):** The dedicated tool-caller with `<think>` reasoning and XML `<tool_call>` generation that adds, edits, formats, and removes text in the user's files/notes.

---

## 2. Model Roles, Specifications & Hardware Budget

### 2.1 Model Roster

| Role | Checkpoint | Params | Context | Quantization (Target) | Est. Memory (Weights + KV) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Perceptual Front-End** | `LiquidAI/LFM3-Omni-2B` | 2.17B | 32K | Q4_K_M / MLX 4-bit / FP8 | ~1.5 GB |
| **Decision Supervisor** | `LiquidAI/d1-Omni-2B` | 2.17B | 128K | BF16 / Q8_0 (for calibration accuracy) | ~2.3 GB |
| **Text Worker** | `LiquidAI/LFM3-1.7B` | 1.73B | 256K | Q4_K_M / JANG_6M / MLX 4-bit | ~1.3 GB |

* **Total Concurrent Memory Footprint:** ~5.1 GB for the three-model trinity (runs fully locally on Apple Silicon Macs with 16GB+ Unified Memory, consumer GPUs with 8GB+ VRAM, or Intel/AMD AI PCs).
* **Why `d1-Omni-2B` is kept at higher precision (Q8/BF16):** Decision models output calibrated probabilities in a single forward pass; preserving precision ensures probability calibration (`P(intent)`, span boundaries) remains sharp.
* **Worker Selection Policy:** *(VL-2B removed 2026-11-08 — Omni + 1.7B + d1 are sufficient)*
  * **`LFM3-1.7B`, :8080** decodes every text mutation (`add_text`, `edit_text`, `remove_text`)
    over its 256K context — its Agentic RL post-training closes the XML tool-call contract
    reliably. Decodes ~7–14 s at a 3000-token budget; two malformed attempts, or a down server,
    fall back to the deterministic template emitter.
  * `extract_visual_to_note` needs no live worker: the deterministic emitter produces the
    structured Markdown (QA case 9 verifies green with :8081 absent).

---

## 3. System Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
|                                  USER INTERFACE                                   |
|  [Microphone (16kHz)]    [Camera / Screen (2fps / Native Res)]    [Text Input]    |
+-----------+-------------------------------+-----------------------------+---------+
            |                               |                             |
            v                               v                             v
+-----------------------------------------------------------------------------------+
|                        MULTIMODAL RING BUFFER (Shared State)                      |
|  • Last 30s Audio Chunks   • Keyframes / Screen Captures   • Active File AST/Text |
+--------------------+------------------------------+-------------------------------+
                     |                              |
       (1) Live Stream                              | (2) Raw State (Audio + Img + File)
                     v                              v
+-------------------------------------+   +-----------------------------------------+
|     FRONT-END: LFM3-Omni-2B         |   |       SUPERVISOR: d1-Omni-2B            |
|  • Listens & watches simultaneously |   |  (Single Forward Pass, 0 Output Tokens) |
|  • Answers user in 24kHz speech     |   |                                         |
|  • Emits lightweight Task Intent    +-->|  Stage A: Intent & Tool Classification  |
|    or asks clarifying question      |<--+  Stage B: Exact Span & BBox Extraction  |
+-------------------------------------+   |  Stage C: Post-Tool-Call Validation     |
       ^                                  +----+-------------------------------+----+
       |                                       |                               ^
       | (6) Execution Summary                 | (3) Filtered Tools +          | (4) Proposed XML
       |     (Spoken confirmation)             |     Target Spans + BBoxes     |     <tool_call>
       |                                       v                               |
       |                          +--------------------------------------------+----+
|      WORKER: LFM3-1.7B                           |
       |                          |  • Reasons step-by-step inside <think>...</think>|
       |                          |  • Generates XML <tool_call><function=...>      |
       |                          +--------------------+----------------------------+
       |                                               |
       |                                               | (5) Validated Call (P > 0.80)
       |                                               v
       |                          +-------------------------------------------------+
       +--------------------------+        FILE / NOTE EXECUTION ENGINE             |
                                  |  • Atomic AST/Line Diffs (Add, Edit, Remove)    |
                                  |  • Git/Snapshot Rollback Buffer                 |
                                  +-------------------------------------------------+
```

---

## 4. Deep Dive: How `d1-Omni-2B` Constantly Helps the Worker (`LFM3-1.7B`)

Small 1.7B–2B models can occasionally hallucinate tool parameters, pick the wrong edit operation (`add` vs `replace`), or misidentify which paragraph the user wants to change. **`d1-Omni-2B`** eliminates these failure modes via three millisecond-level interventions:

### Stage A: Pre-Flight Intent Routing & Tool Pruning (~6ms)

Whenever `LFM3-Omni-2B` detects an actionable request (or on every user turn via VAD trigger), `d1-Omni-2B` is queried with the raw audio clip, latest visual frame, and current note outline:

* **Decision Query 1 (`action_required`):** `["conversational_only", "file_mutation", "ambiguous_request"]`
  * *If `"ambiguous_request"` ($P > 0.60$):* Short-circuits the worker and instructs `LFM3-Omni-2B` to ask the user for clarification out loud.
* **Decision Query 2 (`allowed_tools`):** Multi-select classification over the tool catalog:
  * `["add_text", "edit_text", "remove_text", "extract_visual_to_note"]` *(the implemented catalog — the original sketch's `create_section`/`format_note` were folded into `add_text`/`edit_text`)*
  * *Benefit:* Instead of stuffing 15+ tool schemas into the worker prompt, only the top 1–2 tools with calibrated probability $P > 0.25$ are injected into `apply_chat_template(tools=...)`. This dramatically increases the 1.7B model's tool-calling accuracy.

### Stage B: Zero-Token Grounding (Span & Bounding Box Extraction) (~8ms)

Before the worker model generates a single token, `d1-Omni-2B` uses its typed output heads in the same forward pass:

1. **Text Span Extraction:** Given the active note text and the user's spoken instruction (e.g., *"Change the deadline in the second paragraph to Friday"* or *"Remove the bullet point about Redis"*), `d1-Omni-2B` extracts the **exact character/line span** (`start_char`, `end_char`, `matched_substring`) from the file.
2. **Visual Bounding Box Extraction:** If the user references the camera/screen (e.g., *"Grab the formula in the top right of this slide and add it under section 2"*), `d1-Omni-2B` returns the open-vocabulary bounding box `[x1, y1, x2, y2]` with calibrated confidence.
3. **Prompt Injection:** The orchestrator crops the high-res image region (if visual) and highlights the exact target line numbers/span in the prompt sent to `LFM3-1.7B`. The worker no longer has to guess *where* to edit.

### Stage C: Post-Generation Critic & Parameter Verification (~6ms)

Once `LFM3-1.7B` outputs its `<think>` block and `<tool_call>`, the orchestrator intercepts the call **before** mutating the file and runs a single forward pass on `d1-Omni-2B`:

* **State Input:** `[User Audio Clip] + [Target Span] + [Proposed XML Tool Call]`
* **Typed Questions:**
  1. `does_tool_match_intent`: `["yes", "no_wrong_operation", "no_wrong_target_span", "no_hallucinated_content"]`
  2. `destructive_safety_check`: `["safe", "unintended_data_loss"]`
* **Feedback Loop:**
  * If $P(\text{"yes"}) \ge 0.80$ and $P(\text{"safe"}) \ge 0.85$: Execute the tool call immediately.
  * If rejected: Append a system critique message to the worker context (e.g., *"Supervisor rejected call: `no_wrong_target_span`. Expected edit within lines 14–18 (`matched_substring`), but tool targeted lines 30–35. Retry."*) and regenerate with `temperature=0.1`.
  * *Implementation deviation:* the built critic runs one typed `noul` question (not the two typed questions above) and does **not** loop a critique back into the worker — two decode attempts, then the deterministic template emitter, keep runs finite. §10 WS1 tunes the gate.

---

## 5. Tool Specifications & LFM3 XML Calling Contract

LFM3 models use a native XML tool-calling format (`qwen3_coder` superset) injected via `tokenizer.apply_chat_template(messages, tools=tools)`.

### 5.1 Core File/Note Manipulation Tools

All file tools operate on line-indexed or span-verified views of the target Markdown/text note to prevent full-file regeneration errors.

1. **`add_text`**
   * **Description:** Inserts new text or Markdown content at a specific position (start of file, end of file, or after a specific heading/line number).
   * **Parameters:**
     * `file_path` *(string, required)*
     * `position` *(enum: `"append"`, `"prepend"`, `"after_line"`, `"under_heading"`, required)*
     * `anchor` *(string/integer, optional)*: Line number or exact heading string provided by `d1-Omni-2B`.
     * `content` *(string, required)*: The text/Markdown to insert.

2. **`edit_text`**
   * **Description:** Replaces an existing span of text or specific line range with updated text.
   * **Parameters:**
     * `file_path` *(string, required)*
     * `start_line` *(integer, required)*
     * `end_line` *(integer, required)*
     * `old_text_anchor` *(string, required)*: Exact substring being replaced (pre-populated or verified against `d1-Omni-2B` span extraction).
     * `new_text` *(string, required)*: Replacement text.

3. **`remove_text`**
   * **Description:** Deletes a specific text span, bullet point, line range, or section from the note.
   * **Parameters:**
     * `file_path` *(string, required)*
     * `start_line` *(integer, required)*
     * `end_line` *(integer, required)*
     * `target_excerpt` *(string, required)*: Confirmation snippet of the text to be removed.

4. **`extract_visual_to_note`** *(deterministic emitter; VL-2B removed 2026-11-08)*
   * **Description:** Transcribes, summarizes, or converts a visual element (chart, table, whiteboard, handwritten note) into structured Markdown (e.g., Mermaid diagram, Markdown table, LaTeX math) and inserts it into the note.
   * **Parameters:**
     * `file_path` *(string, required)*
     * `visual_format` *(enum: `"markdown_table"`, `"mermaid_diagram"`, `"latex_block"`, `"bullet_summary"`, `"verbatim_ocr"`)*
     * `anchor_heading` *(string, required)*
     * `extracted_markdown` *(string, required)*

### 5.2 Example LFM3 Worker Generation

When guided by `d1-Omni-2B`, the worker receives the supervisor's hints in its prompt and outputs:

```xml
<think>
The user asked to update the Q3 revenue figure in the summary table based on the slide shown on camera.
Supervisor d1-Omni-2B extracted target span at lines 12-14 ("| Q3 | $1.2M | Pending |") and cropped the slide ROI showing "$1.45M (Final)".
I will call `edit_text` on lines 12-14.
</think>
<tool_call>
<function=edit_text>
<parameter=file_path>
notes/quarterly_review.md
</parameter>
<parameter=start_line>
12
</parameter>
<parameter=end_line>
14
</parameter>
<parameter=old_text_anchor>
| Q3 | $1.2M | Pending |
</parameter>
<parameter=new_text>
| Q3 | $1.45M | Final |
</parameter>
</function>
</tool_call>
```

---

## 6. Context & State Management Across the 3 Models

Because each LFM3 model has a different context window and modality contract, the Orchestrator manages three synchronized views of state:

1. **`LFM3-Omni-2B` Context (128K — Rolling Chat Window):**
   * Implemented: the last 6 (user command, assistant reply) turns, the current note (resent each turn, truncated to 3,600 chars — prefix caching absorbs most of it), a one-line last-run status, and the live frame attached only on visual-relevant turns.
   * Implemented (§10 WS2, 2026-11-08): non-note turns receive a compact ToC outline (title + H2 headings) instead of the full note dump.
   * Chat decodes at `temperature=0.3` with a 500-token budget, streamed; TTS rides the same server's `/tts` (24 kHz WAV).

2. **`d1-Omni-2B` Context (128K Limit — Stateless Single-Pass Window):**
   * Constructed fresh on each decision pass: `[Last 15s Audio Clip] + [Current Keyframe] + [Last 3 Conversation Turns] + [Full Active Note Text (up to 64K tokens for optimal calibration)]`.
   * Because `d1-Omni-2B` generates **zero output tokens**, prefix caching on the active note text allows subsequent decision passes to execute in single-digit milliseconds.

3. **`LFM3-1.7B` Context (256K Limit — Worker Task Window):**
   * Receives: `[System Prompt + Pruned Tool Schemas] + [Supervisor Grounding Hints (Target Span, BBox Crop, Intent Probability)] + [Line-Numbered Note Content] + [Task Instruction]`.
   * Generation parameters: `temperature=0.1, top_k=50, repetition_penalty=1.1` (Liquid AI's official recommended settings for deterministic tool calling).

---

## 7. Step-by-Step Implementation Roadmap

### Phase 1: Runtime Setup & Model Serving Layer
- [ ] **Environment Setup:** Install `transformers>=5.21.0`, `torch`, `torchvision`, `librosa`, `soundfile`, and local serving backends (`SGLang` / `vLLM` / `llama.cpp` with OpenVINO or MLX support depending on target hardware).
- [ ] **Model Loader Module (`src/models/`):**
  - Load `LiquidAI/LFM3-Omni-2B` with `AutoModelForMultimodalLM` and `AutoProcessor` (including `LiquidCodec` audio tokenizer for 24kHz waveform decoding).
  - Load `LiquidAI/d1-Omni-2B` for single-pass typed inference.
  - Load `LiquidAI/LFM3-VL-2B` (and optional `LiquidAI/LFM3-1.7B`) with chat template tool support.
- [ ] **Smoke Tests:** Verify independent latency of each model (`d1-Omni-2B` decision pass < 25ms locally; `LFM3-VL-2B` XML `<tool_call>` parsing).

### Phase 2: File & Note Execution Engine (`src/workspace/`)
- [ ] Build an atomic Markdown/text state manager that renders files with explicit line numbers (`1: # Title\n2: ...`) for the worker model.
- [ ] Implement the 4 core tools (`add_text`, `edit_text`, `remove_text`, `extract_visual_to_note`) with strict pre-commit diff checking.
- [ ] Add an in-memory Undo/Snapshot stack so any voice command (*"Undo that last edit"*) can revert instantaneously without LLM overhead.
- [ ] Implement the XML `<tool_call><function=...><parameter=...>` parser and JSON converter (`json.loads()` mapping handler for `apply_chat_template`).

### Phase 3: The `d1-Omni-2B` Supervisor Pipeline (`src/supervisor/`)
- [ ] **Pre-Flight Router (`router.py`):** Implement single-pass classification for `action_required` and `allowed_tools` multi-select probability scoring.
- [ ] **Grounding Extractor (`grounding.py`):** Implement `d1-Omni-2B` span extraction to map vague spoken references (*"that section about API keys"*) to exact `[start_char, end_char]` and line numbers in the note.
- [ ] **Visual BBox Extractor (`vision_grounding.py`):** Use `d1-Omni-2B` open-vocabulary bounding box detection to crop regions of interest from camera/screen frames before passing them to `LFM3-VL-2B`.
- [ ] **Post-Call Critic (`critic.py`):** Build the verification gate that scores proposed `<tool_call>` XML payloads against the user's raw audio and target spans, triggering automatic worker retries if $P(\text{valid}) < 0.80$.

### Phase 4: The `LFM3-Omni-2B` Live Loop & Delegation Bridge (`src/interface/`)
- [ ] Implement 16kHz microphone capture with Voice Activity Detection (VAD) and 2fps video frame ring buffering.
- [ ] Configure `LFM3-Omni-2B` system prompt to act as an attentive, concise conversational partner that acknowledges commands (*"Got it, updating the Q3 table now..."*) while emitting a structured delegation event to the background worker queue.
- [ ] Wire asynchronous completion callbacks: when `LFM3-VL-2B` finishes an edit verified by `d1-Omni-2B`, push a brief state update back to `LFM3-Omni-2B` so it can verbally notify the user if needed.

### Phase 5: UI & Fine-Tuning Polish
- [ ] Build a clean split-screen UI:
  - **Left Pane:** Live camera/screen preview with `d1-Omni-2B` bounding-box overlays and audio waveform visualizer.
  - **Right Pane:** Live Markdown editor showing real-time line highlights (from `d1-Omni-2B` span extraction) and animated diffs as `LFM3-VL-2B` applies `<tool_call>` edits.
- [ ] **Domain Specialization (Optional):** Log rejected tool calls and supervisor corrections to run a lightweight LoRA SFT pass on `LFM3-VL-2B` / `LFM3-1.7B` on a single GPU.

---

## 8. Edge Cases, Failure Modes & Safeguards

| Failure Scenario | How the Trinity Architecture Handles It |
| :--- | :--- |
| **User is just thinking out loud / coughing / talking to someone else** | `d1-Omni-2B` evaluates raw audio + visual state in one pass and classifies `action_required = "conversational_only"` (or `"ignore"`), preventing false-positive file edits. |
| **User gives an ambiguous command (*"Delete that part"*)** | `d1-Omni-2B`'s span extraction returns low confidence / multiple competing spans. The orchestrator blocks the worker and prompts `LFM3-Omni-2B` to ask: *"Did you mean the first bullet point or the whole section?"* |
| **The worker hallucinates line numbers or overwrites adjacent text** | `d1-Omni-2B` Stage B provides exact `old_text_anchor` spans beforehand, and Stage C Critic compares the proposed edit span against the extracted span, rejecting mismatches in ~6ms before the file is touched. |
| **Note grows too large (>32K tokens) for `LFM3-Omni-2B`** | `LFM3-Omni-2B` never holds the full file—only a ~1K-token ToC/summary. `d1-Omni-2B` (128K context) and `LFM3-1.7B` (256K) handle the full document state. |
| **License Compliance** | All models run under the **LFM Open License v1.0** (free commercial use under $10M annual revenue; verify organizational revenue thresholds prior to commercial redistribution). |

---

# 9. Build Notes (this repository)

> Added during implementation so the build survives context compaction and new sessions.

## 9.1 What was built

A complete, self-contained LiquidScribe desktop workspace in **Vite + React + TypeScript**.

- **Left column:** simulated (or real) camera/screen feed with `d1` ROI overlays, audio waveform,
  live transcript, delegation events and a command bar.
- **Center column:** line-numbered Markdown workspace with supervisor target-span highlights,
  animated diffs, snapshot/undo stack, document + source views.
- **Right column:** model trinity runtime, live supervisor stage trace, context-budget meters,
  and snapshot history.
- **Trace drawer:** per-command decision trace — routing probabilities, span/bbox grounding,
  pruned tool schema, full worker XML, critic checks, execution diff.
- **Tooling:** `add_text`, `edit_text`, `remove_text`, `extract_visual_to_note` implemented against
  a real Markdown editor with atomic execution and history.
- **Voice:** live Omni-2B ASR (`/v1/audio/transcriptions`) and model TTS (`/tts`, 24 kHz WAV) with
  browser speech fallbacks; auto-stop capture, barge-in and a speaker toggle. Camera/screen capture
  are opt-in and feed real frames into d1 routing, Omni chat and visual extraction.
- **QA:** `scripts/qa-suite.mjs` — 31-case CDP battery over the live trinity (`npm run qa`).

## 9.2 Runtime (live trinity + deterministic fallbacks)

The native bridge landed (b1c76ec, hardened through 345a042). Three llama.cpp servers serve the
trinity — started with `scripts/start-models.sh` (idempotent; `scripts/stop-models.sh` to stop):

- **LFM3-Omni-2B :8083** — chat (streamed), ASR, TTS.
- **d1-Omni-2B :8085** — typed routing + critic decisions over `/v1/systemone`.
- **LFM3-1.7B :8080** — worker XML tool calls (primary worker).
- *(2026-11-08)* `LFM3-VL-2B` (:8081) removed from the runtime: no probe, no worker path —
  deterministic extraction covers `extract_visual_to_note`, and probing an absent optional
  server failed the QA console gate (case 1b).

Every caller is live-first with a local deterministic fallback (regex router, keyword grounding,
template worker emitter, canned conversational replies); the trace records which path ran, and the
Runtime truth card probes every endpoint every 10 s. Live camera/screen frames reach d1 routing,
Omni chat and visual extraction through `resolveSceneFrame`; the synthetic review slide is the
fallback prop. Note: `./lfm3.sh stop` does not manage servers started outside the family script —
prefer this repo's start/stop scripts.

## 9.3 Directory map

```
src/
  components/       UI surfaces (visual stage, note, supervisor rail, trace drawer, …)
  data/             seed note, synthetic slide/scene, model roster, tool catalog
  lib/              supervisor heuristics, worker, XML parser, tool engine, markdown parser, speech
  state/            orchestrator hook, history stack, context accounting
  styles/           design tokens + application styles
```

## 9.4 Commands

```bash
npm install
npm run dev       # http://localhost:5173
npm run build
npm run typecheck
npm run qa        # 31-case CDP battery — needs the dev server + trinity up (scripts/start-models.sh)
```

## 9.5 Known scope limits

- Span grounding is live: vague references go to d1-Omni's typed span question over structural
  candidates (§4 Stage B, landed 2026-11-08); the deterministic keyword/quote search — plus the
  literal quote/line/ordinal pre-empts — is the fallback and the d1-down path.
- Natural phrasing is normalized before routing/planning (`normalizeCommand` strips fillers,
  scene-setting clauses and hedges; gerund verb forms match everywhere), and template detection
  no longer requires verb-first phrasing — §10 WS3, QA cases 12d/12e.
- The 1.7B worker decodes ~7–14 s per mutation (it reasons at length inside `<think>`) — expected,
  not a hang.
- Chat context: the full note is resent every chat turn (prefix caching absorbs most of it).
- Vite HMR can serve a stale module graph after import changes — restart `npm run dev`.
- Speech fallbacks still depend on browser support when a model server is down.

## 9.6 Build status

- [x] Vite + React + TypeScript workspace UI (three-column desktop layout).
- [x] Markdown document renderer with source line numbers, table/list/KaTeX support.
- [x] Supervisor target-span and ROI overlays, animated diffs, source editor.
- [x] All four tool contracts with anchor checks and atomic line execution.
- [x] In-memory snapshot stack, undo/redo, source-edit snapshots.
- [x] d1 router, grounding, critic trace and worker XML round-trip.
- [x] Live session, voice capture, browser TTS, guided demo.
- [x] Decision trace drawer, context budgets, runtime rail, About dialog.
- [x] `npm run typecheck` and `npm run build` pass.
- [x] Headless Chromium test pass on 2026-11-08 (see 9.7).
- [x] Native LFM3 bridge (2026-11-08): Omni-2B ASR + chat (:8083), d1-Omni-2B routing/critic
      over `/v1/systemone` (:8085), worker decode via llama.cpp. d1 checkpoints fetched from
      LiquidAI HF repos. Local deterministic fallbacks remain when a server is down, and the
      Runtime truth card probes every endpoint every 10 s.
- [x] 1.7B-default worker swap (345a042): LFM3-1.7B (:8080) decodes every text mutation; VL-2B
      (:8081, optional) keeps visual ROI crops and serves as worker fallback.
- [x] CDP QA battery — 31 live cases over the real trinity (`npm run qa`, c9bc352 + §10 WS4).
- [x] Persistent workspace storage across reloads (landed in b1c76ec; QA case 15 covers it).
- [x] Rejected-trace JSONL export (produces the SFT dataset for the backlog item below).
- [x] §10 MVP hardening (2026-11-08): d1 tool choice honored + thresholds unified (WS1), Omni
      chat contract + output sanitizer (WS2), natural-phrasing document creation (WS3), QA
      cases 12d/12e + chat hygiene (WS4) — battery green 31/31.
- [x] VL-2B removed from the runtime (2026-11-08): no :8081 probe or worker path; extraction is
      deterministic — battery green 31/31 with :8081 absent.
- [x] Structural span grounding (§4 Stage B, 2026-11-08): d1-Omni typed span question over
      structural candidates (sections/paragraphs/bullets/rows, kind-constrained by the spoken
      noun); adopt at p ≥ 0.25, overturn a deterministic miss only at p ≥ 0.5; the title→H1 and
      "remove the X section" special cases were deleted. QA cases 23/24 cover vague grounding.
- [x] Phone-width command surface (2026-11-08): ≤780px Session/Note/Runtime tabs with a
      persistent bottom composer; 21-check standalone CDP run at 390×844 (no overflow, mic
      capture state, typed command → visible edit, zero console errors).
- [ ] Domain LoRA fine-tuning on rejected traces (§7 Phase 5). Descoped 2026-11-08 at user
      request — the JSONL export still produces the dataset; the SFT pass itself did not run.

## 9.7 Live test pass (2026-11-08)

Tested with a locally launched Vite dev server and Playwright-driven Chromium 1169. No model server
was started; all inference remained the documented simulation.

**Viewports:** 1440×900, 1280×800, 1120×800, 1024×800, 900×800, 820×900, 768×900, 600×900 and
390×844. Checked body/grid overflow, suggestion wrapping, note-header fit, rail overflow and the
responsive hand-off to the note-only layout.

**Flows exercised:**
- Q3 revenue edit, Redis removal, LTV/CAC extraction, support-backlog add, and undo/redo.
- Ambiguous `Remove that` → clarification chips → Redis removal.
- Over-broad paragraph replacement → critic hold; trace shows the failed `blast_radius` check.
- Conversational `What can you see?`, `What changed?`, status and repeated undo handling.
- Guided four-command demo; demo stop-with-current-call-finishing.
- Markdown source edit, dirty/discard/commit, snapshots, and Ctrl+Enter.
- Snapshot history expand/restore/collapse.
- Trace drawer, copy button, trace selection, `Esc` close; About dialog at desktop and 390px.
- Fake-device camera capture/stop, preview-only labelling, voice-permission fallback.
- `Ctrl+K` focus and keyboard shortcuts. No console errors or page exceptions were recorded.

**Fixes made during the pass:**
- Wrapped suggestion chips instead of clipping them at 1280/1120/900.
- Removed the 821–820px responsive gap that left a 344px note column.
- Kept the full note title at 1280px by hiding the save-state chip earlier.
- Fitted the right rail by tightening its gap/row heights; snapshots can now expand and restore
  earlier entries instead of exposing a dead "earlier snapshot" affordance.
- Showed real worker output tokens in the supervisor header.
- Removed the stale run id from the idle status bar.
- Cleaned snapshot labels (`Q3 | …`, not `| Q3 | …` or a leading bullet).
- Surfaced the failing critic check in the trace header for held calls.
- Added icon-only tab names and view labels at narrow widths.
- Labelled live camera/screen as preview-only; simulated visual reasoning remains on the demo frame.
- Cleared stale capture notices on camera stop.

## 9.8 Next steps

1. [x] Wire a native bridge and start the local LFM3 servers (Omni :8083, d1-Omni :8085, 1.7B :8080;
   `scripts/start-models.sh`).
2. [x] Fetch the public d1-2B / d1-Omni-2B weights and connect `/v1/systemone` for typed routing,
   grounding disambiguation and critic decisions.
3. [x] Pass live camera/screen frames into the bridge (`resolveSceneFrame` feeds d1 routing, Omni
   chat and visual extraction); the synthetic scene is the fallback.
4. [x] Persistent workspace (localStorage, b1c76ec) and the real mobile command surface
   (≤780px phone tabs + persistent composer, 2026-11-08).
5. [x] Log rejected traces — the JSONL export already produces the SFT dataset. The LoRA/tool-call
   SFT pass was descoped on 2026-11-08 at user request (see §9.6).

Current work continues in §10.

---

# 10. Action Plan — MVP Hardening (2026-11-08)

Three live-session complaints drive this pass. Root cause everywhere: the deterministic layer
demands verb-first imperatives, and live d1 decisions are dropped or vetoed at four inconsistent
probability thresholds. **No architecture change** — the trinity flow (Omni chats, d1
routes/critiques, 1.7B writes XML) stays as designed; the deterministic layer becomes forgiving,
the thresholds align, and Omni's chat contract becomes honest.

## 10.1 Diagnosis

**A. "The decision model still blocks a bunch of tool calls"** — four silent gates:

| Gate | Bug | Location |
| :--- | :--- | :--- |
| d1's tool pick is thrown away | `routeFromAnswers` reads only `toolAnswer.probabilities` and never `toolAnswer.choice`; a choice without probabilities returns `null` and silently downgrades to the regex router | `src/state/useWorkspace.ts:229-242` |
| Threshold mismatch | `allowedTools` filtered at p>0.02 (route, `useWorkspace.ts:248`), retry alternatives at p>0.2 (`useWorkspace.ts:1284`), critic `tool_match` demands p>0.25 (`src/lib/supervisor.ts:1371`). A tool with p=0.22 passes routing, wins the grounding retry, then is *guaranteed* rejected — and the retry switches `primaryTool` without updating `allowedTools` | as listed |
| d1 semantic critic is a hard gate with no retry | `noul >= 0.5` rejects even when all local hard gates pass; the critic feedback says "Retry…" but nothing retries | `useWorkspace.ts:1511-1519` |
| Worker must echo the primary tool | A well-formed 1.7B call for a different sensible tool (e.g. `edit_text` when routed `add_text`) is discarded on both attempts → template fallback or run failure | `useWorkspace.ts:1444-1447` |

**B. "Omni acts dumb; doesn't understand it should just delegate"**

- Omni only ever sees `conversational_only` turns — mutation turns bypass it entirely (canned
  ack/result templates speak instead), so it has no lived context of edits
  (`useWorkspace.ts:1135-1238`).
- Its system prompt (`useWorkspace.ts:319-325`) never says "you have no tools / never emit XML /
  hand edits to the worker" — misrouted edit intent makes a 2B model improvise promises or
  tool-call-like text, and nothing sanitizes that output.
- Every chat turn — including small talk — carries a 3,600-char note dump plus frame notice before
  the actual question (`useWorkspace.ts:327-336`), diluting a 2B model's attention (QA case 2
  already fights this with its "clean reply" assertion).

**C. "Crumbles on 'The document is empty now, begin by writing a readme template .md doc'"**

That sentence dies at every layer because the regexes demand verb-first imperatives:

- `startsMutation` (`supervisor.ts:182`) requires the sentence to *begin* with the verb — this one
  begins with "The".
- `MUTATION_VERBS` (`supervisor.ts:50`) matches `\bwrite\b` — "writing" doesn't match (word
  boundary). Local router: `conversational_only` 0.82.
- Even when d1 routes it `file_mutation/add_text`, `wantsDocumentTemplate` requires the verb-initial
  `CREATION_HEAD` (`supervisor.ts:802-934`), and `extractAddContent`'s `afterVerb` also needs the
  bare verb "write" → null → `missing_content` clarification: *"I found the target, but no
  replacement text came through"* — nonsense on an empty document that has no target. QA case 12
  passes only because it is phrased verb-first ("Create a readme template…").

## 10.2 Workstreams

**WS1 — stop the over-blocking** (`useWorkspace.ts`, `supervisor.ts`)

1. Honor d1's tool choice: if `toolAnswer.choice` exists but probabilities are missing/zero, use
   the chosen name with p=0.7; floor the primary tool's p at 0.6 in `allowedTools`.
2. One threshold everywhere: critic `tool_match` passes if `call.name === route.primaryTool` **or**
   membership in `allowedTools` with p>0.25; the grounding retry merges the switched tool into
   `allowedTools` at p≥0.5.
3. Soften the d1 semantic critic: reject only on `noul < 0.35` when local hard gates pass (the
   score still lands in the trace). Local hard gates — anchor exactness, blast radius (QA case
   12c) — remain absolute.
4. Accept good worker calls: the attempt loop accepts a parsed call for any allowed tool (p>0.25)
   with all required params non-empty, not just the primary. Critique still gates it.

**WS2 — Omni chat contract** (`useWorkspace.ts`)

1. Rewrite the system prompt: explicit contract — no tools, cannot edit files, never emit XML/JSON/
   code blocks as actions; if the user asks for a note change, reply in one short sentence that the
   edit pipeline takes it from here.
2. Slim the payload for non-note turns: full note only when the question is note-related (keyword
   check like the existing `wantsVisual`); otherwise a one-line outline (title + H2 headings via
   `getHeadings`) — moves §6.1 toward its original ToC design.
3. Sanitize Omni output: strip `<tool_call>`/`<function=`/fenced action blocks from the final reply
   before display/TTS; empty after sanitize → existing `conversationalReply` fallback.

**WS3 — natural-phrasing document creation** (`supervisor.ts`)

1. `normalizeCommand()`: strip leading fillers ("um,", "hey,", "okay,"), scene-setting clauses
   ("the document is empty now,", "the doc is blank,"), and hedges ("begin by", "start by", "go
   ahead and", "I want you to"). Applied at the top of `routeCommand` and `buildPlan` (both pure
   and idempotent); the trace and chat bubble keep the raw text.
2. Gerund verbs in `MUTATION_VERBS`, `startsMutation`, `CREATION_HEAD` (writing, adding, creating,
   making, drafting…). After normalization the failing sentence becomes "write a readme template
   .md doc" → matches.
3. `wantsDocumentTemplate` fallback: when not verb-first, still detect
   `readme|changelog|faq|todo…` + `template|boilerplate|skeleton|outline` anywhere in a short
   command; tolerate ".md"/"markdown" suffixes (`templateTitle` already ignores them).
4. Honest empty-doc clarification in `buildClarification`: "The document is empty — I can start it
   for you. Try 'create a readme template' or tell me the first line."
5. One criteria line for `ROUTE_QUESTIONS.file_mutation`: creating or writing a whole document or
   template counts as `file_mutation` (add_text).

**WS4 — lock it in with the QA battery** (`scripts/qa-suite.mjs`)

- Empty seed + the exact failing sentence "The document is empty now, begin by writing a readme
  template .md doc" → `verified`, note starts `# README`, ≥20 lines.
- "hey, go ahead and create a changelog template" → `verified`, `# Changelog`.
- Chat-hygiene assertion on an existing conversational case: the reply contains no `<tool_call>` /
  `<function=` / fenced actions.

## 10.3 Path of least resistance

Ordered; each step independently shippable and verifiable:

1. **WS3** — pure deterministic code, no model-behavior risk, kills the most visible failure.
   Verify with the new QA case alone.
2. **WS1** — four targeted edits; verify QA cases 6/7/8/9/12c stay green (blocking should now only
   trigger on real faults like blast radius).
3. **WS2** — prompt strings + one sanitizer helper; verify cases 2/3/4/5 plus the new hygiene
   assertion.
4. **WS4 full run** — `npm run typecheck`; with the trinity up (`scripts/start-models.sh`) and the
   dev server on :5173, `npm run qa` to green; then sync TODO.md/README and commit (the swap+QA
   commit TODO.md is waiting on).

Rough diff: \~120 lines across `supervisor.ts`, `useWorkspace.ts`, `qa-suite.mjs` — no new files, no
type changes, no dependency changes.

**Status (2026-11-08): landed and green.** WS1–WS4 implemented in `supervisor.ts`,
`useWorkspace.ts` and `qa-suite.mjs`; `npm run typecheck` and `npm run build` pass; the QA
battery ran 31/31 PASS with zero console errors against the live trinity (Omni :8083,
d1-Omni :8085, LFM3-1.7B :8080, VL-2B :8081).

---

# 11. Corrected design — Omni-first (2026-11-09)

§10 hardened the supervisor-first pipeline; it did not question it. On
2026-11-08 the owner reported the lived symptom — *"write a README template
document to begin"* on a non-empty note inserts that literal phrase instead of
drafting a README — and on 2026-11-09 stated the design in his own words. The
shipped architecture **inverts** it:

| Owner's design | Shipped build (§1–§6, §10) |
| :--- | :--- |
| Omni is the only user-facing model; every turn goes to it first | d1 + regex route before Omni; mutation turns never reach Omni |
| Omni silently delegates with a typed, context-resolved directive | No directive exists; a deterministic plan pre-decides tool, span and content |
| The 1.7B worker authors the edit and the tool call | The worker transcribes supervisor-authored content into XML ("insert verbatim", one schema, span ±3 lines) |
| d1 is a safety check on finished calls, fed directive + context + frame | d1 routes, grounds and critiques; its critic packet has no directive, no turns, no frame |
| d1 disapproval → pending edit, user adjudicates ✓ / ✗ | d1 rejection is a dead end |

The full corrected spec — roles, flow, directive schema, the downhill-distilled
context policy (worker gets the last 3 edit turns as *outcomes*, not raw
transcript), hard gates vs. semantic veto, the pending-edit object and UI
contract, degradation rules, the file-by-file refactor delta (§12 there), and
acceptance criteria including the README case on a non-empty note — lives in
[`docs/design.md`](./docs/design.md) and is authoritative. The §10 workstreams
are closed; the next implementation work is the design.md refactor (tracked in
TODO.md), planned phase-by-phase in
[`docs/architecture-refactor.md`](./docs/architecture-refactor.md).



---

Implement plan.md §10 — MVP hardening (WS3 → WS1 → WS2 → WS4)
Context
Three live-session complaints: d1 blocks legitimate tool calls; Omni chat acts context-blind and tries to act on edits itself; the pipeline crumbles on naturally phrased creation commands ("The document is empty now, begin by writing a readme template .md doc"). Root causes are diagnosed in plan.md §10 (merged earlier this session): verb-first regex assumptions and four inconsistent probability thresholds (0.02 / 0.2 / 0.25 / 0.5). Scope confirmed with user: §10 as-is — no vitest, no grammar-constraint spike. No architecture change; \~120 lines across three files.

Step 1 — WS3: natural-phrasing creation (src/lib/supervisor.ts)
Add normalizeCommand(): strip leading fillers ("um,", "hey,", "okay,", "so,"), scene-setting clauses ("the document/note/doc/file is (now) empty/blank/cleared" + delimiter), and hedges ("begin by", "start by", "go ahead and", "I want you to"). Apply at the top of routeCommand() (supervisor.ts:141) and buildPlan() (supervisor.ts:1121) — both pure, normalization idempotent; trace/chat bubbles keep the raw command.
Gerund verb forms in MUTATION_VERBS (supervisor.ts:50), startsMutation (supervisor.ts:182), and CREATION_HEAD (supervisor.ts:804): writing, adding, creating, making, drafting, generating… After clause-stripping the failing sentence becomes "write a readme template .md doc" → matches.
wantsDocumentTemplate fallback (supervisor.ts:881): when not verb-initial, still match readme|changelog|faq|todo… + template|boilerplate|skeleton|outline in a short command; strip ".md"/"markdown" tokens so they neither count as content words nor break the word limit (templateTitle already ignores the tail).
buildClarification (supervisor.ts:1564): empty-note-aware copy for missing_content — "The document is empty — I can start it for you…" instead of the current target-talk.
ROUTE_QUESTIONS.file_mutation criteria (supervisor.ts:120): add "creating or writing a whole document or template counts as file_mutation (add_text)".
Step 2 — WS1: stop the over-blocking (src/state/useWorkspace.ts, src/lib/supervisor.ts)
routeFromAnswers (useWorkspace.ts:229): honor toolAnswer.choice when probabilities are missing/zero (use chosen name at p=0.7); floor the primary tool's p at 0.6 in allowedTools.
Grounding retry (useWorkspace.ts:1282-1303): when switching primaryTool to an alternative, merge it into allowedTools at p≥0.5.
critique tool_match (supervisor.ts:1371): pass when call.name === route.primaryTool or membership in allowedTools with p>0.25.
d1 semantic critic (useWorkspace.ts:1511): reject only on noul < 0.35 when local hard gates pass; score still recorded in the trace. Local hard gates (anchor exactness, blast radius — QA case 12c) stay absolute.
Worker attempt acceptance (useWorkspace.ts:1444): accept a parsed call for any allowedTools member (p>0.25) with all required params non-empty — not just the primary. Critique still gates it.
Step 3 — WS2: Omni chat contract (src/state/useWorkspace.ts)
Rewrite buildChatMessages system prompt (useWorkspace.ts:319): explicit contract — no tools, cannot edit files, never emit XML/JSON/code blocks as actions; edit requests get a one-sentence hand-off to the edit pipeline.
Slim payload: full note only on note-relevant turns (keyword check, pattern of the existing wantsVisual at useWorkspace.ts:1170); otherwise title + H2 headings via existing getHeadings (src/lib/doc.ts).
Add sanitizeReply(): strip <tool_call> / \<function= / fenced action blocks from the final streamed reply before display/TTS; empty after sanitize → existing conversationalReply fallback.
Step 4 — WS4: QA cases + green run (scripts/qa-suite.mjs)
Group C: empty seed + exact sentence "The document is empty now, begin by writing a readme template .md doc" → verified, note starts # README, ≥20 lines.
Group E: "hey, go ahead and create a changelog template" → verified, # Changelog.
Chat hygiene: assert conversational replies contain no <tool_call> / \<function= / fenced actions (attach to case 5).
Verification
npm run typecheck.
Trinity already verified up (:8080/:8083/:8085); start npm run dev in background, run npm run qa — all 29 existing cases + new ones green (case 9 landing in clarify remains the documented known-behavior).
Manual spot-check in the app of the three complaint sentences.
Sync TODO.md (close the in-flight QA/commit item, note §10 landed) and commit once green.
