import { MessageSquarePlus, Send, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Braid } from '../../components/Braid';
import { Button, IconButton, TextInput } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { useApp } from '../../state/app';
import s from './AgentList.module.css';
import { useRoleName } from './hooks';
import { CodeText } from './parts';
import type { AgentInfo } from './run';
import { useAgentRun } from './store';
import { roleColor } from './text';
import { laneOrder, segmentKind } from './layout';

/** Backend step texts that only repeat the state, or have a translation. */
function useStepText() {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  return (step: string): string | null => {
    const text = step.trim();
    if (!text || text === 'thinking' || text === 'paused' || text === 'finished') return null;
    if (text === 'plan ready') return t('steps.planReady');
    if (text === 'reviewing diff') return t('steps.reviewing');
    if (text === 'step limit reached') return t('steps.stepLimit');
    if (text === 'updating project notes') return t('steps.notes');
    const answering = /^answering (\S+)$/.exec(text);
    if (answering) return t('steps.answering', { agent: roleName(answering[1]) });
    return text;
  };
}

export function AgentList() {
  const { t } = useTranslation('agents');
  const run = useAgentRun((st) => st.run);
  const reviewEnabled = useApp((st) => st.settings?.agent.reviewEnabled ?? true);
  if (!run) return null;
  const ids = laneOrder(run, reviewEnabled)
    .map((l) => l.agentId)
    .filter((id) => run.agents[id]);
  const live = run.outcome === null;
  return (
    <section className={s.section} aria-label={t('agents.heading')}>
      {ids.length === 0 ? (
        <p className={s.waiting}>{t('agents.waiting')}</p>
      ) : (
        <ul className={s.list}>
          {ids.map((id) => (
            <AgentRow key={id} info={run.agents[id]} live={live} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentRow({ info, live }: { info: AgentInfo; live: boolean }) {
  const { t } = useTranslation('agents');
  const roleName = useRoleName();
  const stepText = useStepText();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const name = roleName(info.agentId);
  const kind = segmentKind(info.state);
  const step = stepText(info.step);
  const generating = live && info.state === 'thinking';
  // Only this row subscribes to the streamed text, so tokens re-render nothing else.
  const stream = useAgentRun((st) => (generating ? (st.streams[info.agentId] ?? '') : ''));
  const tail = stream.replace(/\s+/g, ' ').trim().slice(-140);
  const speed = info.tokensPerSecond > 0 ? info.tokensPerSecond : info.lastTokensPerSecond;

  useEffect(() => {
    if (!sent) return;
    const id = window.setTimeout(() => setSent(false), 5000);
    return () => window.clearTimeout(id);
  }, [sent]);

  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  return (
    <li className={`${s.agent} ${s[`kind-${kind}`]}`}>
      <span className={s.swatch} style={{ background: roleColor(info.role) }} aria-hidden />
      <div className={s.body}>
        <div className={s.top}>
          <span className={s.name}>{name}</span>
          <span className={s.state}>
            {generating && <Braid active size={9} />}
            {t(`states.${info.state}`)}
          </span>
          <span className={s.metrics}>
            <span className={generating ? s.metricLive : undefined} title={t('agents.speedTitle')}>
              {speed > 0 ? t('agents.speed', { value: formatNumber(speed, speed < 10 ? 1 : 0) }) : '–'}
            </span>
            <span title={t('agents.tokensTitle')}>{t('agents.tokens', { value: formatNumber(info.totalTokens) })}</span>
          </span>
        </div>
        <div className={s.bottom}>
          <span className={s.step}>
            {info.taskId && <span className={s.taskRef}>{info.taskId}</span>}
            {step && (
              <span className={s.stepText}>
                <CodeText text={step} />
              </span>
            )}
          </span>
          {live && (
            <Button variant="ghost" size="sm" icon={<MessageSquarePlus size={13} />} aria-expanded={open} onClick={() => setOpen((v) => !v)} className={s.intervene}>
              {t('agents.intervene')}
            </Button>
          )}
        </div>
        {tail && (
          <div className={s.stream} aria-hidden>
            <span>{tail}</span>
          </div>
        )}
        {open && (
          <InterveneForm
            agentId={info.agentId}
            name={name}
            onDone={() => {
              setOpen(false);
              setSent(true);
            }}
            onCancel={() => setOpen(false)}
          />
        )}
        {sent && (
          <p className={s.sent} role="status">
            {t('agents.interveneSent', { agent: name })}
          </p>
        )}
      </div>
    </li>
  );
}

function InterveneForm({ agentId, name, onDone, onCancel }: { agentId: string; name: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation('agents');
  const intervene = useAgentRun((st) => st.intervene);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await intervene(agentId, text);
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <form className={s.form} onSubmit={submit}>
      <TextInput
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder={t('agents.intervenePlaceholder', { agent: name })}
        aria-label={t('agents.intervenePlaceholder', { agent: name })}
        spellCheck
      />
      <Button type="submit" variant="primary" size="sm" icon={<Send size={13} />} loading={busy} disabled={!text.trim()}>
        {t('common:actions.send')}
      </Button>
      <IconButton type="button" label={t('common:actions.cancel')} onClick={onCancel}>
        <X size={14} />
      </IconButton>
    </form>
  );
}
