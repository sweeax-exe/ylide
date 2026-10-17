import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../bindings/AgentEvent';
import type { AgentState } from '../../bindings/AgentState';
import type { LastRun } from '../../bindings/LastRun';
import type { Task } from '../../bindings/Task';
import { appendStream, applyDecision, applyEvent, changedFiles, continuationOf, continueBlock, createRun, currentTask, isGenerating, notesUpdated, openTaskCount, removeQuestion, reportLines, restoreRun, STREAM_TAIL, tasksOf, type RunData, type ToolFeedItem } from './run';

const R = 'run-1';
const status = (agentId: string, state: AgentState, step = '', taskId: string | null = null, tps = 0, total = 0): AgentEvent => ({
  type: 'status',
  runId: R,
  status: { agentId, role: agentId, state, step, taskId, tokensPerSecond: tps, totalTokens: total },
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, description: '', files: [], assignee: 'coder', status: 'pending', attempts: 0, result: null, review: null, ...extra });

function feed(events: AgentEvent[], start = createRun('goal', 1000)): RunData {
  return events.reduce((run, e, i) => applyEvent(run, e, 1000 + i * 100), start);
}

describe('applyEvent', () => {
  it('adopts the run id of the first event and ignores other runs', () => {
    const run = feed([{ type: 'runStarted', runId: R, goal: 'Fix it' }]);
    expect(run.runId).toBe(R);
    expect(run.goal).toBe('Fix it');
    const other = applyEvent(run, { type: 'runStarted', runId: 'run-2', goal: 'x' }, 2000);
    expect(other).toBe(run);
  });

  it('tracks agent status, keeps the highest token count and the last speed', () => {
    const run = feed([status('coder', 'thinking', 'thinking', 'T1', 61, 400), status('coder', 'idle', '', 'T1', 0, 0)]);
    const coder = run.agents.coder;
    expect(coder.state).toBe('idle');
    expect(coder.totalTokens).toBe(400);
    expect(coder.lastTokensPerSecond).toBe(61);
    expect(coder.since).toBe(1100);
    expect(run.agentOrder).toEqual(['coder']);
  });

  it('leaves the run untouched by streamed deltas', () => {
    const run = feed([status('coder', 'thinking')]);
    const next = applyEvent(run, { type: 'delta', runId: R, agentId: 'coder', delta: { kind: 'content', text: 'Hello ' } }, 1200);
    expect(next).toBe(run);
    expect(next.timeline).toHaveLength(1);
  });

  it('keeps only the tail of streamed text', () => {
    expect(appendStream('Hello ', 'world')).toBe('Hello world');
    const long = appendStream('x'.repeat(STREAM_TAIL), 'end');
    expect(long).toHaveLength(STREAM_TAIL);
    expect(long.endsWith('end')).toBe(true);
  });

  it('pairs a tool result with the agent’s open call, even with different ids', () => {
    const run = feed([
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'c1', tool: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'toolResult', runId: R, agentId: 'coder', callId: 'r9', ok: true, summary: 'a.ts (1-3 of 3)', change: null },
    ]);
    expect(run.feed).toHaveLength(1);
    const item = run.feed[0] as ToolFeedItem;
    expect(item.tool).toBe('read_file');
    expect(item.result?.summary).toBe('a.ts (1-3 of 3)');
  });

  it('pairs results by call id first, and keeps a rejection from the dialog', () => {
    const run = feed([
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'call-1', tool: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'call-2', tool: 'read_file', arguments: '{"path":"b.ts"}' },
      { type: 'toolResult', runId: R, agentId: 'coder', callId: 'call-1', ok: true, summary: 'a.ts', change: null },
      { type: 'toolResult', runId: R, agentId: 'coder', callId: 'call-2', ok: true, summary: 'b.ts', change: null },
    ]);
    expect(run.feed.map((f) => (f as ToolFeedItem).result?.summary)).toEqual(['a.ts', 'b.ts']);

    const request = { id: 'a1', agentId: 'coder', tool: 'run_command', risk: 'execute' as const, title: 'run `rm x`', detail: 'rm x' };
    let rejected = feed([
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'call-3', tool: 'run_command', arguments: '{"command":"rm x"}' },
      { type: 'approvalRequested', runId: R, request },
    ]);
    rejected = applyDecision(rejected, request, { decision: 'reject', reason: 'not now' }, 2000);
    rejected = applyEvent(rejected, { type: 'toolResult', runId: R, agentId: 'coder', callId: 'call-3', ok: false, summary: 'The user rejected this action: not now', change: null }, 2100);
    expect((rejected.feed[0] as ToolFeedItem).result).toMatchObject({ rejected: true, summary: 'not now' });
  });

  it('shows a result without a call on its own, and never pairs with turn-ending tools', () => {
    const run = feed([
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'c1', tool: 'finish', arguments: '{"summary":"done"}' },
      { type: 'toolResult', runId: R, agentId: 'coder', callId: 'r1', ok: false, summary: 'exit 1', change: null },
    ]);
    expect(run.feed).toHaveLength(2);
    expect((run.feed[0] as ToolFeedItem).result).toBeNull();
    expect((run.feed[1] as ToolFeedItem).tool).toBeNull();
  });

  it('collects file changes, plan, tasks, checkpoints and pending requests', () => {
    const change = { path: 'src/a.ts', kind: 'modified' as const, diff: '', checkpointId: 'cp1' };
    const run = feed([
      { type: 'planReady', runId: R, plan: { goal: 'g', summary: 'Do it', tasks: [task('T1'), task('T2')] } },
      { type: 'taskUpdated', runId: R, task: task('T1', { status: 'inProgress' }) },
      { type: 'checkpointCreated', runId: R, checkpoint: { id: 'cp2', runId: R, seq: 2, label: 'T2', createdAtUnixMs: 5, files: [] } },
      { type: 'checkpointCreated', runId: R, checkpoint: { id: 'cp1', runId: R, seq: 1, label: 'T1', createdAtUnixMs: 4, files: [] } },
      { type: 'toolResult', runId: R, agentId: 'coder', callId: 'r', ok: true, summary: 'Edited', change },
      { type: 'approvalRequested', runId: R, request: { id: 'a1', agentId: 'coder', tool: 'run_command', risk: 'execute', title: 'run `npm test`', detail: 'npm test' } },
      { type: 'approvalRequested', runId: R, request: { id: 'a1', agentId: 'coder', tool: 'run_command', risk: 'execute', title: 'run `npm test`', detail: 'npm test' } },
      { type: 'questionForUser', runId: R, questionId: 'q1', agentId: 'coder', question: 'Tabs or spaces?' },
    ]);
    expect(run.taskOrder).toEqual(['T1', 'T2']);
    expect(run.tasks.T1.status).toBe('inProgress');
    expect(currentTask(run)?.id).toBe('T1');
    expect(run.checkpoints.map((c) => c.id)).toEqual(['cp1', 'cp2']);
    expect(run.changes).toEqual([change]);
    expect(run.approvals).toHaveLength(1);
    expect(run.questions.map((q) => q.id)).toEqual(['q1']);
    expect(removeQuestion(run, 'q1').questions).toEqual([]);
    expect(run.feed[0]).toMatchObject({ kind: 'plan', taskCount: 2, summary: 'Do it' });
  });

  it('finishes the run, clears open requests and ignores later events', () => {
    let run = feed([
      status('coder', 'thinking'),
      { type: 'approvalRequested', runId: R, request: { id: 'a1', agentId: 'coder', tool: 'run_command', risk: 'execute', title: 't', detail: 'd' } },
    ]);
    expect(isGenerating(run)).toBe(true);
    run = applyEvent(run, { type: 'runFinished', runId: R, outcome: 'cancelled', summary: 'Stopped.', recap: null }, 9000);
    expect(run.outcome).toBe('cancelled');
    expect(run.finishedAt).toBe(9000);
    expect(run.approvals).toEqual([]);
    expect(isGenerating(run)).toBe(false);
    expect(applyEvent(run, status('coder', 'idle'), 9100)).toBe(run);
  });
});

