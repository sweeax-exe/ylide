// Pure state of one agent run, reduced from the AgentEvent stream. No React,
// no IPC: the zustand store (store.ts) feeds events in and the views read the
// result. Kept free of side effects so it can be unit tested.

import type { AgentEvent } from '../../bindings/AgentEvent';
import type { AgentMessage } from '../../bindings/AgentMessage';
import type { AgentState } from '../../bindings/AgentState';
import type { ApprovalRequest } from '../../bindings/ApprovalRequest';
import type { ApprovalResponse } from '../../bindings/ApprovalResponse';
import type { ChangeKind } from '../../bindings/ChangeKind';
import type { Checkpoint } from '../../bindings/Checkpoint';
import type { FileChange } from '../../bindings/FileChange';
import type { LastRun } from '../../bindings/LastRun';
import type { RunOutcome } from '../../bindings/RunOutcome';
import type { Task } from '../../bindings/Task';
import type { TaskPlan } from '../../bindings/TaskPlan';

/** Every event except streamed deltas, in arrival order. */
export interface TimelineEntry {
  seq: number;
  /** Arrival time (ms since epoch). */
  at: number;
  event: AgentEvent;
}

export interface AgentInfo {
  agentId: string;
  role: string;
  state: AgentState;
  step: string;
  taskId: string | null;
  tokensPerSecond: number;
  /** Last non-zero speed, so an idle agent still shows how fast it was. */
  lastTokensPerSecond: number;
  totalTokens: number;
  /** When the current state began. */
  since: number;
}

export interface ToolResultInfo {
  ok: boolean;
  summary: string;
  change: FileChange | null;
  /** The user rejected the call in the approval dialog. */
  rejected: boolean;
}

export interface ToolFeedItem {
  kind: 'tool';
  id: string;
  seq: number;
  at: number;
  agentId: string;
  /** The core's call id; results carry the same id. Null for a result without a call. */
  callId: string | null;
  /** Null when a result arrived without a matching call. */
  tool: string | null;
  arguments: string | null;
  /** False for tools that end a turn and never report a result (finish, submit_plan, ...). */
  expectsResult: boolean;
  result: ToolResultInfo | null;
}

export interface MessageFeedItem {
  kind: 'message';
  id: string;
  seq: number;
  at: number;
  message: AgentMessage;
}

export interface PlanFeedItem {
  kind: 'plan';
  id: string;
  seq: number;
  at: number;
  summary: string;
  taskCount: number;
}

export interface DecisionFeedItem {
  kind: 'decision';
  id: string;
  seq: number;
  at: number;
  agentId: string;
  tool: string;
  title: string;
  decision: ApprovalResponse['decision'];
  reason: string | null;
}

export type FeedItem = ToolFeedItem | MessageFeedItem | PlanFeedItem | DecisionFeedItem;

export interface UserQuestion {
  id: string;
  agentId: string;
  question: string;
  at: number;
}

/** The finished run a run continues, as its header shows it. */
export interface ContinuedRun {
  runId: string;
  goal: string;
  outcome: RunOutcome;
  summary: string | null;
  recap: string | null;
  tasks: Task[];
}

export interface RunData {
  /** Null until the core reports it (events can arrive before `start` resolves). */
  runId: string | null;
  goal: string;
  /** Images that went with the goal (data URLs); not kept across restarts. */
  images: string[];
  /** Root of the project the run works in; a run is only continued there. */
  project: string | null;
  /** The finished run this one continues; its agents were told about it. */
  continues: ContinuedRun | null;
  /** Read back from the project's stored record (after a restart): no activity log. */
  stored: boolean;
  startedAt: number;
  finishedAt: number | null;
  nextSeq: number;
  timeline: TimelineEntry[];
  plan: TaskPlan | null;
  tasks: Record<string, Task>;
  taskOrder: string[];
  agents: Record<string, AgentInfo>;
  agentOrder: string[];
  feed: FeedItem[];
  changes: FileChange[];
  checkpoints: Checkpoint[];
  /** Pending approvals, oldest first. */
  approvals: ApprovalRequest[];
  /** Pending questions for the user, oldest first. */
  questions: UserQuestion[];
  outcome: RunOutcome | null;
  /** The plain task list from the core (English; the UI shows its own, translated). */
  summary: string | null;
  /** The orchestrator's summary in the user's language; null when it wrote none. */
  recap: string | null;
}

