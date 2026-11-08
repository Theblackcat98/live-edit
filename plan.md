# Project Plan: LFM3 Multimodal Agentic Note & File Workspace ("LiquidScribe")

## 1. Executive Summary & Core Concept

**LiquidScribe** is a local-first, real-time multimodal workspace where a user can talk naturally, show documents/screens/whiteboards via camera or screen-share, and collaboratively build, edit, and organize notes/files hands-free.

Instead of relying on a single monolithic cloud LLM or a brittle pipeline of separate ASR + VLM + LLM + TTS models, this project leverages three specialized models from **Liquid AI's LFM3 family** sharing the 24-layer tri-hybrid backbone:

1. **The Interface (`LiquidAI/LFM3-Omni-2B`):** Listens (16kHz audio), watches (2fps video / native-res images), converses with the user in real-time (24kHz speech + text), and delegates actionable file tasks.
2. **The Supervisor (`LiquidAI/d1-Omni-2B`):** A zero-output-token multimodal decision model that runs single-forward-pass (~6–12ms) checks over the live audio, visual frame, conversation context, and note state. It constantly guides the worker model by routing tools, extracting exact target text spans/bounding boxes, and validating proposed tool calls before execution.
3. **The Agentic Worker (`LiquidAI/LFM3-VL-2B` / `LiquidAI/LFM3-1.7B`):** The dedicated tool-caller with `<think>` reasoning and XML `<tool_call>` generation that adds, edits, formats, and removes text in the user's files/notes.

---

## 2. Model Roles, Specifications & Hardware Budget

### 2.1 Model Roster

| Role | Checkpoint | Params | Context | Quantization (Target) | Est. Memory (Weights + KV) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Perceptual Front-End** | `LiquidAI/LFM3-Omni-2B` | 2.17B | 32K | Q4_K_M / MLX 4-bit / FP8 | ~1.5 GB |
| **Decision Supervisor** | `LiquidAI/d1-Omni-2B` | 2.17B | 128K | BF16 / Q8_0 (for calibration accuracy) | ~2.3 GB |
| **Visual/Text Worker** | `LiquidAI/LFM3-VL-2B` *(Primary)*<br>`LiquidAI/LFM3-1.7B` *(Heavy Text)* | 1.92B<br>1.73B | 128K<br>256K | Q4_K_M / JANG_6M / MLX 4-bit | ~1.3 GB |

* **Total Concurrent Memory Footprint:** ~5.1 GB to 6.5 GB (runs fully locally on Apple Silicon Macs with 16GB+ Unified Memory, consumer GPUs with 8GB+ VRAM, or Intel/AMD AI PCs).
* **Why `d1-Omni-2B` is kept at higher precision (Q8/BF16):** Decision models output calibrated probabilities in a single forward pass; preserving precision ensures probability calibration (`P(intent)`, span boundaries) remains sharp.
* **Worker Selection Policy:**
  * **Default Mode (`LFM3-VL-2B`):** Used whenever the task involves visual context (e.g., extracting diagrams, reading handwritten notes, referencing a screenshot) alongside file editing. It uses the exact `1.73B` LFM3 language backbone plus the 164M hybrid vision encoder.
  * **High-Capacity Text Mode (`LFM3-1.7B`):** Used when the active file/note exceeds 64K tokens (up to 256K) or requires multi-step agentic refactoring across multiple files, benefiting from `LFM3-1.7B`'s 4th-stage Agentic RL post-training.

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
       |                          |      WORKER: LFM3-VL-2B / LFM3-1.7B             |
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

## 4. Deep Dive: How `d1-Omni-2B` Constantly Helps the `1.7B (VL)` Worker

Small 1.7B–2B models can occasionally hallucinate tool parameters, pick the wrong edit operation (`add` vs `replace`), or misidentify which paragraph the user wants to change. **`d1-Omni-2B`** eliminates these failure modes via three millisecond-level interventions:

### Stage A: Pre-Flight Intent Routing & Tool Pruning (~6ms)

