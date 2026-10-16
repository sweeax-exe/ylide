// Running, paused and failed model downloads.

import { Pause, Play, RotateCw, X } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DownloadJob } from '../../../bindings/DownloadJob';
import { Badge, Button, IconButton, Progress, type Tone } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatBytes, formatDuration, formatGB, formatNumber } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { downloadedBytes, fraction, remainingSeconds, totalBytes, visibleDownloads } from '../logic/downloads';
import { keepFocusInSection } from '../page/focus';
import { MODEL_SECTIONS } from '../page/ids';
import { PageSection } from '../page/Page';
import s from './Downloads.module.css';

export function Downloads() {
  const { t } = useTranslation('settings');
  const jobs = useApp((st) => st.downloads);
  const visible = visibleDownloads(jobs);
  return (
    <PageSection id={MODEL_SECTIONS.downloads} title={t('downloads.title')} description={t('downloads.description')}>
      {visible.length === 0 ? (
        <div className={s.empty}>{t('downloads.empty')}</div>
      ) : (
        <ul className={s.list}>
          {visible.map((job) => (
            <DownloadRow key={job.jobId} job={job} />
          ))}
        </ul>
      )}
    </PageSection>
  );
}

/** Label and tone for a job, combining its state and download phase. */
function jobStatus(job: DownloadJob): { key: string; tone: Tone } {
  if (job.state.state === 'paused') return { key: 'paused', tone: 'neutral' };
  if (job.state.state === 'failed') return { key: 'failed', tone: 'danger' };
  const phase = job.progress?.phase;
  if (phase === 'verifying') return { key: 'verifying', tone: 'accent' };
  if (phase === 'resuming') return { key: 'resuming', tone: 'accent' };
  return { key: 'downloading', tone: 'accent' };
}

/** Pause, resume, retry and cancel for one job; `compact` makes retry an icon too, for a table cell. */
export function JobActions({ job, compact = false }: { job: DownloadJob; compact?: boolean }) {
  const { t } = useTranslation('settings');
  // Repeat clicks are ignored while a request runs. The buttons are not
  // disabled for that: a disabled button loses keyboard focus.
  const busy = useRef(false);
  const act = async (from: HTMLElement, action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    const restoreFocus = keepFocusInSection(from);
    try {
      await action();
    } catch (e) {
      reportError(e);
    } finally {
      busy.current = false;
      restoreFocus();
    }
  };
  const resume = (from: HTMLElement) => act(from, () => api.models.download(job.modelId, job.quant));
  const running = job.state.state === 'running';
  return (
    <span className={s.actions}>
      {/* One button for pause and resume, so focus stays on it when the state flips. */}
      {(running || job.state.state === 'paused') && (
        <IconButton
          label={running ? t('downloads.pause', { name: job.name }) : t('downloads.resume', { name: job.name })}
          onClick={(e) => void (running ? act(e.currentTarget, () => api.models.pause(job.jobId)) : resume(e.currentTarget))}
        >
          {running ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
      )}
      {job.state.state === 'failed' &&
        (compact ? (
          <IconButton label={t('downloads.retry', { name: job.name })} onClick={(e) => void resume(e.currentTarget)}>
            <RotateCw size={14} />
          </IconButton>
        ) : (
          <Button size="sm" icon={<RotateCw size={13} />} onClick={(e) => void resume(e.currentTarget)}>
            {t('common:actions.retry')}
          </Button>
        ))}
      <IconButton label={t('downloads.cancel', { name: job.name })} onClick={(e) => void act(e.currentTarget, () => api.models.cancel(job.jobId))}>
        <X size={14} />
      </IconButton>
    </span>
  );
}

const progressTone = (job: DownloadJob) => (job.state.state === 'failed' ? 'danger' : job.state.state === 'paused' ? 'muted' : 'accent');

/** What is known about a job's progress, each as a phrase; null when unknown. */
function useJobFacts(job: DownloadJob) {
  const { t } = useTranslation('settings');
  const p = job.progress;
  const running = job.state.state === 'running';
  const remaining = running ? remainingSeconds(p) : null;
  const percent = formatNumber(fraction(job) * 100);
  return {
    percent: t('downloads.percent', { percent }),
    done: t('common:units.gb', { value: formatGB(downloadedBytes(job)) }),
    amount: t('downloads.amount', { done: formatGB(downloadedBytes(job)), total: formatGB(totalBytes(job)), percent }),
    speed: running && p && p.bytesPerSecond > 0 ? t('downloads.speed', { speed: formatBytes(p.bytesPerSecond) }) : null,
    remaining: remaining !== null ? t('downloads.remaining', { time: formatDuration(remaining) }) : null,
    file: p && p.fileCount > 1 ? t('downloads.file', { index: p.fileIndex + 1, count: p.fileCount }) : null,
  };
}

const known = (facts: Array<string | null>) => facts.filter((f): f is string => f !== null);

export function DownloadRow({ job }: { job: DownloadJob }) {
  const { t } = useTranslation('settings');
  const status = jobStatus(job);
  const f = useJobFacts(job);
  const facts = known([f.amount, f.speed, f.remaining, f.file]);
  return (
    <li className={s.row}>
      <div className={s.top}>
        <span className={s.name}>{job.name}</span>
        <Badge tone={status.tone}>{t(`downloads.state.${status.key}`)}</Badge>
        <span className={s.numbers}>
          {facts.map((fact) => (
            <span key={fact} className="tabular">
              {fact}
            </span>
          ))}
        </span>
        <JobActions job={job} />
      </div>
      <Progress value={fraction(job)} tone={progressTone(job)} label={t('downloads.progressLabel', { name: job.name })} />
      {job.state.state === 'failed' && <div className={s.error}>{t('downloads.failed', { message: job.state.message })}</div>}
    </li>
  );
}

/**
 * A table cell's version: the bar over one short line of facts. The actions
 * go in a cell of their own (`JobActions` with `compact`).
 */
export function DownloadProgress({ job }: { job: DownloadJob }) {
  const { t } = useTranslation('settings');
  const status = jobStatus(job);
  const label = t(`downloads.state.${status.key}`);
  const f = useJobFacts(job);
  // A plain download needs no label; pausing, resuming and checking the file do.
  // The amount comes last, so it is the one left out when the cell is narrow.
  const facts = known([status.key === 'downloading' ? null : label, f.percent, f.remaining, f.done]);
  const failed = job.state.state === 'failed' ? job.state.message : null;
  return (
    <div className={s.compact} title={failed ?? known([label, f.amount, f.speed, f.remaining, f.file]).join(' · ')}>
      <Progress value={fraction(job)} tone={progressTone(job)} label={t('downloads.progressLabel', { name: job.name })} />
      {failed !== null ? (
        <span className={s.compactFailed}>{label}</span>
      ) : (
        <span className={s.compactFacts}>
          {facts.map((fact) => (
            <span key={fact} className="tabular">
              {fact}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
