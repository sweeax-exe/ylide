// Agent message templates and their `{placeholder}` fields.

import type { PromptTemplates } from '../../../bindings/PromptTemplates';

export type TemplateKey = keyof PromptTemplates;

export const TEMPLATE_KEYS: readonly TemplateKey[] = ['planner', 'coderTask', 'reviewerTask', 'feedback', 'question', 'continue', 'repeatedFailure'];

/**
 * Values the core fills into each template (crates/agent/src/orchestrator.rs).
 * `availablePlaceholders` adds any field the shipped default uses, so fields
 * added to the core later are recognised too.
 */
export const TEMPLATE_PLACEHOLDERS: Readonly<Record<TemplateKey, readonly string[]>> = {
  planner: ['goal', 'roles', 'outline', 'environment'],
  coderTask: ['overview', 'task_id', 'task_title', 'task_description', 'task_files', 'environment'],
  reviewerTask: ['task_id', 'task_title', 'task_description', 'summary', 'diff', 'environment'],
  feedback: ['round', 'max_rounds', 'review'],
  question: ['overview', 'from', 'question'],
  continue: [],
  repeatedFailure: [],
};

/** Placeholders used in a text, in order of first use. Same syntax as `fill` in the core. */
export function placeholdersIn(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

export interface TemplateIssues {
  /** Not filled by the core; sent to the model as written. */
  unknown: string[];
  /** Available but not used; the model will not see that information. */
  missing: string[];
}

/** Known fields of a template plus those its shipped default uses. */
export function availablePlaceholders(key: TemplateKey, defaultText?: string): string[] {
  const known = [...TEMPLATE_PLACEHOLDERS[key]];
  for (const p of placeholdersIn(defaultText ?? '')) if (!known.includes(p)) known.push(p);
  return known;
}

export function templateIssues(text: string, known: readonly string[]): TemplateIssues {
  const used = placeholdersIn(text);
  return {
    unknown: used.filter((p) => !known.includes(p)),
    missing: known.filter((p) => !used.includes(p)),
  };
}

/** Replaces the selection [start, end) with `insert`; returns the new text and caret. */
export function insertText(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length };
}
