// Layout of the world-line diagram: one lane per agent, time flowing left to
// right, hand-offs between agents drawn as crossings. Pure geometry so it can
// be tested; WorldLines.tsx only turns the result into SVG.
//
// Time is warped so the diagram stays legible in a narrow panel: short gaps
// keep their real length, long waits (an approval left open for minutes) grow
// only logarithmically. Every hand-off additionally gets a fixed slot of a few
// pixels, so crossings and task labels never collapse into each other.

import type { AgentState } from '../../bindings/AgentState';
import type { TaskStatus } from '../../bindings/TaskStatus';
import { ACTIVE_STATES, WAITING_STATES, type RunData, type TimelineEntry } from './run';

export type SegmentKind = 'active' | 'waiting' | 'idle' | 'failed';
export type HandoffKind = 'dispatch' | 'review' | 'changes';

export interface Lane {
  agentId: string;
  role: string;
}

export interface Segment {
  agentId: string;
  x0: number;
  x1: number;
  kind: SegmentKind;
}

export interface Handoff {
  from: string;
  to: string;
  taskId: string;
  kind: HandoffKind;
  x0: number;
  x1: number;
}

export interface TaskSpan {
  taskId: string;
  status: TaskStatus;
  x0: number;
  x1: number;
  /** Left edge of the label; shifted right when labels would overlap. */
  labelX: number;
}

export interface Head {
  agentId: string;
  x: number;
  /** The model is producing tokens right now (the head pulses). */
  generating: boolean;
  waiting: boolean;
}

export interface WorldLineLayout {
  segments: Segment[];
  handoffs: Handoff[];
  tasks: TaskSpan[];
  heads: Head[];
  /** First x at which each agent appeared. */
  firstSeen: Record<string, number>;
  xEnd: number;
}

export interface LayoutInput {
  timeline: TimelineEntry[];
  lanes: Lane[];
  startedAt: number;
  /** "Now" while running, the finish time afterwards. */
  endAt: number;
  running: boolean;
  width: number;
}

/** Widest slot a hand-off gets, in px. */
const HANDOFF_PX = 22;
/** Share of the width hand-off slots may take at most. */
const HANDOFF_SHARE = 0.45;
/** While running, the axis spans at least this much warped time (s), so lines grow from the left. */
const MIN_SPAN = 40;
/** A state change this close to a hand-off belongs to it (ms). */
const HANDOFF_SNAP_MS = 250;
const PAD_LEFT = 2;
const PAD_RIGHT = 8;
/** Estimated width of one label character (11 px monospace). */
const LABEL_CHAR_PX = 6.8;

/** Warped length of a real gap in ms: linear up to 10 s, logarithmic beyond. */
export function warpGap(ms: number): number {
  const s = Math.max(0, ms) / 1000;
  return s <= 10 ? s : 10 + 10 * Math.log1p((s - 10) / 10);
}

export function segmentKind(state: AgentState): SegmentKind {
  if (ACTIVE_STATES.has(state)) return 'active';
  if (WAITING_STATES.has(state)) return 'waiting';
  if (state === 'failed') return 'failed';
  return 'idle';
}

const CORE_TOP = ['orchestrator', 'coder'];

/** Lane order: orchestrator, coder, custom roles as they appear, reviewer last. */
export function laneOrder(run: RunData, includeReviewer: boolean): Lane[] {
  const ids: string[] = [...CORE_TOP];
  const custom: string[] = [];
  const add = (id: string) => {
    if (id === 'reviewer' || ids.includes(id) || custom.includes(id)) return;
    custom.push(id);
  };
  for (const id of run.agentOrder) add(id);
  for (const id of run.taskOrder) {
    const task = run.tasks[id];
    if (task) add(task.assignee);
  }
  const lanes = [...ids, ...custom];
  if (includeReviewer || 'reviewer' in run.agents) lanes.push('reviewer');
  return lanes.map((agentId) => ({ agentId, role: run.agents[agentId]?.role ?? agentId }));
}

