import { BookOpenText, CircleCheck, CircleStop, CircleX, CornerDownRight, MessageCircleMore, Pause, Play, Plus, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunOutcome } from '../../bindings/RunOutcome';
import { Braid } from '../../components/Braid';
import { Dialog } from '../../components/Dialog';
import { Badge, Button, Segmented, Spinner } from '../../components/ui';
import { ActivityFeed } from './ActivityFeed';
import { AgentList } from './AgentList';
import { Checkpoints } from './Checkpoints';
import { openInEditor, useNow, useRoleName } from './hooks';
import { ChangedFilesList } from './parts';
import { NextStep } from './NextStep';
import { changedFiles, currentTask, isGenerating, NOTES_FILE, notesUpdated, type ContinuedRun, type RunData, type UserQuestion } from './run';
import s from './RunView.module.css';
import { useAgentRun } from './store';
import { TaskList } from './TaskList';
import { formatClock } from './text';
import { WorldLines } from './WorldLines';

type Tab = 'summary' | 'tasks' | 'activity' | 'checkpoints';

export function RunView({ pendingQuestions, onAnswer }: { pendingQuestions: UserQuestion[]; onAnswer: (id: string) => void }) {
  const { t } = useTranslation('agents');
  const run = useAgentRun((st) => st.run);
  const finished = !!run?.outcome;
  const [tab, setTab] = useState<Tab>(finished ? 'summary' : 'tasks');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // When the run ends, its summary is the most useful thing to see.
  useEffect(() => {
    if (finished) setTab('summary');
    else setTab((v) => (v === 'summary' ? 'tasks' : v));
  }, [finished]);

  // The activity log sticks to the newest entry unless the user scrolled up.
  const feedLength = run?.feed.length ?? 0;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && tab === 'activity' && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [feedLength, tab]);

  if (!run) return null;
  const done = run.taskOrder.filter((id) => run.tasks[id]?.status === 'done').length;
  const total = run.taskOrder.length;
  const options: Array<{ value: Tab; label: string }> = [
    ...(finished ? [{ value: 'summary' as const, label: t('run.tabSummary') }] : []),
    { value: 'tasks', label: total ? t('run.tabTasksCount', { done, total }) : t('run.tabTasks') },
    { value: 'activity', label: t('run.tabActivity') },
    { value: 'checkpoints', label: run.checkpoints.length ? t('run.tabCheckpointsCount', { value: run.checkpoints.length }) : t('run.tabCheckpoints') },
  ];

  return (
    <div className={s.view}>
      <RunHeader run={run} />
      <div className={s.top}>
        <WorldLines />
        {pendingQuestions.map((q) => (
          <QuestionBanner key={q.id} question={q} onAnswer={onAnswer} />
        ))}
        <AgentList />
      </div>
      <div className={s.tabs}>
        <Segmented
          label={t('run.tabs')}
          value={tab}
          options={options}
          onChange={(next) => {
            atBottom.current = true;
            setTab(next);
          }}
        />
      </div>
      <div
        ref={scrollRef}
        className={s.tabContent}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        }}
      >
        {tab === 'summary' && <Summary run={run} />}
        {tab === 'tasks' && <TaskList />}
        {tab === 'activity' && <ActivityFeed run={run} />}
        {tab === 'checkpoints' && <Checkpoints run={run} />}
      </div>
      {finished && <NextStep run={run} />}
      <LiveRegion run={run} />
    </div>
  );
}

const OUTCOME_TONE = { completed: 'success', cancelled: 'neutral', failed: 'danger' } as const;

function OutcomeIcon({ outcome, size = 16 }: { outcome: RunOutcome; size?: number }) {
  if (outcome === 'completed') return <CircleCheck size={size} className={s.completed} aria-hidden />;
  if (outcome === 'failed') return <CircleX size={size} className={s.failed} aria-hidden />;
  return <CircleStop size={size} className={s.cancelled} aria-hidden />;
}

