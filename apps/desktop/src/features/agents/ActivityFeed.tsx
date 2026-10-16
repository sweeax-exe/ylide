import { Check, ChevronRight, ExternalLink, ListChecks, ShieldCheck, ShieldX, X } from 'lucide-react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentState } from '../../bindings/AgentState';
import type { FileChange } from '../../bindings/FileChange';
import type { MessageKind } from '../../bindings/MessageKind';
import { Badge, IconButton, Spinner, type Tone } from '../../components/ui';
import s from './ActivityFeed.module.css';
import { diffStats, firstChangedLine, parseUnifiedDiff } from './diff';
import { DiffView } from './DiffView';
import { openInEditor, useRoleName } from './hooks';
import { CodeText, FileKindIcon } from './parts';
import type { DecisionFeedItem, FeedItem, MessageFeedItem, PlanFeedItem, RunData, ToolFeedItem } from './run';
import { formatClock, roleColor, summarizeArgs } from './text';

const MESSAGE_TONE: Record<MessageKind, Tone> = { question: 'accent', answer: 'neutral', feedback: 'warning', intervention: 'accent', note: 'neutral' };

/** Entries rendered at first; older ones appear on request, so long runs stay cheap. */
const FEED_WINDOW = 150;

type Pending = 'running' | 'approval' | null;

export function ActivityFeed({ run }: { run: RunData }) {
  const { t } = useTranslation('agents');
  const [limit, setLimit] = useState(FEED_WINDOW);
  // Only an agent's most recent call can still be running.
  const latest = useMemo(() => {
    const ids = new Set<string>();
    const seen = new Set<string>();
    for (let i = run.feed.length - 1; i >= 0; i--) {
      const item = run.feed[i];
      if (item.kind === 'tool' && !seen.has(item.agentId)) {
        seen.add(item.agentId);
        ids.add(item.id);
      }
    }
    return ids;
  }, [run.feed]);
  if (!run.feed.length) return <p className={s.empty}>{t('feed.empty')}</p>;

  const hidden = Math.max(0, run.feed.length - limit);
  const items = hidden ? run.feed.slice(hidden) : run.feed;
  const live = run.outcome === null;
  return (
    <>
      {hidden > 0 && (
        <button type="button" className={s.earlier} onClick={() => setLimit((n) => n + FEED_WINDOW)}>
          {t('feed.earlier', { count: Math.min(hidden, FEED_WINDOW) })}
        </button>
      )}
      <ol className={s.feed}>
        {items.map((item) => {
          const agent = item.kind === 'tool' ? run.agents[item.agentId] : undefined;
          return <FeedRow key={item.id} item={item} startedAt={run.startedAt} role={agent?.role} pending={item.kind === 'tool' ? pendingOf(item, agent?.state, latest.has(item.id) && live) : null} />;
        })}
      </ol>
    </>
  );
}

/** Whether a call without a result is still running or waits for the user. */
function pendingOf(item: ToolFeedItem, state: AgentState | undefined, current: boolean): Pending {
  if (item.result || !item.expectsResult || !current) return null;
  if (state === 'callingTool') return 'running';
  if (state === 'waitingForApproval') return 'approval';
  return null;
}

// Rows only re-render when their own entry changes, not on every event of the run.
const FeedRow = memo(function FeedRow({ item, startedAt, role, pending }: { item: FeedItem; startedAt: number; role: string | undefined; pending: Pending }) {
  return (
    <li className={s.item}>
      <span className={s.time}>{formatClock(item.at - startedAt)}</span>
      <div className={s.content}>
        <FeedEntry item={item} role={role} pending={pending} />
      </div>
    </li>
  );
});

function FeedEntry({ item, role, pending }: { item: FeedItem; role: string | undefined; pending: Pending }) {
  switch (item.kind) {
    case 'tool':
      return <ToolEntry item={item} role={role} pending={pending} />;
    case 'message':
      return <MessageEntry item={item} />;
    case 'plan':
      return <PlanEntry item={item} />;
    case 'decision':
      return <DecisionEntry item={item} />;
  }
}

function AgentTag({ agentId, role }: { agentId: string; role?: string }) {
  const roleName = useRoleName();
  return (
    <span className={s.agent}>
      <span className={s.dot} style={{ background: roleColor(role ?? agentId) }} aria-hidden />
      {roleName(agentId)}
    </span>
  );
}

