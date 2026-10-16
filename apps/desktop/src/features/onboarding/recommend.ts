// Turns a Recommendation into what the model step shows: the selectable
// options, the memory picture of a plan and localized reason parameters.

import type { AlternativeKind } from '../../bindings/AlternativeKind';
import type { Candidate } from '../../bindings/Candidate';
import type { ComputeBudget } from '../../bindings/ComputeBudget';
import type { DownloadableRuntime } from '../../bindings/DownloadableRuntime';
import type { Plan } from '../../bindings/Plan';
import type { Reason } from '../../bindings/Reason';
import type { Recommendation } from '../../bindings/Recommendation';
import type { RuntimeStatus } from '../../bindings/RuntimeStatus';

export type OptionKind = 'primary' | AlternativeKind;

export interface ModelOption {
  key: string;
  kind: OptionKind;
  candidate: Candidate;
}

export const candidateKey = (c: { modelId: string; quant: string }) => `${c.modelId}@${c.quant}`;

/** The recommended candidate first, then the alternatives in the order the core ranked them. */
export function modelOptions(rec: Recommendation): ModelOption[] {
  const out: ModelOption[] = [];
  if (rec.primary) out.push({ key: candidateKey(rec.primary), kind: 'primary', candidate: rec.primary });
  for (const alt of rec.alternatives) {
    const key = candidateKey(alt.candidate);
    if (!out.some((o) => o.key === key)) out.push({ key, kind: alt.kind, candidate: alt.candidate });
  }
  return out;
}

/** Memory a candidate needs in total (graphics plus system memory). */
export const footprint = (c: Candidate) => c.plan.vramBytes + c.plan.ramBytes;

export type MemoryPart = 'weights' | 'kv' | 'overhead';

export interface MemoryBar {
  kind: 'vram' | 'ram' | 'unified';
  /** Usable size of this memory for one model. */
  capacity: number;
  used: number;
  parts: Array<{ part: MemoryPart; bytes: number }>;
}

/** Splits `used` into context cache, buffers and model weights (in that priority, never exceeding `used`). */
function split(used: number, kv: number, overhead: number): MemoryBar['parts'] {
  const kvShown = Math.min(kv, used);
  const overheadShown = Math.min(overhead, used - kvShown);
  const parts: MemoryBar['parts'] = [
    { part: 'weights', bytes: used - kvShown - overheadShown },
    { part: 'kv', bytes: kvShown },
    { part: 'overhead', bytes: overheadShown },
  ];
  return parts.filter((p) => p.bytes > 0);
}

/**
 * Where a plan puts its bytes. With a GPU, the context cache and buffers live
 * in graphics memory and system RAM only holds offloaded weights; on the CPU
 * (or in unified memory) everything shares one pool.
 */
export function memoryBars(plan: Plan, budget: ComputeBudget): MemoryBar[] {
  if (plan.placement.kind === 'unified' || budget.unified) {
    const used = plan.vramBytes + plan.ramBytes;
    const capacity = Math.max(budget.unifiedBytes || budget.ramBytes, used);
    return [{ kind: 'unified', capacity, used, parts: split(used, plan.kvBytes, plan.overheadBytes) }];
  }
  const bars: MemoryBar[] = [];
  const onGpu = plan.vramBytes > 0;
  if (onGpu) {
    bars.push({ kind: 'vram', capacity: Math.max(budget.vramBytes, plan.vramBytes), used: plan.vramBytes, parts: split(plan.vramBytes, plan.kvBytes, plan.overheadBytes) });
  }
  if (plan.ramBytes > 0) {
    bars.push({
      kind: 'ram',
      capacity: Math.max(budget.ramBytes, plan.ramBytes),
      used: plan.ramBytes,
      parts: onGpu ? [{ part: 'weights', bytes: plan.ramBytes }] : split(plan.ramBytes, plan.kvBytes, plan.overheadBytes),
    });
  }
  return bars;
}

/** Picks the current language from a registry text map, falling back to English, then to anything. */
export function pickLocalized(text: Record<string, string> | null | undefined, lang: string): string {
  if (!text) return '';
  return text[lang] ?? text.en ?? Object.values(text)[0] ?? '';
}

export interface ParamFormatters {
  number(n: number, digits: number): string;
  tokens(n: number): string;
  toolLevel(level: string): string;
}

/** Parameters that are names or codes and must be passed through untouched. */
const VERBATIM = new Set(['license', 'name', 'type', 'unit', 'selfReported']);
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Localizes the string parameters of a reason: numbers get the UI language's
 * separators (keeping their precision), token counts become "128K" and the
 * tool-calling level is translated.
 */
export function reasonParams(reason: Reason, fmt: ParamFormatters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(reason.params)) {
    if (key === 'level') out[key] = fmt.toolLevel(value);
    else if (key === 'tokens' && NUMERIC.test(value)) out[key] = fmt.tokens(Number(value));
    else if (!VERBATIM.has(key) && NUMERIC.test(value)) out[key] = fmt.number(Number(value), value.split('.')[1]?.length ?? 0);
    else out[key] = value;
  }
  return out;
}

/** The runtime pack worth offering (CUDA on NVIDIA), if one is not installed yet. */
export function runtimeOffer(status: RuntimeStatus | null): DownloadableRuntime | null {
  return status?.downloadable.find((r) => r.recommended) ?? null;
}
