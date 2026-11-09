/**
 * The single pipeline flag for the omni-first refactor
 * (docs/architecture-refactor.md §1.2).
 *
 * `false` = the shipped supervisor-first pipeline. Flipped to `true` once
 * the P2–P5 wiring landed (the P6 flip); the flag and the old path are
 * deleted in the final P6 step, after the workstation QA soak.
 * No per-stage flags — partial configurations are the shipped build's defect.
 */
export const OMNI_FIRST = true;