/** Tools that end an agent's turn; the core never sends a result for them. */
const TURN_ENDING_TOOLS = new Set(['finish', 'submit_plan', 'submit_review', 'ask']);

/** Characters of streamed text kept per agent. */
export const STREAM_TAIL = 240;

export const ACTIVE_STATES: ReadonlySet<AgentState> = new Set(['thinking', 'callingTool']);
export const WAITING_STATES: ReadonlySet<AgentState> = new Set(['waitingForApproval', 'waitingForAnswer']);

export function createRun(goal: string, startedAt: number, from: { project?: string | null; continues?: ContinuedRun | null; images?: string[] } = {}): RunData {
  return {
    runId: null,
    goal,
    images: from.images ?? [],
    project: from.project ?? null,
    continues: from.continues ?? null,
    stored: false,
    startedAt,
    finishedAt: null,
    nextSeq: 1,
    timeline: [],
    plan: null,
    tasks: {},
    taskOrder: [],
    agents: {},
    agentOrder: [],
    feed: [],
    changes: [],
    checkpoints: [],
    approvals: [],
    questions: [],
    outcome: null,
    summary: null,
    recap: null,
  };
}

function withTimeline(run: RunData, event: AgentEvent, at: number): RunData {
  const seq = run.nextSeq;
  return { ...run, nextSeq: seq + 1, timeline: [...run.timeline, { seq, at, event }] };
}

/** Applies one core event. Returns `run` unchanged when the event belongs to another run. */
export function applyEvent(run: RunData, event: AgentEvent, at: number): RunData {
  if (run.runId !== null && event.runId !== run.runId) return run;
  if (run.outcome !== null) return run;
  const base: RunData = run.runId === null ? { ...run, runId: event.runId } : run;

  // Streamed text is kept apart (see store.ts), so tokens never touch the run.
  if (event.type === 'delta') return base;

  const next = withTimeline(base, event, at);
  const seq = next.nextSeq - 1;

  switch (event.type) {
    case 'runStarted':
      return { ...next, goal: event.goal || next.goal };

    case 'status': {
      const st = event.status;
      const prev = next.agents[st.agentId];
      const changed = !prev || prev.state !== st.state;
      const info: AgentInfo = {
        agentId: st.agentId,
        role: st.role,
        state: st.state,
        step: st.step,
        taskId: st.taskId,
        tokensPerSecond: st.tokensPerSecond,
        lastTokensPerSecond: st.tokensPerSecond > 0 ? st.tokensPerSecond : (prev?.lastTokensPerSecond ?? 0),
        totalTokens: Math.max(prev?.totalTokens ?? 0, st.totalTokens),
        since: changed ? at : prev.since,
      };
      return {
        ...next,
        agents: { ...next.agents, [st.agentId]: info },
        agentOrder: prev ? next.agentOrder : [...next.agentOrder, st.agentId],
      };
    }

    case 'planReady': {
      const tasks = { ...next.tasks };
      const order = [...next.taskOrder];
      for (const task of event.plan.tasks) {
        if (!tasks[task.id]) order.push(task.id);
        tasks[task.id] = task;
      }
      const item: PlanFeedItem = { kind: 'plan', id: `plan-${seq}`, seq, at, summary: event.plan.summary, taskCount: event.plan.tasks.length };
      return { ...next, plan: event.plan, tasks, taskOrder: order, feed: [...next.feed, item] };
    }

    case 'taskUpdated': {
      const task = event.task;
      const known = task.id in next.tasks;
      return {
        ...next,
        tasks: { ...next.tasks, [task.id]: task },
        taskOrder: known ? next.taskOrder : [...next.taskOrder, task.id],
      };
    }

    case 'toolCall': {
      const item: ToolFeedItem = {
        kind: 'tool',
        id: `tool-${seq}`,
        seq,
        at,
        agentId: event.agentId,
        callId: event.callId,
        tool: event.tool,
        arguments: event.arguments,
        expectsResult: !TURN_ENDING_TOOLS.has(event.tool),
        result: null,
      };
      return { ...next, feed: [...next.feed, item] };
    }

    case 'toolResult': {
      const result: ToolResultInfo = { ok: event.ok, summary: event.summary, change: event.change, rejected: false };
      const changes = event.change ? [...next.changes, event.change] : next.changes;
      // Results carry their call's id. As a fallback (older cores), an agent
      // runs its calls one at a time, so a result belongs to its latest open call.
      let index = next.feed.findIndex((f) => f.kind === 'tool' && f.callId === event.callId && f.agentId === event.agentId);
      if (index < 0) index = findOpenCall(next.feed, event.agentId);
      if (index >= 0) {
        const call = next.feed[index] as ToolFeedItem;
        // A rejection recorded from the dialog stays a rejection.
        if (call.result?.rejected) return { ...next, changes };
        const feed = [...next.feed];
        feed[index] = { ...call, result };
        return { ...next, feed, changes };
      }
      const item: ToolFeedItem = { kind: 'tool', id: `tool-${seq}`, seq, at, agentId: event.agentId, callId: event.callId, tool: null, arguments: null, expectsResult: true, result };
      return { ...next, feed: [...next.feed, item], changes };
    }

    case 'approvalRequested':
      if (next.approvals.some((a) => a.id === event.request.id)) return next;
      return { ...next, approvals: [...next.approvals, event.request] };

    case 'questionForUser':
      if (next.questions.some((q) => q.id === event.questionId)) return next;
      return { ...next, questions: [...next.questions, { id: event.questionId, agentId: event.agentId, question: event.question, at }] };

    case 'message': {
      const item: MessageFeedItem = { kind: 'message', id: `msg-${seq}`, seq, at, message: event.message };
      return { ...next, feed: [...next.feed, item] };
    }

    case 'checkpointCreated': {
      if (next.checkpoints.some((c) => c.id === event.checkpoint.id)) return next;
      const checkpoints = [...next.checkpoints, event.checkpoint].sort((a, b) => a.seq - b.seq);
      return { ...next, checkpoints };
    }

    case 'runFinished':
      return { ...next, outcome: event.outcome, summary: event.summary, recap: event.recap ?? null, finishedAt: at, approvals: [], questions: [] };
  }
}