Whenever `LFM3-Omni-2B` detects an actionable request (or on every user turn via VAD trigger), `d1-Omni-2B` is queried with the raw audio clip, latest visual frame, and current note outline:

* **Decision Query 1 (`action_required`):** `["conversational_only", "file_mutation", "ambiguous_request"]`
  * *If `"ambiguous_request"` ($P > 0.60$):* Short-circuits the worker and instructs `LFM3-Omni-2B` to ask the user for clarification out loud.
* **Decision Query 2 (`allowed_tools`):** Multi-select classification over the tool catalog:
  * `["add_text", "edit_text", "remove_text", "create_section", "extract_visual_to_note", "format_note"]`
  * *Benefit:* Instead of stuffing 15+ tool schemas into the `1.7B (VL)` prompt, only the top 1–2 tools with calibrated probability $P > 0.25$ are injected into `apply_chat_template(tools=...)`. This dramatically increases the 1.7B model's tool-calling accuracy.

### Stage B: Zero-Token Grounding (Span & Bounding Box Extraction) (~8ms)

Before the `1.7B (VL)` model generates a single token, `d1-Omni-2B` uses its typed output heads in the same forward pass:

1. **Text Span Extraction:** Given the active note text and the user's spoken instruction (e.g., *"Change the deadline in the second paragraph to Friday"* or *"Remove the bullet point about Redis"*), `d1-Omni-2B` extracts the **exact character/line span** (`start_char`, `end_char`, `matched_substring`) from the file.
2. **Visual Bounding Box Extraction:** If the user references the camera/screen (e.g., *"Grab the formula in the top right of this slide and add it under section 2"*), `d1-Omni-2B` returns the open-vocabulary bounding box `[x1, y1, x2, y2]` with calibrated confidence.
3. **Prompt Injection:** The orchestrator crops the high-res image region (if visual) and highlights the exact target line numbers/span in the prompt sent to `LFM3-VL-2B` / `LFM3-1.7B`. The worker no longer has to guess *where* to edit.

### Stage C: Post-Generation Critic & Parameter Verification (~6ms)

Once `LFM3-1.7B` / `LFM3-VL-2B` outputs its `<think>` block and `<tool_call>`, the orchestrator intercepts the call **before** mutating the file and runs a single forward pass on `d1-Omni-2B`:

* **State Input:** `[User Audio Clip] + [Target Span] + [Proposed XML Tool Call]`
* **Typed Questions:**
  1. `does_tool_match_intent`: `["yes", "no_wrong_operation", "no_wrong_target_span", "no_hallucinated_content"]`
  2. `destructive_safety_check`: `["safe", "unintended_data_loss"]`
* **Feedback Loop:**
  * If $P(\text{"yes"}) \ge 0.80$ and $P(\text{"safe"}) \ge 0.85$: Execute the tool call immediately.
  * If rejected: Append a system critique message to the `1.7B (VL)` context (e.g., *"Supervisor rejected call: `no_wrong_target_span`. Expected edit within lines 14–18 (`matched_substring`), but tool targeted lines 30–35. Retry."*) and regenerate with `temperature=0.1`.

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

4. **`extract_visual_to_note`** *(Specific to `LFM3-VL-2B`)*
   * **Description:** Transcribes, summarizes, or converts a visual element (chart, table, whiteboard, handwritten note) into structured Markdown (e.g., Mermaid diagram, Markdown table, LaTeX math) and inserts it into the note.
   * **Parameters:**
     * `file_path` *(string, required)*
     * `visual_format` *(enum: `"markdown_table"`, `"mermaid_diagram"`, `"latex_block"`, `"bullet_summary"`, `"verbatim_ocr"`)*
     * `anchor_heading` *(string, required)*
     * `extracted_markdown` *(string, required)*

### 5.2 Example LFM3 Worker Generation

When guided by `d1-Omni-2B`, the `1.7B (VL)` model receives the supervisor's hints in its prompt and outputs:

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