function ToolEntry({ item, role, pending }: { item: ToolFeedItem; role: string | undefined; pending: Pending }) {
  const { t } = useTranslation('agents');
  const args = summarizeArgs(item.arguments);
  const r = item.result;
  return (
    <div className={s.entry}>
      <div className={s.line}>
        <AgentTag agentId={item.agentId} role={role} />
        {item.tool && <code className={s.tool}>{item.tool}</code>}
        {args && (
          <span className={s.args} title={args}>
            {args}
          </span>
        )}
      </div>
      {r ? (
        <div className={`${s.result} ${r.ok ? s.ok : s.fail}`}>
          {r.ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
          <span className="visually-hidden">{r.rejected ? t('feed.rejected') : r.ok ? t('feed.ok') : t('feed.failed')}</span>
          <span className={s.resultText}>
            {r.rejected ? (r.summary ? t('feed.rejectedReason', { reason: r.summary }) : t('feed.rejected')) : <CodeText text={r.summary} />}
          </span>
        </div>
      ) : (
        pending && (
          <div className={`${s.result} ${s.pending}`}>
            {pending === 'running' && <Spinner />}
            <span className={s.resultText}>{pending === 'running' ? t('feed.running') : t('feed.awaitingApproval')}</span>
          </div>
        )
      )}
      {r?.change && <ChangeRow change={r.change} />}
    </div>
  );
}

function ChangeRow({ change }: { change: FileChange }) {
  const { t } = useTranslation('agents');
  const [open, setOpen] = useState(false);
  const files = useMemo(() => parseUnifiedDiff(change.diff), [change.diff]);
  const stats = diffStats(files);
  const line = firstChangedLine(files);
  return (
    <div className={s.change}>
      <div className={s.changeHead}>
        <button type="button" className={s.changeToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)} title={t(open ? 'feed.hideDiff' : 'feed.showDiff', { path: change.path })}>
          <ChevronRight size={13} className={open ? s.chevronOpen : s.chevron} aria-hidden />
          <FileKindIcon kind={change.kind} size={13} />
          <span className={s.path}>{change.path}</span>
          <span className={s.stats}>
            <span className={s.add}>+{stats.additions}</span>
            <span className={s.del}>−{stats.deletions}</span>
          </span>
          <span className="visually-hidden">{t(`changeKind.${change.kind}`)}</span>
        </button>
        {change.kind !== 'deleted' && (
          <IconButton label={t('feed.openFile')} onClick={() => openInEditor(change.path, line)} className={s.open}>
            <ExternalLink size={13} />
          </IconButton>
        )}
      </div>
      {open && <DiffView diff={change.diff} files={files} maxHeight={360} />}
    </div>
  );
}

function MessageEntry({ item }: { item: MessageFeedItem }) {
  const { t } = useTranslation('agents');
  const m = item.message;
  return (
    <div className={s.entry}>
      <div className={s.line}>
        <AgentTag agentId={m.from} />
        <span className={s.arrow} aria-hidden>
          →
        </span>
        <span className="visually-hidden">{t('feed.to')}</span>
        <AgentTag agentId={m.to} />
        <Badge tone={MESSAGE_TONE[m.kind]}>{t(`messageKind.${m.kind}`)}</Badge>
        {m.taskId && <span className={s.taskRef}>{m.taskId}</span>}
      </div>
      <Expandable text={m.content} />
    </div>
  );
}

function PlanEntry({ item }: { item: PlanFeedItem }) {
  const { t } = useTranslation('agents');
  return (
    <div className={s.entry}>
      <div className={s.line}>
        <AgentTag agentId="orchestrator" />
        <span className={s.event}>
          <ListChecks size={13} aria-hidden />
          {t('feed.plan', { count: item.taskCount })}
        </span>
      </div>
      {item.summary && <Expandable text={item.summary} />}
    </div>
  );
}

function DecisionEntry({ item }: { item: DecisionFeedItem }) {
  const { t } = useTranslation('agents');
  const rejected = item.decision === 'reject';
  const text = item.decision === 'approveAlways' ? t('feed.approvedAlways', { tool: item.tool, title: item.title }) : t(rejected ? 'feed.rejectedAction' : 'feed.approved', { title: item.title });
  return (
    <div className={s.entry}>
      <div className={`${s.line} ${s.decision} ${rejected ? s.fail : s.ok}`}>
        {rejected ? <ShieldX size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
        <span className={s.decisionText}>
          <CodeText text={text} />
        </span>
      </div>
      {item.reason && <p className={s.reason}>{t('feed.reason', { reason: item.reason })}</p>}
    </div>
  );
}

/** Long text, clamped to a few lines until the user expands it. */
function Expandable({ text }: { text: string }) {
  const { t } = useTranslation('agents');
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && !open) setOverflowing(node.scrollHeight > node.clientHeight + 1);
  }, [text, open]);
  return (
    <div className={s.expandable}>
      <p ref={ref} className={`${s.text} ${open ? '' : s.clamped}`}>
        {text}
      </p>
      {(overflowing || open) && (
        <button type="button" className={s.more} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('feed.showLess') : t('feed.showMore')}
        </button>
      )}
    </div>
  );
}
