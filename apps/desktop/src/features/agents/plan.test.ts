import { describe, expect, it } from 'vitest';
import type { PlanDoc } from '../../bindings/PlanDoc';
import type { PlanStep } from '../../bindings/PlanStep';
import type { Task } from '../../bindings/Task';
import { addStep, answersWish, changedParts, hasChanges, lastTaskNumber, moveStep, nextStepId, parseFiles, planFilePath, planFromRun, removeStep, slug, toMarkdown, updateStep } from './plan';
import { createRun } from './run';

const step = (id: string, title: string, extra: Partial<PlanStep> = {}): PlanStep => ({ id, title, description: `Do ${title}.`, files: [], verify: '', assignee: 'coder', ...extra });
const doc = (steps: PlanStep[]): PlanDoc => ({ goal: 'Rabatte', approach: 'Erst das Modell.', steps, risks: [], questions: [] });

describe('plan editing', () => {
  const plan = doc([step('T1', 'Modell'), step('T2', 'Berechnung'), step('T3', 'Tests')]);

  it('renames, removes and reorders steps without touching the others', () => {
    expect(updateStep(plan, 'T2', { title: 'Rabatt berechnen' }).steps.map((s) => s.title)).toEqual(['Modell', 'Rabatt berechnen', 'Tests']);
    expect(removeStep(plan, 'T1').steps.map((s) => s.id)).toEqual(['T2', 'T3']);
    expect(moveStep(plan, 'T3', -1).steps.map((s) => s.id)).toEqual(['T1', 'T3', 'T2']);
    expect(moveStep(plan, 'T1', 1).steps.map((s) => s.id)).toEqual(['T2', 'T1', 'T3']);
    expect(moveStep(plan, 'T1', -1), 'at the top it stays').toBe(plan);
    expect(moveStep(plan, 'T3', 1)).toBe(plan);
    expect(moveStep(plan, 'T9', 1)).toBe(plan);
    expect(plan.steps.map((s) => s.title), 'the original is left as it was').toEqual(['Modell', 'Berechnung', 'Tests']);
  });

  it('numbers new steps after every id, also after removed ones and the run it continues', () => {
    expect(nextStepId(plan)).toBe('T4');
    expect(nextStepId(removeStep(plan, 'T3'))).toBe('T3');
    expect(nextStepId(doc([]))).toBe('T1');
    expect(nextStepId(doc([step('T2', 'x')]), 5), 'a run that stopped at T5').toBe('T6');
    const added = addStep(plan, 'Doku');
    expect(added.id).toBe('T4');
    expect(added.doc.steps.at(-1)).toEqual({ id: 'T4', title: 'Doku', description: '', files: [], verify: '', assignee: 'coder' });
  });

  it('reads files from a comma list', () => {
    expect(parseFiles(' src/a.ts, src/b.ts ,, \nREADME.md')).toEqual(['src/a.ts', 'src/b.ts', 'README.md']);
  });
});

describe('what changed', () => {
  const before = doc([step('T1', 'Modell'), step('T2', 'Berechnung')]);

  it('finds new and changed steps and parts', () => {
    const after: PlanDoc = { ...before, approach: 'Anders.', steps: [step('T1', 'Modell'), step('T2', 'Berechnung', { verify: 'npm test' }), step('T3', 'Doku')], risks: ['Rundung'] };
    expect(changedParts(before, after)).toEqual({ steps: ['T2', 'T3'], approach: true, risks: true, questions: false });
    expect(hasChanges(changedParts(before, before))).toBe(false);
    expect(changedParts(null, before), 'a new plan is new everywhere').toEqual({ steps: ['T1', 'T2'], approach: true, risks: false, questions: false });
  });
});

describe('a stopped run as a plan', () => {
  const task = (id: string, status: Task['status'], description = ''): Task => ({ id, title: `Task ${id}`, description, files: ['src/cart.ts'], assignee: 'coder', status, attempts: 0, result: null, review: null });

  it('keeps the open tasks with their ids and splits off how to verify', () => {
    const run = {
      ...createRun('Rabatte', 1),
      plan: { goal: 'Rabatte', summary: 'Modell, dann Berechnung.', tasks: [] },
      tasks: {
        T1: task('T1', 'done'),
        T2: task('T2', 'inProgress', 'Berechnung bauen.\n\nHow to verify: npm test'),
        T3: task('T3', 'pending', 'Tests.\n\nEarlier attempt: failed (boom).'),
      },
      taskOrder: ['T1', 'T2', 'T3'],
    };
    const plan = planFromRun(run)!;
    expect(plan.goal).toBe('Rabatte');
    expect(plan.approach).toBe('Modell, dann Berechnung.');
    expect(plan.steps.map((s) => [s.id, s.description, s.verify])).toEqual([
      ['T2', 'Berechnung bauen.', 'npm test'],
      ['T3', 'Tests.', ''],
    ]);
    expect(lastTaskNumber(run)).toBe(3);
    expect(planFromRun({ ...run, tasks: { T1: task('T1', 'done') }, taskOrder: ['T1'] }), 'nothing open: no plan').toBeNull();
    expect(lastTaskNumber(null)).toBe(0);
  });
});

describe('answers and files', () => {
  it('puts each answer with its question', () => {
    const qs = [
      { question: 'Welcher Runner?', options: [], multiple: false },
      { question: 'Doku?', options: [], multiple: false },
    ];
    expect(answersWish('Antworten auf die offenen Fragen:', qs, ['Vitest', ' '], 'entscheide selbst')).toBe('Antworten auf die offenen Fragen:\n- Welcher Runner? → Vitest\n- Doku? → entscheide selbst');
  });

  it('writes the plan as Markdown', () => {
    const plan: PlanDoc = {
      goal: 'Rabatte',
      approach: 'Erst das Modell.',
      steps: [step('T1', 'Modell', { description: 'Typ anlegen.\nMit Tests.', files: ['src/cart.ts'], verify: 'npm test' }), step('T2', 'Doku', { description: '' })],
      risks: ['Rundung'],
      questions: [{ question: 'Prozent oder Betrag?', options: [{ label: 'Prozent', recommended: true }, { label: 'Betrag', recommended: false }], multiple: false }],
    };
    const md = toMarkdown(plan, { approach: 'Vorgehen', steps: 'Schritte', files: 'Dateien', verify: 'Prüfen', risks: 'Risiken', questions: 'Offene Fragen', recommended: '(empfohlen)' });
    expect(md).toBe(
      '# Rabatte\n\n## Vorgehen\n\nErst das Modell.\n\n## Schritte\n\n1. **Modell** (T1)\n   Typ anlegen.\n   Mit Tests.\n   - Dateien: `src/cart.ts`\n   - Prüfen: npm test\n2. **Doku** (T2)\n\n## Risiken\n\n- Rundung\n\n## Offene Fragen\n\n- Prozent oder Betrag?\n  - Prozent (empfohlen)\n  - Betrag\n',
    );
  });

  it('names the file by date and goal', () => {
    expect(slug('Rabattcodes für den Warenkorb!')).toBe('rabattcodes-fuer-den-warenkorb');
    expect(slug('Ça marche – très bien')).toBe('ca-marche-tres-bien');
    expect(slug('购物车')).toBe('plan');
    expect(slug('x'.repeat(80))).toHaveLength(48);
    expect(planFilePath('Rabatte im Warenkorb', new Date(2026, 9, 7))).toBe('docs/plans/2026-10-07-rabatte-im-warenkorb.md');
  });
});
