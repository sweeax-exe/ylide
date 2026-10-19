// Planning mode in the in-browser mock (see ./mock.ts): planning runs that
// read the demo project and write or change a plan, plan runs that carry a
// plan out step by step, the plan kept per project, and saving it as a file.
// Switching to Planen during a run stops it after the current task, like
// the core.

import type { AgentEvent } from '../bindings/AgentEvent';
import type { FileChange } from '../bindings/FileChange';
import type { LastRun } from '../bindings/LastRun';
import type { PlanDoc } from '../bindings/PlanDoc';
import type { PlanState } from '../bindings/PlanState';
import type { PlanStep } from '../bindings/PlanStep';
import type { Task } from '../bindings/Task';

export interface PlanningEnv {
  modelReady: boolean;
  files: Map<string, string>;
  changed(paths: string[]): void;
  /** The cart run of mock.ts stops after its current task. */
  setHandover(on: boolean): void;
  /** Keeps a finished plan run like the core keeps the last run. */
  record(run: LastRun): void;
  /** Records of earlier runs, for the task numbers a plan goes on from. */
  previous(runId: string): LastRun | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let state: PlanState = { mode: 'code', plan: null, continues: null, notes: [] };
/** The planning run or plan run going on. */
let current: { id: string; cancelled: boolean; paused: boolean; handover: boolean } | null = null;

/** Handles agent_control for planning and plan runs; false for other runs. */
export function planningControl(runId: string, action: string): boolean {
  if (!current || current.id !== runId) return false;
  if (action === 'cancel') current.cancelled = true;
  if (action === 'pause') current.paused = true;
  if (action === 'resume') current.paused = false;
  return true;
}

export async function planningCommand(command: string, args: Record<string, any>, env: PlanningEnv): Promise<unknown> {
  switch (command) {
    case 'plan_state':
      return structuredClone(state);
    case 'plan_state_save':
      state = structuredClone(args.planState as PlanState);
      return undefined;
    case 'plan_draft': {
      if (!env.modelReady) throw { code: 'no_model', message: 'start a model first' };
      const id = `run-${Date.now()}`;
      current = { id, cancelled: false, paused: false, handover: false };
      void draft(id, args, args.onEvent as (e: AgentEvent) => void, env);
      return id;
    }
    case 'plan_run': {
      if (!env.modelReady) throw { code: 'no_model', message: 'start a model first' };
      const plan = args.plan as PlanDoc;
      if (!plan.steps.length) throw { code: 'empty_plan', message: 'the plan has no steps' };
      const id = `run-${Date.now()}`;
      current = { id, cancelled: false, paused: false, handover: false };
      void carryOut(id, plan, args.continues ?? null, args.onEvent as (e: AgentEvent) => void, env);
      return id;
    }
    case 'agent_handover':
      if (current && current.id === args.runId) current.handover = !!args.on;
      else env.setHandover(!!args.on);
      return undefined;
    case 'plan_write_file': {
      const path = String(args.path);
      if (!/^docs\/plans\/[^/]+\.md$/.test(path)) throw { code: 'invalid_path', message: 'a plan is saved as docs/plans/<name>.md' };
      const before = env.files.get(path);
      env.files.set(path, String(args.content));
      env.changed([path]);
      const lines = String(args.content).split('\n');
      const change: FileChange = {
        path,
        kind: before === undefined ? 'created' : 'modified',
        diff: `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`,
        checkpointId: `plan-${Date.now()}`,
      };
      return change;
    }
    default:
      throw { code: 'generic', message: `mock: unknown command ${command}` };
  }
}

/** Waits `ms`, longer while paused; throws when the run was stopped. */
async function wait(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end || current?.paused) {
    if (!current || current.cancelled) throw new Error('cancelled');
    await sleep(60);
  }
}

const number = (id: string) => Number(/^T(\d+)$/.exec(id)?.[1] ?? 0);

