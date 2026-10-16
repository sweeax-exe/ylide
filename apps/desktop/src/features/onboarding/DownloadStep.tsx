import { CircleCheck, Pause, Play, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DownloadJob } from '../../bindings/DownloadJob';
import { Dialog } from '../../components/Dialog';
import { Button, Progress, type Segment } from '../../components/ui';
import { errorText, reportError } from '../../lib/errors';
import { formatBytes, formatDuration, formatGB, formatNumber } from '../../lib/format';
import { api, IpcError } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { jobStage, latestJob, parseVariant, runtimeBusy, runtimeSource, type Started, type TransferView, transferView } from './download';
import s from './DownloadStep.module.css';
import type { ModelPath } from './flow';
import { StepLayout } from './StepLayout';

type RegistryPath = Extract<ModelPath, { kind: 'registry' }>;

interface DownloadStepProps {
  path: RegistryPath;
  /** Back to the model choice (after cancelling, or with a paused download kept). */
  onBack: () => void;
  onNext: () => void;
}

export function DownloadStep({ path, onBack, onNext }: DownloadStepProps) {
  const { t } = useTranslation('onboarding');
  const model = useModelTask(path);
  const runtime = useRuntimeTask(path.runtimeVariant);
  const allDone = model.done && runtime.done;

  return (
    <StepLayout
      title={allDone ? t('download.titleDone') : t('download.title')}
      lead={allDone && !runtime.skipped ? t('download.leadDone') : t('download.lead')}
      onBack={model.busy ? undefined : onBack}
      note={allDone ? undefined : t('download.note')}
      actions={
        <Button variant="primary" size="lg" disabled={!allDone} onClick={onNext}>
          {t('common:actions.continue')}
        </Button>
      }
    >
      <div className={s.tasks}>
        {path.needsModel && <ModelCard path={path} task={model} onCancelled={onBack} />}
        {path.runtimeVariant && <RuntimeCard variant={path.runtimeVariant} task={runtime} />}
      </div>
    </StepLayout>
  );
}

// ------------------------------------------------------------------ model

interface ModelTask {
  job: DownloadJob | null;
  error: unknown;
  done: boolean;
  /** A transfer is in progress (pausing or cancelling is possible). */
  busy: boolean;
  /** A start or resume request has been sent and not answered yet. */
  requesting: boolean;
  start(): void;
  pause(): void;
  cancel(): Promise<void>;
}

function useModelTask(path: RegistryPath): ModelTask {
  const { modelId, quant } = path.candidate;
  const downloads = useApp((st) => st.downloads);
  const installedNow = useApp((st) => st.installed.some((m) => m.modelId === modelId && m.quant === quant));
  const [first, setFirst] = useState<Started | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [requesting, setRequesting] = useState(false);
  const started = useRef(false);

  const start = useCallback(() => {
    setError(null);
    setRequesting(true);
    api.models
      .download(modelId, quant)
      // The store still holds the job as it was before (paused, failed) until the next event arrives.
      .then((job) => setFirst({ job, stale: useApp.getState().downloads[job.jobId] }))
      .catch((e: unknown) => setError(e))
      .finally(() => setRequesting(false));
  }, [modelId, quant]);

  useEffect(() => {
    // Guarded so a re-run of the effect (React strict mode) does not start a second transfer.
    if (!path.needsModel || started.current) return;
    started.current = true;
    start();
  }, [path.needsModel, start]);

  const job = latestJob(first, first ? downloads[first.job.jobId] : undefined);
  const stage = jobStage(job);
  return {
    job,
    error,
    done: !path.needsModel || stage === 'completed' || (installedNow && !job),
    busy: path.needsModel && error === null && (stage === 'running' || stage === 'starting'),
    requesting,
    start,
    pause: () => {
      if (job) api.models.pause(job.jobId).catch((e: unknown) => reportError(e));
    },
    cancel: async () => {
      if (job) await api.models.cancel(job.jobId);
    },
  };
}