interface StatusPoint {
  seq: number;
  at: number;
  agentId: string;
  state: AgentState;
  taskId: string | null;
}

interface TaskPoint {
  seq: number;
  at: number;
  taskId: string;
  status: TaskStatus;
  assignee: string;
}

interface RawHandoff {
  seq: number;
  at: number;
  from: string;
  to: string;
  taskId: string;
  kind: HandoffKind;
}

function extract(timeline: TimelineEntry[]) {
  const statuses: StatusPoint[] = [];
  const tasks: TaskPoint[] = [];
  for (const { seq, at, event } of timeline) {
    if (event.type === 'status') statuses.push({ seq, at, agentId: event.status.agentId, state: event.status.state, taskId: event.status.taskId });
    else if (event.type === 'taskUpdated') tasks.push({ seq, at, taskId: event.task.id, status: event.task.status, assignee: event.task.assignee });
  }
  return { statuses, tasks };
}

function findHandoffs(statuses: StatusPoint[], tasks: TaskPoint[], laneIds: Set<string>): RawHandoff[] {
  const out: RawHandoff[] = [];
  const prevStatus = new Map<string, TaskStatus>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const prev = prevStatus.get(t.taskId) ?? 'pending';
    prevStatus.set(t.taskId, t.status);
    if (t.status === prev) continue;
    let raw: RawHandoff | null = null;
    if (t.status === 'inProgress' && prev === 'pending') raw = { seq: t.seq, at: t.at, from: 'orchestrator', to: t.assignee, taskId: t.taskId, kind: 'dispatch' };
    else if (t.status === 'inProgress' && prev === 'inReview') raw = { seq: t.seq, at: t.at, from: 'reviewer', to: t.assignee, taskId: t.taskId, kind: 'changes' };
    else if (t.status === 'inReview') {
      // Only a review that actually happens is a hand-off: the reviewer must
      // become active on this task before the task moves on.
      const nextUpdate = tasks.slice(i + 1).find((u) => u.taskId === t.taskId)?.seq ?? Infinity;
      const reviewed = statuses.some((s) => s.agentId === 'reviewer' && s.seq > t.seq && s.seq < nextUpdate && s.taskId === t.taskId && segmentKind(s.state) !== 'idle');
      if (reviewed) raw = { seq: t.seq, at: t.at, from: t.assignee, to: 'reviewer', taskId: t.taskId, kind: 'review' };
    }
    if (raw && raw.from !== raw.to && laneIds.has(raw.from) && laneIds.has(raw.to)) out.push(raw);
  }
  return out;
}