function RunHeader({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const phase = useAgentRun((st) => st.phase);
  const paused = useAgentRun((st) => st.paused);
  const stopping = useAgentRun((st) => st.stopping);
  const controlBusy = useAgentRun((st) => st.controlBusy);
  const { pause, resume, stop, newRun } = useAgentRun.getState();
  const [confirmStop, setConfirmStop] = useState(false);
  const closeStop = useCallback(() => setConfirmStop(false), []);
  const live = run.outcome === null;
  const now = useNow(live, 1000);
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const task = currentTask(run);
  const total = run.taskOrder.length;
  const index = task ? run.taskOrder.indexOf(task.id) + 1 : 0;

  let status: ReactNode;
  if (run.outcome) {
    status = (
      <Badge tone={OUTCOME_TONE[run.outcome]}>
        <OutcomeIcon outcome={run.outcome} size={12} />
        {t(`outcome.${run.outcome}`)}
      </Badge>
    );
  } else if (stopping) {
    status = (
      <span className={s.status}>
        <Spinner />
        {t('run.stopping')}
      </span>
    );
  } else if (paused) {
    status = <Badge tone="warning">{t('run.paused')}</Badge>;
  } else if (phase === 'starting' || !run.agentOrder.length) {
    status = (
      <span className={s.status}>
        <Spinner />
        {t('run.starting')}
      </span>
    );
  } else {
    status = (
      <span className={s.status}>
        <Braid active={isGenerating(run)} size={12} />
        {task ? t('run.progress', { index, total }) : run.plan ? t('run.wrappingUp') : t('run.planning')}
      </span>
    );
  }

  return (
    <header className={s.header}>
      {run.continues && <Continues from={run.continues} />}
      <Goal text={run.goal} />
      <div className={s.controls}>
        <div className={s.state}>
          {status}
          <span className={s.elapsed} title={t('run.elapsed')}>
            <span className="visually-hidden">{t('run.elapsed')}: </span>
            {formatClock(elapsed)}
          </span>
        </div>
        <div className={s.actions}>
          {live ? (
            <>
              {paused ? (
                <Button size="sm" variant="secondary" icon={<Play size={13} />} onClick={() => void resume()} disabled={controlBusy || stopping || !run.runId}>
                  {t('run.resume')}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={<Pause size={13} />} onClick={() => void pause()} disabled={controlBusy || stopping || !run.runId}>
                  {t('run.pause')}
                </Button>
              )}
              <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => setConfirmStop(true)} disabled={stopping || controlBusy || !run.runId}>
                {t('run.stop')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={newRun}>
              {t('run.newRun')}
            </Button>
          )}
        </div>
      </div>
      {confirmStop && live && (
        <Dialog
          open
          title={t('run.stopTitle')}
          onClose={closeStop}
          width={440}
          footer={
            <>
              <Button variant="ghost" onClick={closeStop}>
                {t('common:actions.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  closeStop();
                  void stop();
                }}
              >
                {t('run.stopConfirm')}
              </Button>
            </>
          }
        >
          <p className={s.dialogText}>{t('run.stopBody')}</p>
        </Dialog>
      )}
    </header>
  );
}

/** The run this one continues; opens to show how it ended. */
function Continues({ from }: { from: ContinuedRun }) {
  const { t } = useTranslation('agents');
  return (
    <details className={s.continues}>
      <summary className={s.continuesHead} title={from.goal}>
        <CornerDownRight size={12} aria-hidden />
        <span className={s.continuesLabel}>{t('run.continues')}</span>
        <span className={s.continuesGoal}>{from.goal}</span>
      </summary>
      <div className={s.continuesBody}>
        <span className={s.continuesOutcome}>
          <OutcomeIcon outcome={from.outcome} size={12} />
          {t(`outcome.${from.outcome}`)}
        </span>
        {from.summary?.trim() && <pre className={s.continuesSummary}>{from.summary.trim()}</pre>}
      </div>
    </details>
  );
}

/** The goal, clamped to two lines; a click shows all of it. */
function Goal({ text }: { text: string }) {
  const { t } = useTranslation('agents');
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || open) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div className={s.goalWrap}>
      <p ref={ref} className={`${s.goal} ${open ? '' : s.clamped}`} title={overflowing && !open ? text : undefined}>
        {text}
      </p>
      {(overflowing || open) && (
        <button type="button" className={s.goalToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('run.collapseGoal') : t('run.expandGoal')}
        </button>
      )}
    </div>
  );
}

function QuestionBanner({ question, onAnswer }: { question: UserQuestion; onAnswer: (id: string) => void }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  return (
    <div className={s.banner} role="status">
      <MessageCircleMore size={15} aria-hidden />
      <span className={s.bannerText}>{t('run.questionWaiting', { agent: roleName(question.agentId) })}</span>
      <Button size="sm" variant="primary" onClick={() => onAnswer(question.id)}>
        {t('run.answer')}
      </Button>
    </div>
  );
}

function Summary({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const files = useMemo(() => changedFiles(run.changes), [run.changes]);
  if (!run.outcome) return null;
  return (
    <div className={s.summary}>
      <div className={s.outcome}>
        <OutcomeIcon outcome={run.outcome} />
        <span className={s.outcomeLabel}>{t(`outcome.${run.outcome}`)}</span>
        {run.finishedAt !== null && <span className={s.outcomeTime}>{formatClock(run.finishedAt - run.startedAt)}</span>}
      </div>
      {run.summary?.trim() && <pre className={s.summaryText}>{run.summary.trim()}</pre>}
      {notesUpdated(run) && (
        <div className={s.notes}>
          <BookOpenText size={14} aria-hidden />
          <span className={s.notesText}>{t('run.notesUpdated')}</span>
          <Button size="sm" variant="ghost" onClick={() => openInEditor(NOTES_FILE)}>
            {t('run.openNotes')}
          </Button>
        </div>
      )}
      <div className={s.filesBlock}>
        <h3 className={s.subheading}>{t('run.changedFiles')}</h3>
        <ChangedFilesList files={files} />
      </div>
    </div>
  );
}

/** Announces task progress and the end of the run to screen readers. */
function LiveRegion({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const task = currentTask(run);
  const text = run.outcome
    ? t(`outcome.${run.outcome}`)
    : task
      ? t('live.task', { id: task.id, title: task.title, status: t(`taskStatus.${task.status}`) })
      : run.approvals.length
        ? t('live.approval')
        : '';
  return (
    <div className="visually-hidden" aria-live="polite" role="status">
      {text}
    </div>
  );
}