/** Index of the agent's latest call that still waits for its result, or -1. */
function findOpenCall(feed: FeedItem[], agentId: string, tool?: string): number {
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    if (item.kind !== 'tool' || item.agentId !== agentId) continue;
    if (item.result === null && item.expectsResult && item.tool !== null && (tool === undefined || item.tool === tool)) return i;
    return -1;
  }
  return -1;
}

/** Records the user's answer to an approval request and removes it from the queue. */
export function applyDecision(run: RunData, request: ApprovalRequest, response: ApprovalResponse, at: number): RunData {
  const seq = run.nextSeq;
  const reason = response.decision === 'reject' ? (response.reason?.trim() || null) : null;
  const item: DecisionFeedItem = { kind: 'decision', id: `decision-${seq}`, seq, at, agentId: request.agentId, tool: request.tool, title: request.title, decision: response.decision, reason };
  let feed = run.feed;
  if (response.decision === 'reject') {
    const index = findOpenCall(feed, request.agentId, request.tool);
    if (index >= 0) {
      feed = [...feed];
      feed[index] = { ...(feed[index] as ToolFeedItem), result: { ok: false, summary: reason ?? '', change: null, rejected: true } };
    }
  }
  return {
    ...run,
    nextSeq: seq + 1,
    approvals: run.approvals.filter((a) => a.id !== request.id),
    feed: [...feed, item],
  };
}

export function removeQuestion(run: RunData, questionId: string): RunData {
  return { ...run, questions: run.questions.filter((q) => q.id !== questionId) };
}

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
}

/** Net effect per file over the whole run, in order of first change. */
export function changedFiles(changes: FileChange[]): ChangedFile[] {
  const net = new Map<string, ChangeKind | null>();
  for (const change of changes) {
    const prev = net.get(change.path);
    net.set(change.path, combine(prev, change.kind));
  }
  const out: ChangedFile[] = [];
  for (const [path, kind] of net) if (kind) out.push({ path, kind });
  return out;
}