/** Warped time at `t`, given sorted keypoints and their warped values. */
function makeWarp(startedAt: number, times: number[]) {
  const keys = [...new Set([startedAt, ...times.filter((t) => t >= startedAt)])].sort((a, b) => a - b);
  const warped: number[] = [];
  for (let i = 0; i < keys.length; i++) warped.push(i === 0 ? 0 : warped[i - 1] + warpGap(keys[i] - keys[i - 1]));
  return (t: number): number => {
    if (t <= keys[0]) return 0;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (keys[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return warped[lo] + warpGap(t - keys[lo]);
  };
}

export function layoutWorldLines({ timeline, lanes, startedAt, endAt, running, width }: LayoutInput): WorldLineLayout {
  const laneIds = new Set(lanes.map((l) => l.agentId));
  const { statuses, tasks } = extract(timeline);
  const raw = findHandoffs(statuses, tasks, laneIds);

  const end = Math.max(endAt, startedAt);
  const warp = makeWarp(startedAt, [...statuses.map((s) => s.at), ...tasks.map((t) => t.at), end]);
  const total = warp(end);
  const scale = running ? Math.max(total, MIN_SPAN) : Math.max(total, 1e-6);

  const timeWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const slot = raw.length ? Math.min(HANDOFF_PX, (timeWidth * HANDOFF_SHARE) / raw.length) : 0;
  const flex = timeWidth - slot * raw.length;

  const xBase = (t: number) => PAD_LEFT + (warp(t) / scale) * flex;
  const before = (seq: number) => {
    let n = 0;
    while (n < raw.length && raw[n].seq < seq) n++;
    return n;
  };
  const x = (seq: number, t: number) => xBase(t) + slot * before(seq);
  const xEnd = xBase(end) + slot * raw.length;

  const handoffs: Handoff[] = raw.map((h, i) => {
    const x0 = xBase(h.at) + slot * i;
    return { from: h.from, to: h.to, taskId: h.taskId, kind: h.kind, x0, x1: x0 + slot };
  });

  // ---- segments per agent
  const segments: Segment[] = [];
  const firstSeen: Record<string, number> = {};
  const heads: Head[] = [];
  for (const lane of lanes) {
    const points = statuses.filter((s) => s.agentId === lane.agentId);
    if (!points.length) continue;
    const mine: Segment[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const n = points[i + 1];
      const kind = segmentKind(p.state);
      let x0 = x(p.seq, p.at);
      let x1 = n ? x(n.seq, n.at) : xEnd;
      if (kind !== 'idle') {
        raw.forEach((h, k) => {
          const hx = handoffs[k];
          // A line that hands off ends where the crossing starts ...
          if (h.from === lane.agentId && n && p.seq < h.seq && n.seq > h.seq && n.at - h.at <= HANDOFF_SNAP_MS) x1 = Math.min(x1, hx.x0);
          // ... and the receiving line starts where the crossing ends.
          if (h.to === lane.agentId && p.seq < h.seq && h.at - p.at <= HANDOFF_SNAP_MS && (!n || n.seq > h.seq)) x0 = Math.max(x0, hx.x1);
        });
        // Keep very short activity visible.
        if (x1 - x0 < 1.5) x1 = x0 + 1.5;
      }
      if (x1 <= x0 && kind === 'idle') continue;
      const last = mine[mine.length - 1];
      if (last && last.kind === kind && Math.abs(last.x1 - x0) < 0.01) last.x1 = Math.max(last.x1, x1);
      else mine.push({ agentId: lane.agentId, x0, x1, kind });
    }
    firstSeen[lane.agentId] = mine.length ? mine[0].x0 : x(points[0].seq, points[0].at);
    segments.push(...mine);
    const latest = points[points.length - 1];
    const kind = segmentKind(latest.state);
    if (running && (kind === 'active' || kind === 'waiting')) {
      heads.push({ agentId: lane.agentId, x: xEnd, generating: latest.state === 'thinking', waiting: kind === 'waiting' });
    }
  }

  // ---- task spans along the top axis
  const spans: TaskSpan[] = [];
  const order: string[] = [];
  for (const t of tasks) if (!order.includes(t.taskId)) order.push(t.taskId);
  let labelEnd = -Infinity;
  for (const taskId of order) {
    const updates = tasks.filter((t) => t.taskId === taskId);
    const start = updates.find((u) => u.status === 'inProgress' || u.status === 'inReview');
    if (!start) continue;
    const finish = updates.find((u) => u.seq > start.seq && (u.status === 'done' || u.status === 'failed' || u.status === 'skipped'));
    const dispatch = handoffs.find((h, k) => h.taskId === taskId && h.kind === 'dispatch' && raw[k].seq === start.seq);
    const x0 = dispatch ? dispatch.x1 : x(start.seq, start.at);
    const x1 = Math.max(x0 + 2, finish ? x(finish.seq, finish.at) : xEnd);
    const labelX = Math.max(x0, labelEnd + 4);
    labelEnd = labelX + taskId.length * LABEL_CHAR_PX;
    spans.push({ taskId, status: updates[updates.length - 1].status, x0, x1, labelX });
  }

  return { segments, handoffs, tasks: spans, heads, firstSeen, xEnd };
}
