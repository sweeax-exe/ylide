// Parameters of recommendation reasons, prepared for `common:reasons.<code>`.

import type { Reason } from '../../../bindings/Reason';

export interface ReasonFormat {
  /** Translated tool-calling level ("good" -> "gut"). */
  level: (level: string) => string;
  /** Token counts for display ("131072" -> "128K"). */
  tokens: (n: number) => string;
}

/** Translates the level and formats token counts; other parameters pass through. */
export function reasonParams(reason: Reason, fmt: ReasonFormat): Record<string, string> {
  const params: Record<string, string> = { ...reason.params };
  if (params.level) params.level = fmt.level(params.level);
  if (params.tokens && /^\d+$/.test(params.tokens)) params.tokens = fmt.tokens(Number(params.tokens));
  return params;
}

/** Benchmark reasons carry whether the publisher reported the score itself. */
export function isSelfReported(reason: Reason): boolean {
  return reason.code === 'benchmark' && reason.params.selfReported === 'true';
}