1. **`LFM3-Omni-2B` Context (32K Limit — Rolling Window):**
   * Keeps only the last ~5–10 turns of spoken conversation, active video frames (sampled at 2 fps, 4–64 frames per interaction), and a **compact Document Table of Contents (ToC) + Last Edit Summary** (max ~2K tokens).
   * Prevents audio/video tokens from overflowing the 32K context window.
   * Generation parameters: `audio_temperature=1.0, audio_top_k=128, audio_repetition_penalty=1.1` for natural 24kHz speech output.

2. **`d1-Omni-2B` Context (128K Limit — Stateless Single-Pass Window):**
   * Constructed fresh on each decision pass: `[Last 15s Audio Clip] + [Current Keyframe] + [Last 3 Conversation Turns] + [Full Active Note Text (up to 64K tokens for optimal calibration)]`.
   * Because `d1-Omni-2B` generates **zero output tokens**, prefix caching on the active note text allows subsequent decision passes to execute in single-digit milliseconds.

3. **`LFM3-VL-2B` / `LFM3-1.7B` Context (128K / 256K Limit — Worker Task Window):**
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
| **User gives an ambiguous command (*"Delete that part"*)** | `d1-Omni-2B`'s span extraction returns low confidence / multiple competing spans. The orchestrator blocks the `1.7B (VL)` worker and prompts `LFM3-Omni-2B` to ask: *"Did you mean the first bullet point or the whole section?"* |
| **`1.7B (VL)` hallucinates line numbers or overwrites adjacent text** | `d1-Omni-2B` Stage B provides exact `old_text_anchor` spans beforehand, and Stage C Critic compares the proposed edit span against the extracted span, rejecting mismatches in ~6ms before the file is touched. |
| **Note grows too large (>32K tokens) for `LFM3-Omni-2B`** | `LFM3-Omni-2B` never holds the full file—only a ~1K-token ToC/summary. `d1-Omni-2B` (128K context) and `LFM3-VL-2B` (128K) / `LFM3-1.7B` (256K) handle the full document state. |
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
- **Voice:** browser SpeechRecognition and SpeechSynthesis when available, with a typed fallback.
  Microphone level drives the waveform; camera/screen capture are opt-in.

## 9.2 Runtime honesty

No model server is connected in this build. The app ships with a deterministic **simulated inference
layer** behind the same interfaces (router, grounding, worker, critic, executor). Local LFM3 GGUF
files exist on the development machine for text, VL, Audio and Omni, but the d1/d1-Omni supervisor
checkpoints are not installed and this repo has no native model bridge. Camera and screen inputs are
local previews; simulated visual reasoning still uses the synthetic review frame. Every surface
labels the runtime as simulated. The UI, tool contracts, trace format and execution engine are real
and are the integration points for a native model bridge.

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
```

## 9.5 Known scope limits

- The model bridge is simulated; latencies shown with a SIM marker are synthetic pacing values.
- Camera/screen capture depends on browser permissions; the synthetic slide is the default.
- Speech recognition/synthesis depend on browser support (`SpeechRecognition`, `speechSynthesis`).
- The synthetic visual scene is a fixed prop: table, formula card, bar chart and sticky note.

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
      over `/v1/systemone` (:8085), VL-2B worker decode (:8081). d1 checkpoints fetched from
      LiquidAI HF repos. Local deterministic fallbacks remain when a server is down, and the
      Runtime truth card probes every endpoint every 10 s.
- [ ] Persistent workspace storage across reloads (demo is intentionally in-memory).
- [ ] Domain LoRA fine-tuning on rejected traces.

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

1. Wire a native bridge and start the local LFM3 servers: `LFM3-Omni-2B` for the interface,
   `LFM3-VL-2B` for worker calls and `LFM3-1.7B` for large text refactors.
2. Fetch the public d1-2B / d1-Omni-2B weights and connect `/v1/systemone` for real typed routing,
   grounding and critic decisions.
3. Pass live camera/screen frames and audio into the bridge instead of using the synthetic scene.
4. Add a persistent workspace (IndexedDB or a local server store) and a real mobile command surface.
5. Log held traces for the optional LoRA/tool-call SFT pass.

