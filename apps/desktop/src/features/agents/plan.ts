// Planning mode, the pure part: editing the plan by hand, finding what the
// orchestrator changed (to highlight it), turning a stopped run's open tasks
// back into a plan, and the plan as a Markdown file. No React, no IPC.

import type { PlanDoc } from '../../bindings/PlanDoc';
import type { PlanStep } from '../../bindings/PlanStep';
import type { Question } from '../../bindings/Question';
import type { RunData } from './run';

/** "T7" is 7; anything else 0. */
export function stepNumber(id: string): number {
  const m = /^T(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** The id for a new step: after every step of the plan and after `after` (the last task of a run it continues). */
export function nextStepId(doc: PlanDoc, after = 0): string {
  return `T${Math.max(after, 0, ...doc.steps.map((s) => stepNumber(s.id))) + 1}`;
}

export function updateStep(doc: PlanDoc, id: string, patch: Partial<Omit<PlanStep, 'id'>>): PlanDoc {
  return { ...doc, steps: doc.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeStep(doc: PlanDoc, id: string): PlanDoc {
  return { ...doc, steps: doc.steps.filter((s) => s.id !== id) };
}

/** Moves a step up (-1) or down (+1); at the edge nothing changes. */
export function moveStep(doc: PlanDoc, id: string, delta: -1 | 1): PlanDoc {
  const from = doc.steps.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= doc.steps.length) return doc;
  const steps = doc.steps.slice();
  [steps[from], steps[to]] = [steps[to], steps[from]];
  return { ...doc, steps };
}

/** Adds an empty step at the end; returns the plan and the new step's id. */
export function addStep(doc: PlanDoc, title: string, after = 0): { doc: PlanDoc; id: string } {
  const id = nextStepId(doc, after);
  const step: PlanStep = { id, title, description: '', files: [], verify: '', assignee: 'coder' };
  return { doc: { ...doc, steps: [...doc.steps, step] }, id };
}

/** "src/a.ts, src/b.ts" as a list; empty parts dropped. */
export function parseFiles(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((f) => f.trim())
    .filter(Boolean);
}

export interface PlanChanges {
  /** Steps that are new or changed. */
  steps: string[];
  approach: boolean;
  risks: boolean;
  questions: boolean;
}

/** What the orchestrator changed from `before` to `after`; everything is new when there was no plan. */
export function changedParts(before: PlanDoc | null, after: PlanDoc): PlanChanges {
  if (!before) return { steps: after.steps.map((s) => s.id), approach: true, risks: after.risks.length > 0, questions: after.questions.length > 0 };
  const old = new Map(before.steps.map((s) => [s.id, s]));
  const steps = after.steps
    .filter((s) => {
      const o = old.get(s.id);
      return !o || o.title !== s.title || o.description !== s.description || o.verify !== s.verify || o.files.join('\n') !== s.files.join('\n');
    })
    .map((s) => s.id);
  return {
    steps,
    approach: before.approach !== after.approach,
    risks: JSON.stringify(before.risks) !== JSON.stringify(after.risks),
    questions: JSON.stringify(before.questions) !== JSON.stringify(after.questions),
  };
}

export function hasChanges(c: PlanChanges): boolean {
  return c.steps.length > 0 || c.approach || c.risks || c.questions;
}

/**
 * A stopped run's open tasks as a plan again: same ids, without the note
 * the core adds about the last attempt (it adds that again when the plan is
 * carried out). None when nothing is left open.
 */
export function planFromRun(run: RunData): PlanDoc | null {
  const open = run.taskOrder.map((id) => run.tasks[id]).filter((t) => t && t.status !== 'done');
  if (!open.length) return null;
  return {
    goal: run.goal,
    approach: run.plan?.summary ?? '',
    steps: open.map((t) => {
      const [description, verify] = splitVerify(t.description);
      return { id: t.id, title: t.title, description, files: t.files, verify, assignee: t.assignee };
    }),
    risks: [],
    questions: [],
  };
}

/** A task description from a plan step ends with "How to verify: …"; split it off again. */
function splitVerify(description: string): [string, string] {
  const base = description.split('\n\nEarlier attempt: ')[0];
  const at = base.lastIndexOf('\n\nHow to verify: ');
  if (at < 0) return [base.trim(), ''];
  return [base.slice(0, at).trim(), base.slice(at + '\n\nHow to verify: '.length).trim()];
}

/** The highest task number of a run (new steps of its plan go on from there). */
export function lastTaskNumber(run: RunData | null): number {
  return Math.max(0, ...(run?.taskOrder ?? []).map(stepNumber));
}

/** The user's answers to the plan's open questions, as the wish that goes to the orchestrator. */
export function answersWish(intro: string, questions: Question[], answers: string[], leftOpen: string): string {
  const lines = questions.map((q, i) => `- ${q.question} → ${answers[i]?.trim() || leftOpen}`);
  return `${intro}\n${lines.join('\n')}`;
}

export interface MarkdownLabels {
  approach: string;
  steps: string;
  files: string;
  verify: string;
  risks: string;
  questions: string;
  recommended: string;
}

/** The plan as a Markdown document for docs/plans/. */
export function toMarkdown(doc: PlanDoc, l: MarkdownLabels): string {
  const out: string[] = [`# ${doc.goal.trim() || 'Plan'}`, ''];
  if (doc.approach.trim()) out.push(`## ${l.approach}`, '', doc.approach.trim(), '');
  out.push(`## ${l.steps}`, '');
  doc.steps.forEach((s, i) => {
    out.push(`${i + 1}. **${s.title.trim()}** (${s.id})`);
    if (s.description.trim()) out.push(...s.description.trim().split('\n').map((line) => `   ${line}`));
    if (s.files.length) out.push(`   - ${l.files}: ${s.files.map((f) => `\`${f}\``).join(', ')}`);
    if (s.verify.trim()) out.push(`   - ${l.verify}: ${s.verify.trim()}`);
  });
  out.push('');
  if (doc.risks.length) out.push(`## ${l.risks}`, '', ...doc.risks.map((r) => `- ${r}`), '');
  if (doc.questions.length) {
    out.push(`## ${l.questions}`, '');
    for (const q of doc.questions) {
      out.push(`- ${q.question}`);
      for (const o of q.options) out.push(`  - ${o.label}${o.recommended ? ` ${l.recommended}` : ''}`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** "Rabattcodes für den Warenkorb" → "rabattcodes-fuer-den-warenkorb". */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'plan';
}

/** docs/plans/<date>-<slug>.md, with the local date. */
export function planFilePath(goal: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `docs/plans/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${slug(goal)}.md`;
}
