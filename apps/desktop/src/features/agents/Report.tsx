// What a finished run did: the orchestrator's summary in the user's language,
// or, when it wrote none (a stopped run, or the model call failed), the task
// list with translated labels.

import { CircleCheck, CircleDashed, CircleMinus, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RunOutcome } from '../../bindings/RunOutcome';
import type { Task } from '../../bindings/Task';
import { Markdown } from '../chat/Markdown';
import s from './Report.module.css';
import { reportLines, type ReportLine } from './run';

export function RunReport({ recap, tasks, outcome, explain = false }: { recap: string | null; tasks: Task[]; outcome: RunOutcome; explain?: boolean }) {
  const { t } = useTranslation('agents');
  if (recap?.trim()) {
    return (
      <div className={s.recap}>
        <Markdown source={recap.trim()} settled />
      </div>
    );
  }
  const lines = reportLines(tasks);
  return (
    <div className={s.report}>
      {explain && outcome !== 'cancelled' && <p className={s.note}>{t('report.noRecap')}</p>}
      {lines.length === 0 ? (
        <p className={s.empty}>{t(outcome === 'cancelled' ? 'report.stoppedBeforePlan' : 'report.noPlan')}</p>
      ) : (
        <ul className={s.tasks}>
          {lines.map((line) => (
            <TaskLine key={line.id} line={line} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskLine({ line }: { line: ReportLine }) {
  const { t } = useTranslation('agents');
  const status = t(`taskStatus.${line.status}`);
  return (
    <li className={s.task}>
      <StatusIcon status={line.status} label={status} />
      <div className={s.body}>
        <span className={s.title}>
          <span className={s.id}>{line.id}</span> {line.title}
        </span>
        {line.result && <span className={s.result}>{line.result}</span>}
        {line.openComments && <span className={s.open}>{t('report.openComments')}</span>}
      </div>
    </li>
  );
}

function StatusIcon({ status, label }: { status: Task['status']; label: string }) {
  const props = { size: 14, 'aria-label': label, role: 'img' as const };
  if (status === 'done') return <CircleCheck {...props} className={s.done} />;
  if (status === 'failed') return <CircleX {...props} className={s.failed} />;
  if (status === 'skipped') return <CircleMinus {...props} className={s.muted} />;
  return <CircleDashed {...props} className={s.muted} />;
}
