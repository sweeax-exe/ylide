import { Check, Cpu, Gpu, HardDrive, MemoryStick, Minus, RotateCw, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GpuVendor } from '../../bindings/GpuVendor';
import type { HardwareProfile } from '../../bindings/HardwareProfile';
import { Badge, Button } from '../../components/ui';
import { motion } from '../../design/tokens';
import { errorText } from '../../lib/errors';
import { formatGiB, formatNumber } from '../../lib/format';
import { api } from '../../lib/ipc';
import { useTimeline } from './hooks';
import { buildReadout, countUp, easeOut, type Flag, type Metric, PENDING_KINDS, progressBetween, type ReadoutRow, type RowKind, type RowTiming, scanSchedule } from './scan';
import s from './ScanStep.module.css';
import { StepLayout } from './StepLayout';
import { WorldLines } from './WorldLines';

export interface ScanResult {
  hardware: HardwareProfile;
  /** How long the probe took, measured here. */
  ms: number;
}

type Phase = 'probing' | 'revealing' | 'done' | 'failed';

const SCAN_MS = Number.parseInt(motion.scan, 10);
const GiB = 1024 ** 3;

const KIND_ICON: Record<RowKind, ReactNode> = {
  gpu: <Gpu size={14} aria-hidden />,
  memory: <MemoryStick size={14} aria-hidden />,
  cpu: <Cpu size={14} aria-hidden />,
  disk: <HardDrive size={14} aria-hidden />,
  acceleration: <Zap size={14} aria-hidden />,
};

const VENDOR_NAME: Partial<Record<GpuVendor, string>> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', microsoft: 'Microsoft' };

interface ScanStepProps {
  result: ScanResult | null;
  onResult: (result: ScanResult) => void;
  onBack: () => void;
  onNext: () => void;
}

/**
 * The hardware scan: the one orchestrated moment of the app. Rows reveal one
 * after another while two world lines travel down the readout; values count up
 * to their measured numbers. A finished scan is shown at rest when revisited.
 */
