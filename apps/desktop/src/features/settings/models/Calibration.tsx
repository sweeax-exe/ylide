// "Optimize for this PC": measures a few llama-server settings with the
// running model and keeps the fastest. Shows the live trials and then the
// result as before/after speeds in plain words.

import { Gauge, RotateCcw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalibrationResult } from '../../../bindings/CalibrationResult';
import type { Trial } from '../../../bindings/Trial';
import type { TrialKind } from '../../../bindings/TrialKind';
import type { TrialOutcome } from '../../../bindings/TrialOutcome';
import { Braid } from '../../../components/Braid';
import { Badge, Button, Switch, type Tone } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatNumber } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { useApp } from '../../../state/app';
import { Note } from '../page/controls';
import s from './Calibration.module.css';
import { calibrating, describeTuning, followCalibration, useCalibration } from './calibrationStore';

const OUTCOME_TONE: Record<TrialOutcome, Tone> = {
  measured: 'neutral',
  better: 'success',
  worse: 'neutral',
  different: 'warning',
  overflow: 'warning',
  failed: 'danger',
};

const tps = (n: number) => formatNumber(n, n < 100 ? 1 : 0);

function percent(before: number, after: number, language: string): string {
  return new Intl.NumberFormat(language, { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 0 }).format(after / before - 1);
}

export function Calibration() {
  const { t, i18n } = useTranslation('settings');
  const server = useApp((st) => st.server);
  const status = useCalibration((st) => st.status);
  const event = useCalibration((st) => st.event);
  const running = useCalibration(calibrating);
  const [lossyKv, setLossyKv] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    followCalibration();
    void useCalibration.getState().refresh().catch(() => undefined);
    // The selected model may have changed with the server.
  }, [server?.modelId, server?.quant]);

  if (!server || server.runtime === 'external') return null;
  const ready = server.status.state === 'ready';

  const start = async () => {
    setBusy(true);
    try {
      useCalibration.setState({ event: null });
      await api.calibration.run({ allowLossyKv: lossyKv });
      useCalibration.setState({ event: { state: 'running', current: 'baseline', trials: [], total: 6 } });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      await api.calibration.reset();
      useCalibration.setState({ event: null });
      await useCalibration.getState().refresh();
    } catch (e) {
      reportError(e);
    }
  };

  const result = event?.state === 'done' ? event.result : status?.result ?? null;
  const stale = event?.state !== 'done' && (status?.changes.length ?? 0) > 0;

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Gauge size={18} className={s.icon} aria-hidden />
        <div className={s.headText}>
          <div className={s.title}>{t('calibration.title')}</div>
          <p className={s.intro}>{t('calibration.intro')}</p>
        </div>
        {running ? (
          <Button icon={<X size={13} />} onClick={() => void api.calibration.cancel().catch(reportError)}>
            {t('calibration.cancel')}
          </Button>
        ) : (
          <Button variant={result ? 'secondary' : 'primary'} icon={<Gauge size={13} />} loading={busy} disabled={!ready} onClick={() => void start()}>
            {result ? t('calibration.again') : t('calibration.start')}
          </Button>
        )}
      </div>

      {!running && (
        <div className={s.options}>
          <Switch checked={lossyKv} onChange={setLossyKv} label={t('calibration.lossyKv')} />
          {!ready && <span className={s.hint}>{t('calibration.needsModel')}</span>}
        </div>
      )}

      {event?.state === 'running' && <Progress trials={event.trials} current={event.current} total={event.total} />}
      {event?.state === 'cancelled' && <p className={s.message}>{t('calibration.cancelled')}</p>}
      {event?.state === 'failed' && (
        <div className={s.message}>
          <Note tone="danger">{t('calibration.failed', { message: event.message })}</Note>
        </div>
      )}

      {!running && result && (
        <ResultView
          result={result}
          stale={stale ? (status?.changes ?? []) : []}
          language={i18n.language}
          onReset={() => void reset()}
        />
      )}
    </div>
  );
}

function Progress({ trials, current, total }: { trials: Trial[]; current: TrialKind; total: number }) {
  const { t } = useTranslation('settings');
  return (
    <div className={s.progress} role="status" aria-live="polite">
      <div className={s.progressHead}>
        <Braid active size={14} />
        <span>{t('calibration.running', { done: trials.length + 1, total: Math.max(total, trials.length + 1) })}</span>
      </div>
      <ol className={s.trials}>
        {trials.map((trial, i) => (
          <TrialRow key={i} trial={trial} />
        ))}
        <li className={s.trial}>
          <span className={s.trialName}>{t(`calibration.trial.${current}`)}</span>
          <span className={s.trialSpeeds}>{t('calibration.measuring')}</span>
        </li>
      </ol>
    </div>
  );
}

function TrialRow({ trial }: { trial: Trial }) {
  const { t } = useTranslation('settings');
  return (
    <li className={s.trial}>
      <span className={s.trialName}>{t(`calibration.trial.${trial.kind}`)}</span>
      <span className={s.trialSpeeds}>{trial.speeds ? t('calibration.speeds', { prompt: tps(trial.speeds.promptTps), gen: tps(trial.speeds.genTps) }) : '–'}</span>
      <Badge tone={OUTCOME_TONE[trial.outcome]} title={trial.note ?? undefined}>
        {t(`calibration.outcome.${trial.outcome}`)}
      </Badge>
    </li>
  );
}

function ResultView({ result, stale, language, onReset }: { result: CalibrationResult; stale: string[]; language: string; onReset: () => void }) {
  const { t } = useTranslation('settings');
  const changes = describeTuning(result.tuning);
  const { baseline, best } = result;
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(result.createdAtUnixMs));
  return (
    <div className={s.result}>
      {changes.length > 0 ? (
        <>
          <p className={s.headline}>
            {t('calibration.result.gen', { before: tps(baseline.genTps), after: tps(best.genTps), change: percent(baseline.genTps, best.genTps, language) })}
          </p>
          <p className={s.secondary}>
            {t('calibration.result.prompt', { before: tps(baseline.promptTps), after: tps(best.promptTps), change: percent(baseline.promptTps, best.promptTps, language) })}
          </p>
          <ul className={s.changes}>
            {changes.map((c) => (
              <li key={c.key}>{t(`calibration.change.${c.key}`, c.values)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className={s.headline}>{t('calibration.result.same', { gen: tps(baseline.genTps), prompt: tps(baseline.promptTps) })}</p>
      )}
      <details className={s.details}>
        <summary>{t('calibration.result.trials', { date })}</summary>
        <ol className={s.trials}>
          {result.trials.map((trial, i) => (
            <TrialRow key={i} trial={trial} />
          ))}
        </ol>
      </details>
      {stale.length > 0 && (
        <div className={s.message}>
          <Note tone="warning">{t('calibration.stale', { what: stale.map((c) => t(`calibration.changed.${c}`)).join(', ') })}</Note>
        </div>
      )}
      {changes.length > 0 && (
        <div className={s.footer}>
          <span className={s.hint}>{stale.length > 0 ? t('calibration.result.notApplied') : t('calibration.result.applied')}</span>
          <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={onReset}>
            {t('calibration.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
