// The onboarding sequence and the paths through it. Pure, so the step rail
// and the navigation rules can be tested without a DOM.

import type { Candidate } from '../../bindings/Candidate';
import type { InstalledModel } from '../../bindings/InstalledModel';

export const STEPS = ['welcome', 'scan', 'model', 'download', 'ready'] as const;
export type StepId = (typeof STEPS)[number];
export type StepState = 'done' | 'current' | 'upcoming' | 'skipped';

/** How the user gets a model: from the registry, from a local file, or from a server they already run. */
export type ModelPath =
  | {
      kind: 'registry';
      candidate: Candidate;
      /** Runtime variant to install first (e.g. "cuda-13.4"), or null. */
      runtimeVariant: string | null;
      /** False when the model files are already on this computer. */
      needsModel: boolean;
    }
  | { kind: 'imported'; model: InstalledModel }
  | { kind: 'external'; baseUrl: string; model: string | null };

export function needsDownload(path: ModelPath | null): boolean {
  return path?.kind === 'registry' && (path.needsModel || path.runtimeVariant !== null);
}

/** The step that follows the model choice. */
export function stepAfterModel(path: ModelPath): StepId {
  return needsDownload(path) ? 'download' : 'ready';
}

export function stepStates(current: StepId, path: ModelPath | null): Record<StepId, StepState> {
  const at = STEPS.indexOf(current);
  const skipDownload = path !== null && !needsDownload(path) && at > STEPS.indexOf('model');
  const out = {} as Record<StepId, StepState>;
  STEPS.forEach((step, i) => {
    if (step === 'download' && skipDownload) out[step] = 'skipped';
    else out[step] = i < at ? 'done' : i === at ? 'current' : 'upcoming';
  });
  return out;
}

/** Fraction of the sequence that is behind the user (0 at welcome, 1 at ready). */
export function railProgress(current: StepId): number {
  return STEPS.indexOf(current) / (STEPS.length - 1);
}