/** Like the core's planning run: read, then the plan (or the changed plan). */
async function draft(runId: string, args: Record<string, any>, send: (e: AgentEvent) => void, env: PlanningEnv) {
  const de = String(args.language ?? 'en').startsWith('de');
  const status = (state: string, step: string, tps = 0) => send({ type: 'status', runId, status: { agentId: 'orchestrator', role: 'orchestrator', state: state as never, step, taskId: null, tokensPerSecond: tps, totalTokens: 300 } });
  let calls = 0;
  const tool = async (name: string, path: string, summary: string) => {
    const callId = `call-${++calls}`;
    status('callingTool', `${name} ${path}`.trim(), 54);
    send({ type: 'toolCall', runId, agentId: 'orchestrator', callId, tool: name, arguments: JSON.stringify({ path }) });
    await wait(450);
    send({ type: 'toolResult', runId, agentId: 'orchestrator', callId, ok: true, summary, change: null });
  };
  try {
    send({ type: 'runStarted', runId, goal: args.goal });
    status('thinking', 'thinking', 54);
    await wait(500);
    const plan = args.plan as PlanDoc | null;
    let doc: PlanDoc;
    if (!plan) {
      await tool('list_dir', '', '9 entries');
      await tool('read_file', 'src/cart.ts', 'src/cart.ts (1-14 of 14)');
      await tool('read_file', 'test/cart.test.ts', 'test/cart.test.ts (1-6 of 6)');
      status('thinking', 'thinking', 54);
      await wait(600);
      const previous = args.continues ? env.previous(String(args.continues)) : null;
      let next = Math.max(0, ...(previous?.plan?.tasks ?? []).map((t) => number(t.id)));
      const step = (title: string, description: string, files: string[], verify: string): PlanStep => ({ id: `T${++next}`, title, description, files, verify, assignee: 'coder' });
      doc = de
        ? {
            goal: args.goal,
            approach: 'Erst total() korrigieren, dann mit Tests absichern und zuletzt kurz dokumentieren. Preise bleiben ganze Cent.',
            steps: [
              step('total() korrigieren', 'In total() den Preis mit der Menge multiplizieren.', ['src/cart.ts'], 'npm test'),
              step('Test für leeren Warenkorb', 'Einen Test ergänzen, dass total([]) 0 ergibt.', ['test/cart.test.ts'], 'npm test'),
              step('total() dokumentieren', 'Einen kurzen Doc-Kommentar über total() schreiben.', ['src/cart.ts'], 'src/cart.ts lesen'),
            ],
            risks: ['Preise sind Cent-Beträge: Rundung muss ganzzahlig bleiben.'],
            questions: [{ question: 'Soll total() auch Rabattcodes berücksichtigen?', options: [{ label: 'Nein, nur Preis × Menge', recommended: true }, { label: 'Ja, mit Rabattcodes', recommended: false }], multiple: false }],
          }
        : {
            goal: args.goal,
            approach: 'Fix total() first, then cover it with tests and document it briefly. Prices stay in whole cents.',
            steps: [
              step('Fix total()', 'Multiply the price by the quantity in total().', ['src/cart.ts'], 'npm test'),
              step('Test for an empty cart', 'Add a test that total([]) is 0.', ['test/cart.test.ts'], 'npm test'),
              step('Document total()', 'Write a short doc comment above total().', ['src/cart.ts'], 'Read src/cart.ts'),
            ],
            risks: ['Prices are in cents: rounding must stay integer.'],
            questions: [{ question: 'Should total() also apply discount codes?', options: [{ label: 'No, only price × quantity', recommended: true }, { label: 'Yes, with discount codes', recommended: false }], multiple: false }],
          };
    } else {
      status('thinking', 'thinking', 54);
      await wait(900);
      doc = change(plan, String(args.wish ?? ''), de);
    }
    send({ type: 'planDrafted', runId, plan: doc });
    status('idle', 'plan ready');
    send({ type: 'runFinished', runId, outcome: 'completed', summary: 'The plan is written.', recap: null });
  } catch {
    status('idle', '');
    send({ type: 'runFinished', runId, outcome: 'cancelled', summary: 'Stopped.', recap: null });
  } finally {
    if (current?.id === runId) current = null;
  }
}

/** A plan changed as the user wished: answers close the open questions; "Schritt 2"/"step 2" changes that step; anything else adds a step. */
function change(plan: PlanDoc, wish: string, de: boolean): PlanDoc {
  if (wish.includes(' → ')) {
    return { ...plan, questions: [], approach: `${plan.approach} ${de ? 'Ohne Rabattcodes, wie gewünscht.' : 'Without discount codes, as you chose.'}`.trim() };
  }
  const m = /(?:schritt|step)\s*(\d+)/i.exec(wish);
  const index = m ? Number(m[1]) - 1 : -1;
  if (index >= 0 && index < plan.steps.length) {
    const steps = plan.steps.map((s, i) => (i === index ? { ...s, description: `${s.description} ${wish}`.trim(), verify: s.verify || 'npm test' } : s));
    return { ...plan, steps };
  }
  const next = Math.max(0, ...plan.steps.map((s) => number(s.id))) + 1;
  const title = wish.length > 60 ? `${wish.slice(0, 59)}…` : wish;
  return { ...plan, steps: [...plan.steps, { id: `T${next}`, title, description: wish, files: [], verify: '', assignee: 'coder' }] };
}