export function ScanStep({ result, onResult, onBack, onNext }: ScanStepProps) {
  const { t } = useTranslation('onboarding');
  const [phase, setPhase] = useState<Phase>(result ? 'done' : 'probing');
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (phase !== 'probing') return;
    let alive = true;
    const started = performance.now();
    api.hardware
      .probe(true)
      .then((hardware) => {
        if (!alive) return;
        onResult({ hardware, ms: performance.now() - started });
        setPhase('revealing');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e);
        setPhase('failed');
      });
    return () => {
      alive = false;
    };
  }, [phase, onResult]);

  const elapsed = useTimeline(phase === 'revealing', SCAN_MS);
  useEffect(() => {
    if (phase === 'revealing' && elapsed >= SCAN_MS) setPhase('done');
  }, [phase, elapsed]);

  const rows = useMemo(() => (result && phase !== 'probing' && phase !== 'failed' ? buildReadout(result.hardware) : null), [result, phase]);
  const schedule = useMemo(() => scanSchedule(rows?.length ?? 0, SCAN_MS), [rows]);
  const clock = phase === 'done' ? Number.POSITIVE_INFINITY : elapsed;

  const rescan = () => {
    setError(null);
    setPhase('probing');
  };

  const status =
    phase === 'failed'
      ? t('scan.failed')
      : phase === 'done' && result && rows
        ? t('scan.measured', { count: rows.length, seconds: formatNumber(result.ms / 1000, 1) })
        : t('scan.measuring');

  return (
    <StepLayout
      wide
      title={t('scan.title')}
      lead={t('scan.lead')}
      onBack={onBack}
      actions={
        <Button variant="primary" size="lg" disabled={!result || phase === 'probing' || phase === 'failed'} onClick={onNext}>
          {t('scan.continue')}
        </Button>
      }
    >
      <div className={s.layout}>
        <div className={s.sheet}>
          <div className={s.sheetHead}>
            <span className={`${s.status} ${phase === 'done' ? s.statusDone : ''}`} role="status">
              {status}
            </span>
            {(phase === 'done' || phase === 'failed') && (
              <Button variant="ghost" size="sm" icon={<RotateCw size={13} aria-hidden />} onClick={rescan}>
                {t('scan.rescan')}
              </Button>
            )}
          </div>
          {phase === 'failed' ? (
            <div className={s.failure} role="alert">
              <p>{errorText(error)}</p>
              <Button onClick={rescan}>{t('common:actions.retry')}</Button>
            </div>
          ) : (
            <ol className={s.rows} aria-busy={phase !== 'done'}>
              {rows
                ? rows.map((row, i) => <Row key={row.key} row={row} index={i} timing={schedule[i]} clock={clock} last={i === rows.length - 1} settled={phase === 'done'} />)
                : PENDING_KINDS.map((kind, i) => <PendingRow key={kind} kind={kind} index={i} />)}
            </ol>
          )}
        </div>
        <aside className={s.aside}>
          <h2 className={s.asideTitle}>{t('scan.asideTitle')}</h2>
          <p className={s.asideBody}>{t('scan.asideBody')}</p>
          {result && phase !== 'probing' && (
            <dl className={s.facts}>
              <dt>{t('scan.os')}</dt>
              <dd>
                {result.hardware.os.version} <span className={s.arch}>{result.hardware.os.arch}</span>
              </dd>
            </dl>
          )}
          {result && phase === 'done' && result.hardware.warnings.length > 0 && (
            <div className={s.warnings}>
              <h3 className={s.asideTitle}>{t('scan.warnings')}</h3>
              <ul>
                {result.hardware.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </StepLayout>
  );
}

function PendingRow({ kind, index }: { kind: RowKind; index: number }) {
  const { t } = useTranslation('onboarding');
  return (
    <li className={s.row}>
      <WorldLines index={index} progress={0} particles={index === 0} waiting />
      <div className={s.body}>
        <span className={s.kind}>
          {KIND_ICON[kind]}
          {t(`scan.kind.${kind}`)}
        </span>
        <span className={s.pending}>{index === 0 ? t('scan.measuringRow') : t('scan.waiting')}</span>
      </div>
    </li>
  );
}

interface RowProps {
  row: ReadoutRow;
  index: number;
  timing: RowTiming;
  clock: number;
  last: boolean;
  settled: boolean;
}

function Row({ row, index, timing, clock, last, settled }: RowProps) {
  const { t } = useTranslation('onboarding');
  const line = progressBetween(clock, timing.lineStart, timing.lineEnd);
  const reveal = progressBetween(clock, timing.revealStart, timing.revealEnd);
  const drawing = line > 0 && line < 1;
  const muted = row.status !== 'used';

  return (
    <li className={`${s.row} ${reveal > 0 ? s.revealed : ''} ${muted ? s.muted : ''}`}>
      <WorldLines index={index} progress={line} particles={drawing || (settled && last)} />
      <div className={s.body}>
        <span className={s.kind}>
          {KIND_ICON[row.kind]}
          {t(`scan.kind.${row.kind}`)}
        </span>
        <div className={s.content}>
          {(row.title || row.status === 'missing') && (
            <div className={s.head}>
              <span className={s.device}>{row.title ?? t('scan.noGpu')}</span>
              <StatusBadge row={row} />
            </div>
          )}
          {row.status === 'missing' && <p className={s.explain}>{t('scan.noGpuBody')}</p>}
          {row.status === 'unknown' && <p className={s.explain}>{t('scan.diskUnknown')}</p>}
          {(row.metrics.length > 0 || row.flags.length > 0) && (
            <div className={s.readings}>
              {row.metrics.length > 0 && (
                <dl className={s.metrics}>
                  {row.metrics.map((m) => (
                    <div key={m.id} className={s.metric}>
                      <dt>{t(`scan.metric.${m.id}`)}</dt>
                      <dd>
                        <MetricValue metric={m} progress={reveal} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {row.flags.length > 0 && (
                <ul className={s.flags} aria-label={t(`scan.kind.${row.kind}`)}>
                  {row.flags.map((f) => (
                    <FlagItem key={f.id} flag={f} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function StatusBadge({ row }: { row: ReadoutRow }) {
  const { t } = useTranslation('onboarding');
  if (row.kind !== 'gpu' || row.status === 'missing') return null;
  if (row.status === 'integrated') return <Badge>{t('scan.integrated')}</Badge>;
  if (row.status === 'software') return <Badge>{t('scan.software')}</Badge>;
  const vendor = row.vendor ? (VENDOR_NAME[row.vendor] ?? t('scan.vendorOther')) : null;
  return vendor ? <Badge tone="metal">{vendor}</Badge> : null;
}

function gibDigits(bytes: number) {
  return bytes >= 100 * GiB ? 0 : 1;
}

function MetricValue({ metric, progress }: { metric: Metric; progress: number }) {
  const { t } = useTranslation('onboarding');
  switch (metric.kind) {
    case 'bytes': {
      const digits = gibDigits(metric.value);
      // Screen readers get the final value; the counting is visual only.
      return (
        <>
          <span className={s.value} aria-hidden>
            {formatGiB(metric.value * easeOut(progress), digits)}
          </span>
          <span className={s.unit} aria-hidden>
            {t('unit.gb')}
          </span>
          <span className="visually-hidden">{`${formatGiB(metric.value, digits)} ${t('unit.gb')}`}</span>
        </>
      );
    }
    case 'count':
      return (
        <>
          <span className={s.value} aria-hidden>
            {formatNumber(countUp(metric.value, progress))}
          </span>
          <span className="visually-hidden">{formatNumber(metric.value)}</span>
        </>
      );
    case 'text':
      return <span className={s.value}>{metric.text}</span>;
    case 'unmeasured':
      return <span className={s.unmeasured}>{t('scan.notMeasured')}</span>;
  }
}

function FlagItem({ flag }: { flag: Flag }) {
  const { t } = useTranslation('onboarding');
  const label = flag.id === 'cuda' && flag.detail ? t('scan.flag.cudaDriver', { version: flag.detail }) : t(`scan.flag.${flag.id}`);
  const state = flag.present ? t('scan.present') : t('scan.absent');
  return (
    <li className={`${s.flag} ${flag.present ? s.present : s.absent}`} title={state}>
      {flag.present ? <Check size={12} strokeWidth={2.5} aria-hidden /> : <Minus size={12} aria-hidden />}
      <span>{label}</span>
      <span className="visually-hidden">{state}</span>
    </li>
  );
}