describe('applyDecision', () => {
  const request = { id: 'a1', agentId: 'coder', tool: 'run_command', risk: 'execute' as const, title: 'run `npm test`', detail: 'npm test' };
  const base = () =>
    feed([
      { type: 'toolCall', runId: R, agentId: 'coder', callId: 'c1', tool: 'run_command', arguments: '{"command":"npm test"}' },
      { type: 'approvalRequested', runId: R, request },
    ]);

  it('removes the request and records the decision', () => {
    const run = applyDecision(base(), request, { decision: 'approve' }, 5000);
    expect(run.approvals).toEqual([]);
    expect(run.feed[run.feed.length - 1]).toMatchObject({ kind: 'decision', decision: 'approve', tool: 'run_command' });
    expect((run.feed[0] as ToolFeedItem).result).toBeNull();
  });

  it('marks the open call as rejected, with the reason', () => {
    const run = applyDecision(base(), request, { decision: 'reject', reason: '  use npm run test:unit ' }, 5000);
    const call = run.feed[0] as ToolFeedItem;
    expect(call.result).toMatchObject({ ok: false, rejected: true, summary: 'use npm run test:unit' });
    expect(run.feed[1]).toMatchObject({ kind: 'decision', reason: 'use npm run test:unit' });
  });
});

describe('changedFiles', () => {
  const c = (path: string, kind: 'created' | 'modified' | 'deleted') => ({ path, kind, diff: '', checkpointId: '' });
  it('reports the net effect per file', () => {
    expect(changedFiles([c('a', 'modified'), c('a', 'modified'), c('b', 'created'), c('b', 'modified'), c('t', 'created'), c('t', 'deleted'), c('d', 'modified'), c('d', 'deleted')])).toEqual([
      { path: 'a', kind: 'modified' },
      { path: 'b', kind: 'created' },
      { path: 'd', kind: 'deleted' },
    ]);
  });
});

