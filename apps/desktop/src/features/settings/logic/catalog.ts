// Registry catalog: filtering, grouping, recommendation marks and localized text.

import type { AlternativeKind } from '../../../bindings/AlternativeKind';
import type { Model } from '../../../bindings/Model';
import type { Recommendation } from '../../../bindings/Recommendation';
import type { Role } from '../../../bindings/Role';
import type { Variant } from '../../../bindings/Variant';

export type RoleFilter = 'all' | Role;

export const ROLE_FILTERS: readonly RoleFilter[] = ['all', 'chat', 'agent', 'fim', 'embedding'];

export function filterByRole(models: readonly Model[], role: RoleFilter): Model[] {
  return role === 'all' ? [...models] : models.filter((m) => m.roles.includes(role));
}

export function variantBytes(variant: Variant): number {
  return variant.files.reduce((sum, f) => sum + f.sizeBytes, 0);
}

export type Mark = { kind: 'primary' } | { kind: 'alternative'; alternative: AlternativeKind } | { kind: 'autocomplete' } | { kind: 'embedding' };

export const selectionKey = (modelId: string, quant: string) => `${modelId}::${quant}`;

/** Recommended configurations by `selectionKey`. */
export function recommendationMarks(rec: Recommendation | null): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  if (!rec) return marks;
  const put = (modelId: string, quant: string, mark: Mark) => {
    const key = selectionKey(modelId, quant);
    if (!marks.has(key)) marks.set(key, mark);
  };
  if (rec.primary) put(rec.primary.modelId, rec.primary.quant, { kind: 'primary' });
  for (const alt of rec.alternatives) put(alt.candidate.modelId, alt.candidate.quant, { kind: 'alternative', alternative: alt.kind });
  if (rec.autocomplete) put(rec.autocomplete.modelId, rec.autocomplete.quant, { kind: 'autocomplete' });
  if (rec.embedding) put(rec.embedding.modelId, rec.embedding.quant, { kind: 'embedding' });
  return marks;
}

const markRank = (m: Mark) => (m.kind === 'primary' ? 0 : m.kind === 'alternative' ? 1 : 2);

/** The strongest mark among a model's quantizations. */
export function modelMark(marks: Map<string, Mark>, model: Model): Mark | null {
  let best: Mark | null = null;
  for (const v of model.variants) {
    const m = marks.get(selectionKey(model.id, v.quant));
    if (m && (!best || markRank(m) < markRank(best))) best = m;
  }
  return best;
}

/** Recommended models first (primary, then alternatives), otherwise registry order. */
export function orderCatalog(models: readonly Model[], marks: Map<string, Mark>): Model[] {
  const rank = (m: Model) => {
    const mark = modelMark(marks, m);
    return mark ? markRank(mark) : 3;
  };
  return models
    .map((m, i) => ({ m, i, r: rank(m) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.m);
}

/** The normal entries and the uncensored variants, each keeping the given order. */
export function splitUncensored(models: readonly Model[]): { normal: Model[]; uncensored: Model[] } {
  const normal: Model[] = [];
  const uncensored: Model[] = [];
  for (const m of models) (m.uncensored ? uncensored : normal).push(m);
  return { normal, uncensored };
}

/** Text in the UI language, falling back to English, then to any language. */
export function localized(dict: Readonly<Record<string, string>>, lang: string): string {
  return dict[lang] ?? dict.en ?? Object.values(dict)[0] ?? '';
}
