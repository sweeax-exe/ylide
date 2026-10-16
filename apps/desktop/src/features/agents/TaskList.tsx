import { ChevronDown, Circle, CircleCheck, CircleDot, CircleMinus, CircleX, ScanEye } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review } from '../../bindings/Review';
import type { Severity } from '../../bindings/Severity';
import type { Task } from '../../bindings/Task';
import type { TaskStatus } from '../../bindings/TaskStatus';
import { Braid } from '../../components/Braid';
import { Badge, IconButton, type Tone } from '../../components/ui';
import { openInEditor, useRoleName } from './hooks';
import { isGenerating } from './run';
import { useAgentRun } from './store';
import s from './TaskList.module.css';

const SEVERITY_TONE: Record<Severity, Tone> = { blocker: 'danger', major: 'warning', minor: 'neutral', nit: 'neutral' };

export function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const props = { size: 15, className: s[`icon-${status}`], 'aria-hidden': true } as const;
  switch (status) {
    case 'pending':
      return <Circle {...props} />;
    case 'inProgress':
      return <CircleDot {...props} />;
    case 'inReview':
      return <ScanEye {...props} />;
    case 'done':
      return <CircleCheck {...props} />;
    case 'failed':
      return <CircleX {...props} />;
    case 'skipped':
      return <CircleMinus {...props} />;
  }
}

export function TaskList() {
  const { t } = useTranslation('agents');
  const run = useAgentRun((st) => st.run);
  if (!run) return null;
  if (!run.plan && run.taskOrder.length === 0) {
    return (
      <div className={s.planning}>
        {run.outcome === null ? (
          <>
            <Braid active={isGenerating(run)} size={14} />
            <span>{t('tasks.planning')}</span>
          </>
        ) : (
          <span>{t('tasks.noPlan')}</span>
        )}
      </div>
    );
  }
  return (
    <div className={s.wrap}>
      {run.plan?.summary && (
        <p className={s.planSummary}>
          <span className={s.planLabel}>{t('tasks.plan')}</span> {run.plan.summary}
        </p>
      )}
      <ol className={s.list}>
        {run.taskOrder.map((id) => {
          const task = run.tasks[id];
          return task ? <TaskRow key={id} task={task} /> : null;
        })}
      </ol>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const [open, setOpen] = useState(false);
  const hasDetails = !!task.description.trim() || task.files.length > 0;
  return (
    <li className={`${s.task} ${s[`status-${task.status}`] ?? ''}`}>
      <TaskStatusIcon status={task.status} />
      <div className={s.body}>
        <div className={s.head}>
          <span className={s.id}>{task.id}</span>
          <span className={s.title}>{task.title}</span>
          {task.attempts > 0 && <Badge tone="neutral">{t('tasks.rounds', { count: task.attempts })}</Badge>}
          {hasDetails && (
            <IconButton label={open ? t('tasks.hideDetails', { id: task.id }) : t('tasks.showDetails', { id: task.id })} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={s.toggle}>
              <ChevronDown size={14} className={open ? s.chevronOpen : s.chevron} />
            </IconButton>
          )}
        </div>
        <div className={s.meta}>
          {t(`taskStatus.${task.status}`)} · {roleName(task.assignee)}
        </div>
        {open && (
          <div className={s.details}>
            {task.description.trim() && <p className={s.description}>{task.description}</p>}
            {task.files.length > 0 && (
              <div className={s.expected}>
                <span className={s.expectedLabel}>{t('tasks.files')}</span>
                {task.files.map((f) => (
                  <button key={f} type="button" className={s.fileButton} onClick={() => openInEditor(f)}>
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {task.result && <p className={s.result}>{task.result}</p>}
        {task.review && <ReviewBlock review={task.review} />}
      </div>
    </li>
  );
}

function ReviewBlock({ review }: { review: Review }) {
  const { t } = useTranslation('agents');
  const approved = review.verdict === 'approve';
  return (
    <div className={`${s.review} ${approved ? s.approved : s.changes}`}>
      <div className={s.verdict}>
        <Badge tone={approved ? 'success' : 'warning'}>{t(`verdict.${review.verdict}`)}</Badge>
        {review.summary && <span className={s.reviewSummary}>{review.summary}</span>}
      </div>
      {review.comments.length > 0 && (
        <ul className={s.comments}>
          {review.comments.map((c, i) => {
            const location = c.file ? (c.line !== null ? `${c.file}:${c.line}` : c.file) : null;
            return (
              <li key={i} className={s.comment}>
                <Badge tone={SEVERITY_TONE[c.severity]}>{t(`severity.${c.severity}`)}</Badge>
                <div className={s.commentBody}>
                  {location && c.file ? (
                    <button type="button" className={s.location} onClick={() => openInEditor(c.file as string, c.line ?? undefined)} title={t('tasks.openAt', { location })}>
                      {location}
                    </button>
                  ) : (
                    <span className={s.general}>{t('tasks.general')}</span>
                  )}
                  <span className={s.commentText}>{c.message}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