describe('continuing a run', () => {
  const finished = () =>
    feed([
      { type: 'runStarted', runId: R, goal: 'Add a cart' },
      { type: 'runFinished', runId: R, outcome: 'completed', summary: '✔ T1 Cart model', recap: 'Das Modell steht.' },
    ], createRun('Add a cart', 1000, { project: 'D:/shop' }));

  it('keeps goal, outcome and summary of a finished run', () => {
    expect(continuationOf(finished())).toEqual({ runId: R, goal: 'Add a cart', outcome: 'completed', summary: '✔ T1 Cart model', recap: 'Das Modell steht.', tasks: [] });
  });

  it('has nothing to continue while the run is going or before the core named it', () => {
    expect(continuationOf(feed([{ type: 'runStarted', runId: R, goal: 'x' }]))).toBeNull();
    expect(continuationOf({ ...finished(), runId: null })).toBeNull();
  });

  it('remembers project and previous run in a new run', () => {
    const from = continuationOf(finished())!;
    const next = createRun('Now add tests', 5000, { project: 'D:/shop', continues: from });
    expect(next.continues).toBe(from);
    expect(next.project).toBe('D:/shop');
    expect(createRun('fresh', 1).continues).toBeNull();
  });

  it('only continues in the same project with a running model', () => {
    const run = finished();
    expect(continueBlock(run, true, 'D:/shop')).toBeNull();
    expect(continueBlock(run, true, 'D:/other')).toBe('otherProject');
    expect(continueBlock(run, false, 'D:/other')).toBe('otherProject');
    expect(continueBlock(run, true, null)).toBe('noProject');
    expect(continueBlock(run, false, 'D:/shop')).toBe('noModel');
    expect(continueBlock({ ...run, project: null }, true, 'D:/any')).toBeNull();
  });
});