function combine(prev: ChangeKind | null | undefined, next: ChangeKind): ChangeKind | null {
  if (prev === undefined) return next;
  if (prev === null) return next === 'deleted' ? 'deleted' : 'created';
  if (prev === 'created') return next === 'deleted' ? null : 'created';
  if (prev === 'deleted') return next === 'deleted' ? 'deleted' : 'modified';
  return next === 'created' ? 'modified' : next;
}

/** Appends streamed text to an agent's tail, keeping only the last characters. */
export function appendStream(tail: string, text: string): string {
  const next = tail + text;
  return next.length > STREAM_TAIL ? next.slice(-STREAM_TAIL) : next;
}

/** What a run that continues `run` keeps of it; null until it has ended. */
export function continuationOf(run: RunData): ContinuedRun | null {
  if (!run.outcome || !run.runId) return null;
  return { runId: run.runId, goal: run.goal, outcome: run.outcome, summary: run.summary, recap: run.recap, tasks: tasksOf(run) };
}

/** The run's tasks in plan order. */
export function tasksOf(run: Pick<RunData, 'tasks' | 'taskOrder'>): Task[] {
  return run.taskOrder.map((id) => run.tasks[id]).filter((t): t is Task => !!t);
}

export interface ReportLine {
  id: string;
  title: string;
  status: Task['status'];
  /** First line of the task's result. */
  result: string | null;
  /** The reviewer still requested changes after the last round. */
  openComments: boolean;
}

/** The task list shown when there is no summary (stopped run, or the model could not write one). */
export function reportLines(tasks: Task[]): ReportLine[] {
  return tasks.map((t) => {
    const first = t.result?.trim().split('\n')[0]?.trim() ?? '';
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      result: first ? (first.length > 200 ? `${first.slice(0, 200)}…` : first) : null,
      openComments: t.review?.verdict === 'request_changes',
    };
  });
}

/**
 * A finished run as the core stored it for the project: goal, outcome, tasks
 * and changed files. The activity log and the agents' conversations are gone.
 */
export function restoreRun(last: LastRun, project: string | null): RunData {
  const tasks = last.plan?.tasks ?? [];
  return {
    ...createRun(last.goal, last.startedAtUnixMs, { project }),
    runId: last.runId,
    finishedAt: last.finishedAtUnixMs,
    plan: last.plan,
    tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    taskOrder: tasks.map((t) => t.id),
    changes: last.changes,
    outcome: last.outcome,
    summary: last.summary,
    recap: last.recap ?? null,
    stored: true,
  };
}

/** The project's AGENTS.md, where the orchestrator keeps what it learned. */
export const NOTES_FILE = 'AGENTS.md';

/** True when the run wrote the project notes (and did not delete them again). */
export function notesUpdated(run: RunData): boolean {
  const last = changedFiles(run.changes).find((f) => f.path.toLowerCase() === NOTES_FILE.toLowerCase());
  return !!last && last.kind !== 'deleted';
}

/** Tasks a finished run left open; a run that continues it does them first. */
export function openTaskCount(run: RunData): number {
  return run.taskOrder.filter((id) => run.tasks[id] && run.tasks[id].status !== 'done').length;
}

export type ContinueBlock = 'noModel' | 'noProject' | 'otherProject';

/** Why the agents cannot continue `run` right now, or null when they can. */
export function continueBlock(run: RunData, modelReady: boolean, project: string | null): ContinueBlock | null {
  if (run.project !== null && project !== null && run.project !== project) return 'otherProject';
  if (project === null) return 'noProject';
  if (!modelReady) return 'noModel';
  return null;
}

/** True while any agent waits for a model answer. */
export function isGenerating(run: RunData): boolean {
  return run.outcome === null && Object.values(run.agents).some((a) => a.state === 'thinking');
}

/** The task currently being worked on or reviewed, if any. */
export function currentTask(run: RunData): Task | null {
  for (const id of run.taskOrder) {
    const task = run.tasks[id];
    if (task && (task.status === 'inProgress' || task.status === 'inReview')) return task;
  }
  return null;
}
