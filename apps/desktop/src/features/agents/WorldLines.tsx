// The signature of agent mode: every agent is a world line over time, and each
// hand-off (orchestrator -> coder -> reviewer -> coder ...) is a crossing, like
// the braided world lines of anyons. See docs/design.md.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../state/app';
import { useNow, useRoleName } from './hooks';
import { currentTask } from './run';
import { useAgentRun } from './store';
import { roleColor } from './text';
import s from './WorldLines.module.css';
import { laneOrder, layoutWorldLines, type Handoff, type Lane } from './layout';

const AXIS_H = 22;
const LANE_H = 24;
const AXIS_Y = 14;

const laneY = (index: number) => AXIS_H + index * LANE_H + LANE_H / 2;

function usePlotWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function WorldLines() {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const run = useAgentRun((st) => st.run);
  const reviewEnabled = useApp((st) => st.settings?.agent.reviewEnabled ?? true);
  const [plotRef, width] = usePlotWidth();
  const uid = useId().replace(/:/g, '');

  const running = !!run && run.outcome === null;
  const now = useNow(running, 500);
  const endAt = run?.finishedAt ?? now;

  // Lanes change rarely (a new agent or assignee), but `run` changes with every
  // streamed token; a serialized key keeps the layout memo from recomputing.
  const laneKey = JSON.stringify(run ? laneOrder(run, reviewEnabled) : []);
  const lanes = useMemo(() => JSON.parse(laneKey) as Lane[], [laneKey]);

  const timeline = run?.timeline;
  const startedAt = run?.startedAt ?? 0;
  const layout = useMemo(
    () => (timeline && width > 0 ? layoutWorldLines({ timeline, lanes, startedAt, endAt, running, width }) : null),
    [timeline, lanes, startedAt, endAt, running, width],
  );

  if (!run) return null;
  const height = AXIS_H + lanes.length * LANE_H + 4;
  const index = new Map(lanes.map((l, i) => [l.agentId, i]));
  const colorOf = (agentId: string) => roleColor(lanes[index.get(agentId) ?? -1]?.role ?? agentId);

  // ---- text alternative
  const task = currentTask(run);
  const total = run.taskOrder.length;
  const parts: string[] = [];
  if (task) {
    parts.push(t('lines.summaryTask', { id: task.id, total, title: task.title, status: t(`taskStatus.${task.status}`) }));
  } else if (!run.plan) {
    parts.push(t('lines.summaryPlanning'));
  } else if (total) {
    const done = run.taskOrder.filter((id) => run.tasks[id]?.status === 'done').length;
    parts.push(t('lines.summaryTasks', { done, total }));
  }
  const agentParts = lanes
    .filter((l) => run.agents[l.agentId])
    .map((l) => t('lines.summaryAgent', { agent: roleName(l.agentId), state: t(`states.${run.agents[l.agentId].state}`) }));
  if (agentParts.length) parts.push(`${agentParts.join(', ')}.`);
  const summary = `${t('lines.label')}: ${parts.join(' ') || t('lines.summaryEmpty')}`;

  return (
    <figure className={s.figure}>
      <div className={s.labels} aria-hidden style={{ paddingTop: AXIS_H }}>
        {lanes.map((lane) => (
          <div key={lane.agentId} className={`${s.label} ${run.agents[lane.agentId] ? '' : s.absent}`} style={{ height: LANE_H }}>
            <span className={s.swatch} style={{ background: roleColor(lane.role) }} />
            <span className={s.name}>{roleName(lane.agentId)}</span>
          </div>
        ))}
      </div>
      <div ref={plotRef} className={s.plot}>
        {layout && (
          <svg className={s.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
            <defs>
              {layout.handoffs.map((h, i) => (
                <linearGradient key={i} id={`${uid}-h${i}`} gradientUnits="userSpaceOnUse" x1={h.x0} x2={h.x1} y1={0} y2={0}>
                  <stop offset="0.15" style={{ stopColor: colorOf(h.from) }} />
                  <stop offset="0.85" style={{ stopColor: colorOf(h.to) }} />
                </linearGradient>
              ))}
            </defs>

            {/* Task spans along the top axis, with faint guides down through the lanes. */}
            {layout.tasks.map((span) => (
              <g key={span.taskId} className={`${s.task} ${s[`task-${span.status}`] ?? ''}`}>
                <line className={s.guide} x1={span.x0} x2={span.x0} y1={AXIS_Y + 4} y2={height - 2} />
                <line className={s.span} x1={span.x0} x2={span.x1} y1={AXIS_Y + 3} y2={AXIS_Y + 3} />
                <text className={s.taskLabel} x={span.labelX} y={AXIS_Y - 1}>
                  {span.taskId}
                </text>
              </g>
            ))}

            {/* Lane baselines: dotted until the agent appears. */}
            {lanes.map((lane, i) => (
              <line key={lane.agentId} className={s.baseline} x1={2} x2={Math.max(2, width - 8)} y1={laneY(i)} y2={laneY(i)} />
            ))}

            {layout.segments.map((seg, i) => {
              const y = laneY(index.get(seg.agentId) ?? 0);
              return (
                <line
                  key={i}
                  className={`${s.segment} ${s[seg.kind]}`}
                  x1={seg.x0}
                  x2={seg.x1}
                  y1={y}
                  y2={y}
                  style={{ stroke: seg.kind === 'failed' ? undefined : colorOf(seg.agentId) }}
                />
              );
            })}

            {layout.handoffs.map((h, i) => (
              <Crossing key={i} handoff={h} y0={laneY(index.get(h.from) ?? 0)} y1={laneY(index.get(h.to) ?? 0)} stroke={`url(#${uid}-h${i})`} fromColor={colorOf(h.from)} toColor={colorOf(h.to)} />
            ))}

            {!running && run.outcome && (
              <line className={`${s.end} ${s[`end-${run.outcome}`]}`} x1={layout.xEnd} x2={layout.xEnd} y1={AXIS_H + 2} y2={height - 4} />
            )}

            {layout.heads.map((head) => {
              const y = laneY(index.get(head.agentId) ?? 0);
              const color = colorOf(head.agentId);
              return (
                <g key={head.agentId}>
                  {head.generating && <circle className={s.halo} cx={head.x} cy={y} r={4} style={{ stroke: color }} />}
                  <circle className={head.waiting ? s.headWaiting : s.head} cx={head.x} cy={y} r={3.5} style={head.waiting ? { stroke: color } : { fill: color }} />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </figure>
  );
}

/** A hand-off: an S-curve from one lane to another that crosses over the lanes between. */
function Crossing({ handoff: h, y0, y1, stroke, fromColor, toColor }: { handoff: Handoff; y0: number; y1: number; stroke: string; fromColor: string; toColor: string }) {
  const mid = (h.x0 + h.x1) / 2;
  const d = `M ${h.x0} ${y0} C ${mid} ${y0}, ${mid} ${y1}, ${h.x1} ${y1}`;
  return (
    <g>
      <path className={s.crossingGap} d={d} />
      <path className={s.crossing} d={d} style={{ stroke }} />
      <circle className={h.kind === 'changes' ? s.nodeChanges : s.node} cx={h.x0} cy={y0} r={2.25} style={h.kind === 'changes' ? undefined : { fill: fromColor }} />
      <circle className={s.node} cx={h.x1} cy={y1} r={2.25} style={{ fill: toColor }} />
    </g>
  );
}
