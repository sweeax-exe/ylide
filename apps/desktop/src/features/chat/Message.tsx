import { ChevronRight, CircleAlert, RotateCcw } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextItem } from '../../bindings/ContextItem';
import type { Mention } from '../../bindings/Mention';
import { Braid } from '../../components/Braid';
import { ImageStrip } from '../../components/ImageInput';
import { Button } from '../../components/ui';
import { errorText } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { IpcError } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { focusComposer } from './composerFocus';
import type { AssistantTurn, UserTurn } from './conversation';
import { ContextChip, type ChipData } from './ContextChip';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import s from './Message.module.css';
import { mentionKey, mentionLabel, mentionPath } from './mentions';
import { openInEditor } from './projectPaths';
import { useChat } from './store';

function itemChip(item: ContextItem): ChipData {
  return { kind: item.kind, label: item.label, tokens: item.tokens, truncated: item.truncated, error: item.error };
}

function mentionChip(m: Mention, projectName: string): ChipData {
  return { kind: m.type, label: mentionLabel(m, projectName), tokens: null, truncated: false, error: null };
}

function mentionLine(m: Mention): number | undefined {
  if (m.type === 'selection') return m.startLine;
  if (m.type === 'symbol') return m.line ?? undefined;
  return undefined;
}

/** Context of a sent message: resolved items once the core reported them, the mentions until then. */
function SentContext({ turn }: { turn: UserTurn }) {
  const { t } = useTranslation('chat');
  const projectName = useApp((st) => st.workspace?.name ?? '');
  if (!turn.mentions.length && !turn.context?.length) return null;
  const chips = turn.context
    ? turn.context.map((item, i) => {
        const mention = turn.mentions[i];
        const line = mention ? mentionLine(mention) : undefined;
        const path = item.kind !== 'folder' && !item.error ? item.path : null;
        const chip = itemChip(item);
        // The project root reads better by its name than by an empty folder label.
        if (mention?.type === 'folder' && mention.path === '') chip.label = mentionLabel(mention, projectName);
        return { key: `${i}:${item.label}`, chip, path, line };
      })
    : turn.mentions.map((m) => ({ key: mentionKey(m), chip: mentionChip(m, projectName), path: mentionPath(m), line: mentionLine(m) }));
  // Without an open project the core resolves nothing.
  if (!chips.length) return null;
  return (
    <div className={s.context} role="list" aria-label={t('context.label')}>
      {chips.map(({ key, chip, path, line }) => (
        <ContextChip key={key} chip={chip} title={path ?? undefined} onOpen={path ? () => openInEditor(path, line) : undefined} />
      ))}
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ turn }: { turn: UserTurn }) {
  const { t } = useTranslation('chat');
  return (
    <article className={s.user}>
      <h3 className="visually-hidden">{t('messages.you')}</h3>
      <SentContext turn={turn} />
      <ImageStrip images={turn.images} />
      {turn.content && <p className={s.userText}>{turn.content}</p>}
    </article>
  );
});

function seconds(ms: number): string {
  return `${formatNumber(ms / 1000, ms < 10_000 ? 1 : 0)} s`;
}

function Thinking({ turn }: { turn: AssistantTurn }) {
  const { t } = useTranslation('chat');
  const id = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = turn.status === 'streaming' && !turn.content;
  // Open while the model thinks, collapsed once the answer starts; a click overrides that.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;

  useEffect(() => {
    const el = bodyRef.current;
    if (active && el) el.scrollTop = el.scrollHeight;
  }, [active, turn.reasoning]);

  const label = active ? t('messages.thinking') : turn.reasoningMs !== null ? t('messages.thoughtFor', { duration: seconds(turn.reasoningMs) }) : t('messages.thoughts');
  return (
    <div className={s.thinking}>
      <button type="button" className={s.thinkingToggle} aria-expanded={open} aria-controls={id} onClick={() => setOverride(!open)}>
        <Braid active={active} size={10} />
        <span>{label}</span>
        <ChevronRight size={14} className={`${s.chevron} ${open ? s.chevronOpen : ''}`} aria-hidden />
      </button>
      <div id={id} ref={bodyRef} className={s.thinkingBody} hidden={!open}>
        {turn.reasoning}
      </div>
    </div>
  );
}

function Metrics({ turn }: { turn: AssistantTurn }) {
  const { t } = useTranslation('chat');
  const { usage, timings } = turn;
  const details = timings
    ? t('messages.timings', { prompt: seconds(timings.promptMs), promptSpeed: formatNumber(timings.promptTokensPerSecond), generation: seconds(timings.generationMs) })
    : undefined;
  return (
    <div className={s.footer}>
      <span className={s.metrics} title={details}>
        {timings && timings.generationTokensPerSecond > 0 && <span>{t('common:units.tokPerSec', { value: formatNumber(timings.generationTokensPerSecond, 1) })}</span>}
        {usage && <span>{t('messages.promptTokens', { value: formatNumber(usage.promptTokens) })}</span>}
        {usage && <span>{t('messages.cachedTokens', { value: formatNumber(usage.cachedTokens) })}</span>}
      </span>
      {turn.content && <CopyButton text={turn.content} label={t('messages.copyAnswer')} />}
    </div>
  );
}

function Failure({ turn, canRetry }: { turn: AssistantTurn; canRetry: boolean }) {
  const { t } = useTranslation('chat');
  const retry = useChat((st) => st.retry);
  const busy = useChat((st) => st.activeRequestId !== null);
  return (
    <div className={s.error} role="alert">
      <CircleAlert size={15} className={s.errorIcon} aria-hidden />
      <span className={s.errorText}>{errorText(new IpcError(turn.error ?? { code: 'generic', message: '' }))}</span>
      {canRetry && (
        <Button
          size="sm"
          icon={<RotateCcw size={13} />}
          onClick={() => {
            retry(turn.id);
            // The alert with this button goes away; keep the keyboard in the chat.
            focusComposer();
          }}
          disabled={busy}
        >
          {t('common:actions.retry')}
        </Button>
      )}
    </div>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ turn, last }: { turn: AssistantTurn; last: boolean }) {
  const { t } = useTranslation('chat');
  const streaming = turn.status === 'streaming';
  const waiting = streaming && !turn.content && !turn.reasoning;
  return (
    <article className={s.assistant} aria-busy={streaming}>
      <h3 className="visually-hidden">{t('messages.assistant')}</h3>
      {turn.reasoning && <Thinking turn={turn} />}
      {waiting && (
        <p className={s.waiting}>
          <Braid active size={10} />
          {t('messages.waiting')}
        </p>
      )}
      {turn.content && <Markdown source={turn.content} settled={!streaming} />}
      {turn.status === 'done' && !turn.content.trim() && <p className={s.note}>{t('messages.empty')}</p>}
      {turn.status === 'cancelled' && <p className={s.note}>{t('messages.cancelled')}</p>}
      {turn.finishReason === 'length' && <p className={`${s.note} ${s.warning}`}>{t('messages.cutOff')}</p>}
      {turn.status === 'error' && <Failure turn={turn} canRetry={last} />}
      {(turn.status === 'done' || turn.status === 'cancelled') && (turn.usage || turn.timings || turn.content) && <Metrics turn={turn} />}
    </article>
  );
});
