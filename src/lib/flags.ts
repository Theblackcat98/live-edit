/**
 * The single pipeline flag for the omni-first refactor
 * (docs/architecture-refactor.md §1.2).
 *
 * `false` = the shipped supervisor-first pipeline. Flips to `true` per phase
 * as that phase's gate passes; the flag and the old path are deleted in P6.
 * No per-stage flags — partial configurations are the shipped build's defect.
 */
export const OMNI_FIRST = false;
