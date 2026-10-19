// Agent mode: an orchestrator plans, a coder implements, a reviewer checks,
// and the user watches (and steers) their world lines in this panel. The
// header switches between planning (agents only read and write a plan) and
// carrying it out.

import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkMode } from '../../bindings/WorkMode';
import { SectionHeader, Segmented } from '../../components/ui';
import { useApp } from '../../state/app';
import { useLayout } from '../../state/layout';
import s from './AgentsPanel.module.css';
import { ApprovalHost, QuestionDialog } from './ApprovalDialog';
import { IdleView } from './IdleView';
import { usePlanning } from './planStore';
import { PlanView } from './PlanView';
import type { UserQuestion } from './run';
import { RunView } from './RunView';
import { useAgentRun } from './store';

const NO_QUESTIONS: UserQuestion[] = [];
const MODES: WorkMode[] = ['plan', 'code'];

export function AgentsPanel() {
  const { t } = useTranslation('agents');
  const phase = useAgentRun((st) => st.phase);
  const mode = usePlanning((st) => st.mode);
  // A new run gets a fresh view (tab, scroll position, expanded rows).
  const runKey = useAgentRun((st) => st.run?.startedAt ?? 0);
  const questions = useAgentRun((st) => st.run?.questions ?? NO_QUESTIONS);
  // Kept in the store, so a question answered "later" stays deferred while the panel is closed.
  const later = useAgentRun((st) => st.deferred);
  const reopenQuestion = useAgentRun((st) => st.reopenQuestion);
  const deferred = useMemo(() => questions.filter((q) => later.has(q.id)), [questions, later]);
  // The project's last run, also from before a restart, so it can be continued.
  const project = useApp((st) => st.workspace?.root ?? null);
  const loadLast = useAgentRun((st) => st.loadLast);
  useEffect(() => {
    void loadLast(project);
  }, [project, loadLast]);

  return (
    <div className={s.panel}>
      <SectionHeader title={t('title')} actions={<ModeSwitch />} />
      {mode === 'plan' ? <PlanView /> : phase === 'idle' ? <IdleView /> : <RunView key={runKey} pendingQuestions={deferred} onAnswer={reopenQuestion} />}
    </div>
  );
}

/** "Planen | Umsetzen", always in the panel's header. */
function ModeSwitch() {
  const { t } = useTranslation('agents');
  const mode = usePlanning((st) => st.mode);
  const setMode = usePlanning((st) => st.setMode);
  return (
    <div className={s.modeSwitch} title={t('workMode.hint', { key: 'Alt+P' })}>
      <Segmented label={t('workMode.label')} value={mode} options={MODES.map((m) => ({ value: m, label: t(`workMode.${m}`) }))} onChange={(m) => void setMode(m)} />
    </div>
  );
}

/**
 * Approvals and questions of a running agent, and the switch between planning
 * and carrying out (Alt+P). Mounted by the shell, so they work whichever
 * panel is open (or none).
 */
export function AgentAttention() {
  const phase = useAgentRun((st) => st.phase);
  const questions = useAgentRun((st) => st.run?.questions ?? NO_QUESTIONS);
  const hasApproval = useAgentRun((st) => (st.run?.approvals.length ?? 0) > 0);
  const later = useAgentRun((st) => st.deferred);
  const deferQuestion = useAgentRun((st) => st.deferQuestion);
  const project = useApp((st) => st.workspace?.root ?? null);
  const loadPlan = usePlanning((st) => st.load);

  // The project's plan and mode, also while the panel is closed (for Alt+P).
  useEffect(() => {
    void loadPlan(project);
  }, [project, loadPlan]);

  // Alt+P: no editor or app shortcut uses it, and it types nothing on Windows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== 'p') return;
      e.preventDefault();
      useLayout.getState().setRight('agents');
      void usePlanning.getState().toggleMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const open = questions.find((q) => !later.has(q.id));
  const openId = open?.id;
  const answerLater = useCallback(() => {
    if (openId) deferQuestion(openId);
  }, [openId, deferQuestion]);

  if (phase === 'idle') return null;
  return (
    <>
      <ApprovalHost />
      {!hasApproval && open && <QuestionDialog key={open.id} question={open} onLater={answerLater} />}
    </>
  );
}
