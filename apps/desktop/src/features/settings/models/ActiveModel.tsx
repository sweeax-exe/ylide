// The running model: what it is, where it runs, and exactly how it was started.

import { Check, ChevronRight, Copy, Play, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerInfo } from '../../../bindings/ServerInfo';
import type { ToolCallSupport } from '../../../bindings/ToolCallSupport';
import { Braid } from '../../../components/Braid';
import { Badge, Button, IconButton, type Tone } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatTokens } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { modelName, useApp } from '../../../state/app';
import { commandLine } from '../logic/commands';
import { keepFocusInSection } from '../page/focus';
import s from './ActiveModel.module.css';
import { ServerLog } from './ServerLog';
import { UncensoredBadge } from './Uncensored';

const TOOL_TONE: Record<ToolCallSupport, Tone> = { unknown: 'neutral', native: 'success', repaired: 'warning', failed: 'danger' };

export function ActiveModel() {
  const { t } = useTranslation('settings');
  const server = useApp((st) => st.server);
  const settings = useApp((st) => st.settings);
  const registry = useApp((st) => st.registry);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);

  const run = async (action: 'start' | 'stop', from: HTMLElement) => {
    // Start and Stop replace each other; keep focus on whichever is shown.
    const restoreFocus = keepFocusInSection(from);
    setBusy(action);
    try {
      if (action === 'start') await api.server.start();
      else await api.server.stop();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
      restoreFocus();
    }
  };

  const state = server?.status.state;
  const running = state === 'starting' || state === 'loading' || state === 'ready';
  const selection = settings?.models.chat ?? null;
  const endpoint = settings?.endpoint.enabled ? settings.endpoint : null;
  const canStart = !!selection || !!endpoint;

  const startStop = running ? (
    <Button icon={<Square size={13} />} loading={busy === 'stop'} onClick={(e) => void run('stop', e.currentTarget)}>
      {t('common:server.stop')}
    </Button>
  ) : (
    <Button variant="primary" icon={<Play size={13} />} loading={busy === 'start'} disabled={!canStart} onClick={(e) => void run('start', e.currentTarget)}>
      {state === 'crashed' || state === 'stopped' ? t('active.startAgain') : t('common:server.start')}
    </Button>
  );

  if (!server) {
    return (
      <div className={s.card}>
        <div className={s.head}>
          <span className={s.dot} aria-hidden />
          <div className={s.headText}>
            <div className={s.title}>{t('active.none')}</div>
            <div className={s.sub}>
              {endpoint
                ? t('active.noneEndpoint', { url: endpoint.baseUrl })
                : selection
                  ? t('active.noneSelected', { model: modelName(registry, selection.modelId), quant: selection.quant })
                  : t('active.noneChoose')}
            </div>
          </div>
          {startStop}
        </div>
      </div>
    );
  }

  const entry = registry?.models.find((m) => m.id === server.modelId);

  return (
    <div className={s.card}>
      <div className={s.head}>
        <StatusIndicator server={server} />
        <div className={s.headText}>
          <div className={s.titleLine}>
            <span className={s.title}>{server.modelName}</span>
            {entry?.uncensored && <UncensoredBadge />}
            {server.quant && <Badge tone="metal">{server.quant}</Badge>}
          </div>
          <div className={s.sub} role="status" aria-live="polite">
            {t(`active.status.${server.status.state}`)}
            {server.status.state === 'crashed' && (
              <span className={s.crash}>
                {' · '}
                {server.status.code !== null ? t('active.exitCode', { code: server.status.code, message: server.status.message }) : server.status.message}
              </span>
            )}
          </div>
        </div>
        {startStop}
      </div>

      <dl className={s.metrics}>
        <Metric label={t('active.runtime')}>{server.runtime === 'external' ? t('common:server.external') : server.runtime}</Metric>
        <Metric label={t('active.device')} metal>
          {server.device ?? t('active.noDevice')}
        </Metric>
        <Metric label={t('active.context')}>{t('active.contextValue', { tokens: formatTokens(server.context) })}</Metric>
        <Metric label={t('active.slots')}>{server.slots}</Metric>
        <Metric label={t('active.toolCalls')}>
          <Badge tone={TOOL_TONE[server.toolCalls]}>{t(`active.tools.${server.toolCalls}.label`)}</Badge>
        </Metric>
      </dl>
      <p className={s.toolsExplain}>{t(`active.tools.${server.toolCalls}.body`)}</p>

      <Disclosure title={t('active.commandLine')} hint={t('active.commandLineHint')}>
        <CommandLine command={server.command} />
      </Disclosure>
      <Disclosure title={t('active.log')} hint={t('active.logHint')}>
        <ServerLog />
      </Disclosure>
    </div>
  );
}

function StatusIndicator({ server }: { server: ServerInfo }) {
  const { t } = useTranslation('settings');
  const state = server.status.state;
  if (state === 'starting' || state === 'loading') return <Braid active size={14} label={t(`active.status.${state}`)} />;
  return <span className={`${s.dot} ${state === 'ready' ? s.ready : state === 'crashed' ? s.crashed : ''}`} aria-hidden />;
}

function Metric({ label, children, metal }: { label: string; children: ReactNode; metal?: boolean }) {
  return (
    <div className={s.metric}>
      <dt>{label}</dt>
      <dd className={metal ? s.metal : undefined}>{children}</dd>
    </div>
  );
}

/** A native disclosure; its content mounts only while open (the log loads on demand). */
function Disclosure({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={s.disclosure} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={s.summary}>
        <ChevronRight size={14} className={s.chevron} aria-hidden />
        <span className={s.summaryTitle}>{title}</span>
        <span className={s.summaryHint}>{hint}</span>
      </summary>
      {open && <div className={s.disclosureBody}>{children}</div>}
    </details>
  );
}

function CommandLine({ command }: { command: string[] }) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (command.length === 0) return <div className={s.logState}>{t('active.noCommand')}</div>;
  const text = commandLine(command);
  return (
    <div className={s.command}>
      <pre className={`${s.commandText} selectable`}>{text}</pre>
      <IconButton
        label={copied ? t('common:actions.copied') : t('active.copyCommand')}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          } catch (e) {
            reportError(e);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </div>
  );
}
