// Agent mode: an orchestrator plans, a coder implements, a reviewer checks,
// and the user watches (and steers) their world lines in this panel.

import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionHeader } from '../../components/ui';
import { useApp } from '../../state/app';
import s from './AgentsPanel.module.css';
import { ApprovalHost, QuestionDialog } from './ApprovalDialog';
import { IdleView } from './IdleView';
import type { UserQuestion } from './run';
import { RunView } from './RunView';
import { useAgentRun } from './store';

const NO_QUESTIONS: UserQuestion[] = [];

export function AgentsPanel() {
  const { t } = useTranslation('agents');
  const phase = useAgentRun((st) => st.phase);
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
      <SectionHeader title={t('title')} />
      {phase === 'idle' ? <IdleView /> : <RunView key={runKey} pendingQuestions={deferred} onAnswer={reopenQuestion} />}
    </div>
  );
}

/**
 * Approvals and questions of a running agent. Mounted by the shell, so they
 * appear whichever panel is open (or none).
 */
export function AgentAttention() {
  const phase = useAgentRun((st) => st.phase);
  const questions = useAgentRun((st) => st.run?.questions ?? NO_QUESTIONS);
  const hasApproval = useAgentRun((st) => (st.run?.approvals.length ?? 0) > 0);
  const later = useAgentRun((st) => st.deferred);
  const deferQuestion = useAgentRun((st) => st.deferQuestion);

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