function ModelCard({ path, task, onCancelled }: { path: RegistryPath; task: ModelTask; onCancelled: () => void }) {
  const { t } = useTranslation('onboarding');
  const registry = useApp((st) => st.registry);
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const closeConfirm = useCallback(() => setConfirm(false), []);
  const model = registry?.models.find((m) => m.id === path.candidate.modelId);
  const { job } = task;
  const stage = task.error ? 'failed' : jobStage(job);
  const view = transferView(job?.progress ?? null, job?.totalBytes ?? path.candidate.downloadBytes);
  const done = stage === 'completed';

  const phase =
    task.error !== null
      ? t('download.phase.failed')
      : stage === 'completed'
        ? t('download.phase.verified')
        : stage === 'paused'
          ? t('download.phase.paused')
          : stage === 'failed'
            ? t('download.phase.failed')
            : stage === 'cancelled'
              ? t('download.phase.cancelled')
              : stage === 'starting' || view.phase === 'starting'
                ? t('download.phase.starting')
                : t(`download.phase.${view.phase}`);

  const doCancel = async () => {
    setCancelling(true);
    try {
      await task.cancel();
      setConfirm(false);
      onCancelled();
    } catch (e) {
      reportError(e);
    } finally {
      setCancelling(false);
    }
  };

  // A job can also end elsewhere, e.g. cancelled in the model settings.
  const failure: Problem | null =
    task.error !== null
      ? problemOf(task.error)
      : job?.state.state === 'failed'
        ? { message: t('download.stopped', { message: job.state.message }), blocked: false }
        : job?.state.state === 'cancelled'
          ? { message: t('download.cancelled'), blocked: false }
          : null;

  return (
    <TaskCard
      label={t('download.model')}
      title={
        <>
          {model?.name ?? path.candidate.modelId} <code className={s.quant}>{path.candidate.quant}</code>
        </>
      }
      source={model ? t('download.from', { source: `huggingface.co/${model.source.hfRepo}` }) : null}
      view={done ? { ...view, fraction: 1, doneBytes: view.totalBytes } : view}
      tone={done ? 'success' : stage === 'paused' ? 'muted' : failure !== null ? 'danger' : 'accent'}
      phase={phase}
      done={done}
      running={stage === 'running'}
      controls={
        !done &&
        failure === null && (
          <>
            {stage === 'paused' ? (
              <Button size="sm" icon={<Play size={13} aria-hidden />} loading={task.requesting} onClick={task.start}>
                {t('download.resume')}
              </Button>
            ) : (
              <Button size="sm" icon={<Pause size={13} aria-hidden />} disabled={stage !== 'running'} onClick={task.pause}>
                {t('download.pause')}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<X size={13} aria-hidden />} disabled={!job} onClick={() => setConfirm(true)}>
              {t('download.cancel')}
            </Button>
          </>
        )
      }
    >
      {failure !== null && <Failure problem={failure} purpose="model" retrying={task.requesting} onRetry={task.start} />}
      <Dialog
        open={confirm}
        onClose={closeConfirm}
        title={t('download.confirmTitle')}
        width={440}
        footer={
          <>
            <Button variant="ghost" data-autofocus onClick={closeConfirm}>
              {t('download.keep')}
            </Button>
            <Button variant="danger" loading={cancelling} onClick={doCancel}>
              {t('download.cancel')}
            </Button>
          </>
        }
      >
        {t('download.confirmBody')}
      </Dialog>
    </TaskCard>
  );
}

// ------------------------------------------------------------------ runtime

interface RuntimeTask {
  done: boolean;
  /** The user chose to continue without it after a failure. */
  skipped: boolean;
  error: unknown;
  start(): void;
  skip(): void;
}

function useRuntimeTask(variant: string | null): RuntimeTask {
  const install = useApp((st) => st.runtimeInstall);
  const installedAlready = useApp((st) => (variant ? (st.runtime?.installed.some((r) => r.variant === variant) ?? false) : true));
  const [error, setError] = useState<unknown>(null);
  const [skipped, setSkipped] = useState(false);
  const started = useRef(false);

  const start = useCallback(() => {
    if (!variant) return;
    setError(null);
    api.runtime.install(variant).catch((e: unknown) => setError(e));
  }, [variant]);

  useEffect(() => {
    if (!variant || started.current || installedAlready) return;
    started.current = true;
    // Coming back to this step while the install still runs: follow it instead of asking again.
    if (runtimeBusy(useApp.getState().runtimeInstall, variant)) return;
    start();
  }, [variant, installedAlready, start]);

  const state = install?.variant === variant ? install.state.state : null;
  return {
    done: !variant || skipped || state === 'done' || (installedAlready && state !== 'downloading' && state !== 'extracting'),
    skipped,
    error,
    start,
    skip: () => setSkipped(true),
  };
}

function RuntimeCard({ variant, task }: { variant: string; task: RuntimeTask }) {
  const { t } = useTranslation('onboarding');
  const install = useApp((st) => (st.runtimeInstall?.variant === variant ? st.runtimeInstall : null));
  const registry = useApp((st) => st.registry);
  const offered = useApp((st) => st.runtime?.downloadable.find((r) => r.variant === variant));
  const { backend, version } = parseVariant(variant);
  const source = registry ? runtimeSource(registry.runtimes, variant) : null;
  const state = install?.state;
  const progress = state?.state === 'downloading' ? state.progress : null;
  const view = transferView(progress, offered?.sizeBytes ?? 0);
  const done = task.done && !task.skipped && !task.error && state?.state !== 'failed';
  const failure: Problem | null = task.skipped
    ? null
    : task.error !== null
      ? problemOf(task.error)
      : state?.state === 'failed'
        ? { message: t('download.stopped', { message: state.message }), blocked: false }
        : null;

  const phase = task.skipped
    ? t('download.phase.skipped')
    : failure !== null
      ? t('download.phase.failed')
      : done
        ? t('download.phase.installed')
        : state?.state === 'extracting'
          ? t('download.phase.extracting')
          : progress
            ? t(`download.phase.${progress.phase}`)
            : t('download.phase.starting');

  return (
    <TaskCard
      label={t('download.runtime')}
      title={version ? t('download.runtimeName', { backend: t(`common:backend.${backend}`), version }) : t(`common:backend.${backend}`)}
      source={source ? t('download.from', { source }) : null}
      view={done || state?.state === 'extracting' ? { ...view, fraction: 1, doneBytes: view.totalBytes, remainingSeconds: null } : view}
      tone={done ? 'success' : task.skipped ? 'muted' : failure !== null ? 'danger' : 'accent'}
      phase={phase}
      done={done}
      running={!task.skipped && state?.state === 'downloading'}
    >
      {failure !== null && <Failure problem={failure} purpose="runtime" onRetry={task.start} onSkip={task.skip} />}
    </TaskCard>
  );
}

// ------------------------------------------------------------------ shared

interface TaskCardProps {
  label: string;
  title: ReactNode;
  source: string | null;
  view: TransferView;
  tone: Segment['tone'];
  phase: string;
  done: boolean;
  running: boolean;
  controls?: ReactNode;
  children?: ReactNode;
}

function TaskCard({ label, title, source, view, tone, phase, done, running, controls, children }: TaskCardProps) {
  const { t } = useTranslation('onboarding');
  // Both sizes in the unit that suits the total: GB for model files, MB for runtime packs.
  const size = (bytes: number) =>
    view.totalBytes >= 1e9 ? t('common:units.gb', { value: formatGB(bytes) }) : t('common:units.mb', { value: formatNumber(bytes / 1e6) });
  return (
    <section className={s.card} aria-label={label}>
      <header className={s.cardHead}>
        <div className={s.cardTitle}>
          <span className={s.label}>{label}</span>
          <span className={s.name}>{title}</span>
          {source && <span className={s.source}>{source}</span>}
        </div>
        {controls && <div className={s.controls}>{controls}</div>}
      </header>
      <Progress value={view.fraction} tone={tone} label={`${label}: ${phase}`} />
      <div className={s.stats}>
        <span className={`${s.phase} ${done ? s.ok : ''}`}>
          {done && <CircleCheck size={13} aria-hidden />}
          {phase}
        </span>
        {/* Announces phase changes, not every byte. */}
        <span className="visually-hidden" role="status">
          {`${label}: ${phase}`}
        </span>
        {view.totalBytes > 0 && <span>{t('download.bytes', { done: size(view.doneBytes), total: size(view.totalBytes) })}</span>}
        {running && view.bytesPerSecond > 0 && <span>{t('download.speed', { value: formatBytes(view.bytesPerSecond) })}</span>}
        {running && view.remainingSeconds !== null && <span>{t('download.remaining', { time: formatDuration(view.remainingSeconds) })}</span>}
        {running && view.fileCount > 1 && <span>{t('download.file', { index: view.fileIndex + 1, count: view.fileCount })}</span>}
      </div>
      {children}
    </section>
  );
}

/** What went wrong, already translated; `blocked` when the network setting forbids the download. */
interface Problem {
  message: string;
  blocked: boolean;
}

function problemOf(error: unknown): Problem {
  return { message: errorText(error), blocked: error instanceof IpcError && error.code === 'network_disabled' };
}

interface FailureProps {
  problem: Problem;
  purpose: 'model' | 'runtime';
  retrying?: boolean;
  onRetry: () => void;
  onSkip?: () => void;
}

function Failure({ problem, purpose, retrying = false, onRetry, onSkip }: FailureProps) {
  const { t } = useTranslation('onboarding');
  const updateSettings = useApp((st) => st.updateSettings);
  const { message, blocked } = problem;

  const allow = () =>
    updateSettings((d) => {
      if (purpose === 'model') d.network.allowModelDownloads = true;
      else d.network.allowRuntimeDownloads = true;
    })
      .then(onRetry)
      .catch((e: unknown) => reportError(e));

  return (
    <div className={s.failure} role="alert">
      <p>{message}</p>
      <div className={s.failureActions}>
        {blocked ? (
          <Button size="sm" loading={retrying} onClick={allow}>
            {purpose === 'model' ? t('download.allowModel') : t('download.allowRuntime')}
          </Button>
        ) : (
          <Button size="sm" loading={retrying} onClick={onRetry}>
            {t('common:actions.retry')}
          </Button>
        )}
        {onSkip && (
          <Button size="sm" variant="ghost" onClick={onSkip}>
            {t('download.skipRuntime')}
          </Button>
        )}
      </div>
    </div>
  );
}
