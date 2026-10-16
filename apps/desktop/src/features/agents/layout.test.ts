import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../bindings/AgentEvent';
import type { AgentState } from '../../bindings/AgentState';
import type { Task } from '../../bindings/Task';
import type { TaskStatus } from '../../bindings/TaskStatus';
import { laneOrder, layoutWorldLines, warpGap, type Lane } from './layout';
import { applyEvent, createRun, type RunData } from './run';

const R = 'run-1';
const status = (agentId: string, state: AgentState, taskId: string | null = null): AgentEvent => ({
  type: 'status',
  runId: R,
  status: { agentId, role: agentId, state, step: '', taskId, tokensPerSecond: 0, totalTokens: 0 },
});
const task = (id: string, s: TaskStatus, extra: Partial<Task> = {}): AgentEvent => ({
  type: 'taskUpdated',
  runId: R,
  task: { id, title: id, description: '', files: [], assignee: 'coder', status: s, attempts: 0, result: null, review: null, ...extra },
});

/** Feeds events at the given times (ms after start). */
function build(steps: Array<[number, AgentEvent]>): RunData {
  return steps.reduce((run, [at, e]) => applyEvent(run, e, 10_000 + at), createRun('goal', 10_000));
}

const LANES: Lane[] = ['orchestrator', 'coder', 'reviewer'].map((agentId) => ({ agentId, role: agentId }));

/** The mock's sequence: plan, T1 with review, T2 with a requested change. */
function sampleRun() {
  return build([
    [0, status('orchestrator', 'thinking')],
    [2000, status('orchestrator', 'idle')],
    [2000, task('T1', 'inProgress')],
    [2000, status('coder', 'thinking', 'T1')],
    [6000, task('T1', 'inReview')],
    [6000, status('coder', 'done', 'T1')],
    [6000, status('reviewer', 'thinking', 'T1')],
    [8000, status('reviewer', 'idle', 'T1')],
    [8000, task('T1', 'inProgress', { attempts: 1 })],
    [8000, status('coder', 'thinking', 'T1')],
    [10000, status('coder', 'done', 'T1')],
    [10000, task('T1', 'inReview', { attempts: 1 })],
    [10000, status('reviewer', 'thinking', 'T1')],
    [12000, status('reviewer', 'idle', 'T1')],
    [12000, task('T1', 'done', { attempts: 1 })],
  ]);
}

describe('warpGap', () => {
  it('is linear for short gaps and grows slowly for long ones', () => {
    expect(warpGap(5000)).toBeCloseTo(5);
    expect(warpGap(10_000)).toBeCloseTo(10);
    expect(warpGap(600_000)).toBeLessThan(60);
    expect(warpGap(600_000)).toBeGreaterThan(warpGap(60_000));
    expect(warpGap(-5)).toBe(0);
  });
});

describe('laneOrder', () => {
  it('puts custom roles between the coder and the reviewer', () => {
    const run = build([
      [0, status('tester', 'thinking')],
      [10, status('reviewer', 'idle')],
    ]);
    expect(laneOrder(run, false).map((l) => l.agentId)).toEqual(['orchestrator', 'coder', 'tester', 'reviewer']);
    expect(laneOrder(createRun('g', 0), false).map((l) => l.agentId)).toEqual(['orchestrator', 'coder']);
    expect(laneOrder(createRun('g', 0), true).map((l) => l.agentId)).toEqual(['orchestrator', 'coder', 'reviewer']);
  });
});

describe('layoutWorldLines', () => {
  const run = sampleRun();
  const layout = layoutWorldLines({ timeline: run.timeline, lanes: LANES, startedAt: run.startedAt, endAt: 10_000 + 12_000, running: false, width: 400 });

  it('finds every hand-off in order', () => {
    expect(layout.handoffs.map((h) => `${h.kind}:${h.from}>${h.to}`)).toEqual([
      'dispatch:orchestrator>coder',
      'review:coder>reviewer',
      'changes:reviewer>coder',
      'review:coder>reviewer',
    ]);
  });

  it('gives each hand-off its own slot, left to right, within the width', () => {
    for (let i = 0; i < layout.handoffs.length; i++) {
      const h = layout.handoffs[i];
      expect(h.x1).toBeGreaterThan(h.x0);
      if (i > 0) expect(h.x0).toBeGreaterThanOrEqual(layout.handoffs[i - 1].x1);
    }
    expect(layout.xEnd).toBeLessThanOrEqual(400);
  });

  it('ends an active line where its crossing starts and starts the receiver where it ends', () => {
    const [, review] = layout.handoffs;
    const coderActive = layout.segments.filter((s) => s.agentId === 'coder' && s.kind === 'active');
    const reviewerActive = layout.segments.filter((s) => s.agentId === 'reviewer' && s.kind === 'active');
    expect(coderActive[0].x1).toBeCloseTo(review.x0);
    expect(reviewerActive[0].x0).toBeCloseTo(review.x1);
  });

  it('labels tasks and shows no head once the run is over', () => {
    expect(layout.tasks).toHaveLength(1);
    expect(layout.tasks[0]).toMatchObject({ taskId: 'T1', status: 'done' });
    expect(layout.heads).toEqual([]);
  });

  it('skips a review hand-off when the reviewer never works on the task', () => {
    const quick = build([
      [0, task('T1', 'inProgress')],
      [0, status('coder', 'thinking', 'T1')],
      [1000, status('coder', 'done', 'T1')],
      [1000, task('T1', 'inReview')],
      [1000, task('T1', 'done')],
    ]);
    const l = layoutWorldLines({ timeline: quick.timeline, lanes: LANES, startedAt: quick.startedAt, endAt: 11_000, running: false, width: 300 });
    expect(l.handoffs.map((h) => h.kind)).toEqual(['dispatch']);
  });

  it('shows a pulsing head only for an agent that is generating', () => {
    const live = build([
      [0, task('T1', 'inProgress')],
      [0, status('coder', 'thinking', 'T1')],
    ]);
    const l = layoutWorldLines({ timeline: live.timeline, lanes: LANES, startedAt: live.startedAt, endAt: 13_000, running: true, width: 300 });
    expect(l.heads).toEqual([{ agentId: 'coder', x: l.xEnd, generating: true, waiting: false }]);
    // While running, a short run does not stretch across the whole width yet.
    expect(l.xEnd).toBeLessThan(200);
  });

  it('keeps task labels apart when spans are narrow', () => {
    const steps: Array<[number, AgentEvent]> = [];
    for (let i = 1; i <= 12; i++) {
      steps.push([i * 10, task(`T${i}`, 'inProgress')], [i * 10, status('coder', 'thinking', `T${i}`)], [i * 10 + 5, task(`T${i}`, 'done')]);
    }
    const many = build(steps);
    const l = layoutWorldLines({ timeline: many.timeline, lanes: LANES, startedAt: many.startedAt, endAt: 10_200, running: false, width: 300 });
    expect(l.tasks).toHaveLength(12);
    for (let i = 1; i < l.tasks.length; i++) expect(l.tasks[i].labelX).toBeGreaterThan(l.tasks[i - 1].labelX + 6);
  });
});