describe('a run kept across restarts', () => {
  const last: LastRun = {
    runId: 'run-7',
    goal: 'Add a cart',
    startedAtUnixMs: 1000,
    finishedAtUnixMs: 9000,
    outcome: 'cancelled',
    summary: '✔ T1 Task T1\n– T2 Task T2',
    plan: { goal: 'Add a cart', summary: 'Model, then view.', tasks: [task('T1', { status: 'done' }), task('T2', { status: 'skipped' }), task('T3')] },
    changes: [{ path: 'src/cart.ts', kind: 'created', diff: '', checkpointId: 'run-7-1' }],
    earlierGoals: [],
    recap: null,
  };

  it('comes back with goal, tasks, result and changed files, marked as stored', () => {
    const run = restoreRun(last, 'D:/shop');
    expect(run).toMatchObject({ runId: 'run-7', goal: 'Add a cart', startedAt: 1000, finishedAt: 9000, outcome: 'cancelled', summary: last.summary, project: 'D:/shop', stored: true });
    expect(run.taskOrder).toEqual(['T1', 'T2', 'T3']);
    expect(run.tasks.T2.status).toBe('skipped');
    expect(changedFiles(run.changes)).toEqual([{ path: 'src/cart.ts', kind: 'created' }]);
    expect(run.feed).toEqual([]);
    expect(createRun('fresh', 1).stored).toBe(false);
  });

  it('can be continued, and counts the tasks it left open', () => {
    const run = restoreRun(last, 'D:/shop');
    expect(continuationOf(run)?.runId).toBe('run-7');
    expect(openTaskCount(run)).toBe(2);
    expect(openTaskCount(restoreRun({ ...last, plan: null }, 'D:/shop'))).toBe(0);
  });
});

describe('project notes', () => {
  const change = (path: string, kind: 'created' | 'modified' | 'deleted') => ({ path, kind, diff: '', checkpointId: 'c' });
  it('notices when the run wrote AGENTS.md', () => {
    const run = createRun('x', 1);
    expect(notesUpdated(run)).toBe(false);
    expect(notesUpdated({ ...run, changes: [change('src/a.ts', 'modified')] })).toBe(false);
    expect(notesUpdated({ ...run, changes: [change('src/a.ts', 'modified'), change('AGENTS.md', 'created')] })).toBe(true);
    expect(notesUpdated({ ...run, changes: [change('agents.md', 'modified')] })).toBe(true);
    expect(notesUpdated({ ...run, changes: [change('AGENTS.md', 'modified'), change('AGENTS.md', 'deleted')] })).toBe(false);
    expect(notesUpdated({ ...run, changes: [change('docs/AGENTS.md', 'modified')] })).toBe(false);
  });
});

describe('the summary a run ends with', () => {
  it('comes with the end of the run and goes along when it is continued or restored', () => {
    const run = feed([
      { type: 'planReady', runId: R, plan: { goal: 'g', summary: 's', tasks: [task('T1')] } },
      { type: 'taskUpdated', runId: R, task: task('T1', { status: 'done', result: 'Done.' }) },
      { type: 'runFinished', runId: R, outcome: 'completed', summary: '✔ T1 Task T1', recap: '- `total()` rechnet jetzt richtig.' },
    ]);
    expect(run.recap).toBe('- `total()` rechnet jetzt richtig.');
    const from = continuationOf(run)!;
    expect(from.recap).toBe(run.recap);
    expect(from.tasks.map((t) => t.status)).toEqual(['done']);
    const stopped = feed([{ type: 'runFinished', runId: R, outcome: 'cancelled', summary: 'x', recap: null }]);
    expect(stopped.recap).toBeNull();
  });

  it('falls back to a task list with the first line of each result', () => {
    const lines = reportLines([
      task('T1', { status: 'done', result: 'Fixed total().\nMore detail.' }),
      task('T2', { status: 'done', result: 'Added a test.', review: { verdict: 'request_changes', summary: 'Edge case.', comments: [] } }),
      task('T3', { status: 'failed', result: `Stopped: ${'x'.repeat(300)}` }),
      task('T4'),
    ]);
    expect(lines.map((l) => [l.id, l.status, l.openComments])).toEqual([
      ['T1', 'done', false],
      ['T2', 'done', true],
      ['T3', 'failed', false],
      ['T4', 'pending', false],
    ]);
    expect(lines[0].result).toBe('Fixed total().');
    expect(lines[2].result).toHaveLength(201);
    expect(lines[3].result).toBeNull();
    expect(tasksOf({ tasks: { T2: task('T2'), T1: task('T1') }, taskOrder: ['T1', 'T2', 'T9'] }).map((t) => t.id)).toEqual(['T1', 'T2']);
  });
});
