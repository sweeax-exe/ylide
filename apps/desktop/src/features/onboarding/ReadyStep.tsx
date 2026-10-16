import { FolderOpen, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServerInfo } from '../../bindings/ServerInfo';
import { Braid } from '../../components/Braid';
import { Button, Kbd } from '../../components/ui';
import { errorText, reportError } from '../../lib/errors';
import { formatNumber, formatTokens } from '../../lib/format';
import { api, pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { hostOf } from './endpoint';
import type { ModelPath } from './flow';
import { currentServer, readyStatus } from './ready';
import s from './ReadyStep.module.css';
import { StepLayout } from './StepLayout';

interface ReadyStepProps {
  path: ModelPath;
  /** Back to the model step, e.g. after the model failed to start. */
  onChangeModel: () => void;
  onDone: () => void;
}

export function ReadyStep({ path, onChangeModel, onDone }: ReadyStepProps) {
  const { t } = useTranslation('onboarding');
  const registry = useApp((st) => st.registry);
  const server = useApp((st) => st.server);
  const updateSettings = useApp((st) => st.updateSettings);
  const openWorkspace = useApp((st) => st.openWorkspace);
  const [returned, setReturned] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [opening, setOpening] = useState(false);
  const started = useRef(false);
  // The store's server value when the current start request was sent (see currentServer).
  const [staleAtStart, setStaleAtStart] = useState<ServerInfo | null>(() => useApp.getState().server);
  // Saving the model choice; finishing waits for it so onboardingDone cannot overwrite it.
  const saving = useRef<Promise<void>>(Promise.resolve());

  const modelId = path.kind === 'registry' ? path.candidate.modelId : path.kind === 'imported' ? path.model.modelId : null;
  const quant = path.kind === 'registry' ? path.candidate.quant : path.kind === 'imported' ? path.model.quant : null;

  const start = useCallback(async () => {
    setError(null);
    setReturned(null);
    setPending(true);
    setStaleAtStart(useApp.getState().server);
    try {
      if (modelId !== null && quant !== null) {
        const selection = { modelId, quant };
        saving.current = updateSettings((d) => {
          d.models.chat = selection;
          d.endpoint.enabled = false;
        });
        await saving.current;
        setReturned(await api.server.start(selection));
      } else {
        setReturned(await api.server.start());
      }
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }, [modelId, quant, updateSettings]);

  useEffect(() => {
    // Start once; a strict-mode re-run must not restart the server.
    if (started.current) return;
    started.current = true;
    void start();
  }, [start]);

  const finish = () => {
    // A failed save was already shown as the start error; finishing must not hang on it.
    void saving.current.catch(() => undefined).then(onDone);
  };

  const live = currentServer(server, staleAtStart, returned);
  const status = readyStatus(live, error !== null);
  const external = path.kind === 'external';
  const name =
    path.kind === 'registry'
      ? (registry?.models.find((m) => m.id === path.candidate.modelId)?.name ?? path.candidate.modelId)
      : path.kind === 'imported'
        ? path.model.name
        : (path.model ?? hostOf(path.baseUrl));

  const failure = error !== null ? errorText(error) : live?.status.state === 'crashed' ? live.status.message : status === 'failed' ? t('ready.stoppedBody') : null;
  const exitCode = live?.status.state === 'crashed' ? live.status.code : null;

  const openFolder = async () => {
    setOpening(true);
    try {
      const dir = await pickFolder();
      if (!dir) return;
      await openWorkspace(dir);
      finish();
    } catch (e) {
      reportError(e);
    } finally {
      setOpening(false);
    }
  };

  const title =
    status === 'ready'
      ? t('ready.titleReady', { model: name })
      : status === 'failed'
        ? external
          ? t('ready.titleUnreachable')
          : t('ready.titleFailed')
        : external
          ? t('ready.titleConnecting', { model: name })
          : t('ready.titleStarting', { model: name });

  return (
    <StepLayout
      title={title}
      lead={status === 'failed' ? undefined : path.kind === 'external' ? t('ready.leadExternal', { host: hostOf(path.baseUrl) }) : t('ready.lead')}
      note={status === 'starting' || status === 'loading' ? t('ready.background') : undefined}
      actions={
        <>
          <Button variant="ghost" size="lg" onClick={finish}>
            {t('ready.skipFolder')}
          </Button>
          <Button variant="primary" size="lg" icon={<FolderOpen size={16} aria-hidden />} loading={opening} onClick={openFolder}>
            {t('common:actions.openFolder')}
          </Button>
        </>
      }
    >
      <section className={s.sheet} aria-label={t('ready.statusLabel')}>
        <div className={`${s.status} ${s[status]}`} role="status">
          {status === 'starting' || status === 'loading' ? <Braid active size={14} /> : <span className={s.dot} aria-hidden />}
          <span className={s.statusText}>{external && status === 'starting' ? t('ready.status.connecting') : t(`ready.status.${status}`)}</span>
        </div>
        {status === 'failed' && (
          <div className={s.failure} role="alert">
            {failure && <p className={s.message}>{failure}</p>}
            {exitCode !== null && <p className={s.code}>{t('ready.exitCode', { code: exitCode })}</p>}
            <div className={s.failureActions}>
              <Button icon={<RotateCw size={13} aria-hidden />} loading={pending} onClick={() => void start()}>
                {t('ready.retry')}
              </Button>
              <Button variant="ghost" onClick={onChangeModel}>
                {external ? t('ready.changeServer') : t('ready.changeModel')}
              </Button>
            </div>
          </div>
        )}
        {live && status !== 'failed' && (
          <dl className={s.details}>
            {external ? (
              <Detail label={t('ready.detail.address')} value={path.kind === 'external' ? path.baseUrl : ''} />
            ) : (
              <>
                <Detail label={t('ready.detail.runtime')} value={live.runtime} />
                {live.device && <Detail label={t('ready.detail.device')} value={live.device} />}
              </>
            )}
            {/* External servers may not report these. */}
            {live.context > 0 && <Detail label={t('ready.detail.context')} value={t('ready.tokens', { value: formatTokens(live.context) })} />}
            {live.slots > 0 && <Detail label={t('ready.detail.slots')} value={formatNumber(live.slots)} />}
          </dl>
        )}
      </section>

      <section className={s.tips} aria-labelledby="onboarding-tips">
        <h2 id="onboarding-tips" className={s.tipsTitle}>
          {t('ready.tipsTitle')}
        </h2>
        <ul className={s.tipList}>
          <Tip keys={['Ctrl', 'L']} text={t('ready.tip.chat')} />
          <Tip keys={['Ctrl', 'K']} text={t('ready.tip.inline')} />
          <Tip keys={['Ctrl', 'Shift', 'A']} text={t('ready.tip.agents')} />
          <Tip keys={['Ctrl', 'P']} text={t('ready.tip.quickOpen')} />
        </ul>
      </section>
    </StepLayout>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.detail}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Tip({ keys, text }: { keys: string[]; text: string }) {
  return (
    <li className={s.tip}>
      <span className={s.keys}>
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      <span>{text}</span>
    </li>
  );
}
