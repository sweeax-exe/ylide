// Under a finished run: what the agents should do next. "Continue" starts a
// run whose orchestrator is told what this one did (goal, tasks, changed
// files) and that first does the tasks it left open; "New run" in the header
// starts without that.

import { StepForward, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextArea } from '../../components/ui';
import { useApp } from '../../state/app';
import s from './NextStep.module.css';
import { continueBlock, openTaskCount, type RunData } from './run';
import { useAgentRun } from './store';

export function NextStep({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const id = useId();
  const hintId = useId();
  const text = useAgentRun((st) => st.followUp);
  const setText = useAgentRun((st) => st.setFollowUp);
  const continueRun = useAgentRun((st) => st.continueRun);
  const modelReady = useApp((st) => st.server?.status.state === 'ready');
  const project = useApp((st) => st.workspace?.root ?? null);
  const block = continueBlock(run, modelReady, project);
  const canContinue = !block && text.trim().length > 0;
  const open = openTaskCount(run);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focus = useAgentRun((st) => st.focusFollowUp);
  const focused = useAgentRun((st) => st.followUpFocused);

  useEffect(() => {
    if (!focus) return;
    inputRef.current?.focus();
    focused();
  }, [focus, focused]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canContinue) void continueRun(text);
  };

  const blockText = block === 'otherProject' ? t('next.otherProject') : block === 'noProject' ? t('idle.noProject') : block === 'noModel' ? t('idle.noModel') : null;

  return (
    <form className={s.next} onSubmit={submit}>
      <label className={s.label} htmlFor={id}>
        {t('next.label')}
      </label>
      <TextArea
        ref={inputRef}
        id={id}
        className={s.input}
        rows={2}
        value={text}
        placeholder={t('next.placeholder')}
        aria-describedby={hintId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
        }}
        spellCheck
      />
      <div className={s.row}>
        <p id={hintId} className={`${s.hint} ${blockText ? s.blocked : ''}`}>
          {blockText && <TriangleAlert size={13} aria-hidden />}
          {blockText ?? (open > 0 ? t('next.hintOpen', { count: open }) : t('next.hint'))}
        </p>
        <Button type="submit" variant="primary" size="sm" icon={<StepForward size={13} />} disabled={!canContinue}>
          {t('next.continue')}
        </Button>
      </div>
    </form>
  );
}