/** Like the core's plan run: the steps are the tasks; Planen stops it after the current one. */
async function carryOut(runId: string, plan: PlanDoc, continues: string | null, send: (e: AgentEvent) => void, env: PlanningEnv) {
  const previous = continues ? env.previous(continues) : null;
  const tasks: Task[] = plan.steps.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.verify ? `${s.description}\n\nHow to verify: ${s.verify}` : s.description,
    files: s.files,
    assignee: s.assignee,
    status: 'pending',
    attempts: 0,
    result: null,
    review: null,
  }));
  const record: LastRun = {
    runId,
    goal: plan.goal,
    startedAtUnixMs: Date.now(),
    finishedAtUnixMs: 0,
    outcome: 'cancelled',
    summary: '',
    recap: null,
    plan: { goal: plan.goal, summary: plan.approach, tasks },
    changes: [],
    earlierGoals: previous ? [...previous.earlierGoals, previous.goal].slice(-3) : [],
  };
  const status = (agentId: string, state: string, step: string, taskId: string | null, tps = 0) =>
    send({ type: 'status', runId, status: { agentId, role: agentId, state: state as never, step, taskId, tokensPerSecond: tps, totalTokens: 400 } });
  const updated = (task: Task) => {
    record.plan!.tasks = record.plan!.tasks.map((t) => (t.id === task.id ? task : t));
    send({ type: 'taskUpdated', runId, task });
  };
  const finish = (outcome: LastRun['outcome'], summary: string) => {
    Object.assign(record, { outcome, summary, finishedAtUnixMs: Date.now() });
    env.record(record);
    send({ type: 'runFinished', runId, outcome, summary, recap: null });
  };
  let calls = 0;
  try {
    send({ type: 'runStarted', runId, goal: plan.goal });
    send({ type: 'planReady', runId, plan: record.plan! });
    status('orchestrator', 'idle', 'plan ready', null);
    for (const [i, t] of tasks.entries()) {
      if (current?.handover) {
        finish('cancelled', 'Stopped for planning.');
        return;
      }
      send({ type: 'checkpointCreated', runId, checkpoint: { id: `${runId}-${i + 1}`, runId, seq: i + 1, label: `${t.id}: ${t.title} (coder)`, createdAtUnixMs: Date.now(), files: [] } });
      updated({ ...t, status: 'inProgress' });
      status('coder', 'thinking', 'thinking', t.id, 62);
      await wait(700);
      const path = t.files[0] ?? 'src/cart.ts';
      const callId = `call-${++calls}`;
      status('coder', 'callingTool', `edit_file ${path}`, t.id, 62);
      send({ type: 'toolCall', runId, agentId: 'coder', callId, tool: 'edit_file', arguments: JSON.stringify({ path }) });
      await wait(900);
      const before = env.files.get(path) ?? '';
      const note = `// ${t.id}: ${t.title}\n`;
      env.files.set(path, before.includes(note) ? before : `${note}${before}`);
      env.changed([path]);
      const change: FileChange = { path, kind: before ? 'modified' : 'created', checkpointId: `${runId}-${i + 1}`, diff: `--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,1 @@\n+${note}` };
      record.changes.push({ ...change, diff: '' });
      send({ type: 'toolResult', runId, agentId: 'coder', callId, ok: true, summary: `Edited ${path} (+1 -0)`, change });
      const result = `${t.title}: done.`;
      updated({ ...t, status: 'inReview', result });
      status('coder', 'done', 'finished', t.id);
      status('reviewer', 'thinking', 'reviewing diff', t.id, 58);
      await wait(800);
      updated({ ...t, status: 'done', result, review: { verdict: 'approve', summary: 'Good.', comments: [] } });
      status('reviewer', 'idle', '', t.id);
    }
    finish('completed', tasks.map((t) => `✔ ${t.id} ${t.title}`).join('\n'));
  } catch {
    finish('cancelled', 'Stopped by the user.');
  } finally {
    if (current?.id === runId) current = null;
  }
}
