import { Award, Brain, ChevronDown, ExternalLink, Gauge, Info, MemoryStick, Ruler, Scale, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComputeBudget } from '../../bindings/ComputeBudget';
import type { Model } from '../../bindings/Model';
import type { Reason } from '../../bindings/Reason';
import type { ReasonCode } from '../../bindings/ReasonCode';
import { Badge, Button, Progress, type Segment } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { formatGB, formatGiB, formatNumber, formatTokens } from '../../lib/format';
import { openExternal } from '../../lib/ipc';
import { type MemoryBar, type MemoryPart, memoryBars, type ModelOption, pickLocalized, reasonParams } from './recommend';
import s from './SpecSheet.module.css';

interface SpecSheetProps {
  option: ModelOption;
  model: Model | undefined;
  budget: ComputeBudget;
  installed: boolean;
  /** "Why this model?" stays open while the user compares options. */
  whyOpen: boolean;
  onWhyOpen: (open: boolean) => void;
}

/** The chosen candidate as a data sheet: what it is, how fast, where it lives in memory and why. */
export function SpecSheet({ option, model, budget, installed, whyOpen, onWhyOpen }: SpecSheetProps) {
  const { t } = useTranslation('onboarding');
  const { candidate } = option;
  const { plan } = candidate;
  const arch = model?.architecture;
  const params =
    arch && arch.paramsActiveB < arch.paramsTotalB
      ? t('model.paramsMoe', { total: formatNumber(arch.paramsTotalB, 1), active: formatNumber(arch.paramsActiveB, 1) })
      : arch
        ? t('model.params', { total: formatNumber(arch.paramsTotalB, 1) })
        : null;

  const placementNote =
    plan.placement.kind === 'moeOffload'
      ? t('model.expertLayers', { count: plan.placement.cpuExpertLayers })
      : plan.placement.kind === 'partialOffload'
        ? t('model.gpuLayers', { count: plan.placement.gpuLayers })
        : plan.placement.kind === 'gpu'
          ? budget.gpuName
          : null;

  // The core only warns about low disk space machine-wide; this is about the chosen file.
  const diskFree = budget.diskFreeBytes;
  const tooBig = !installed && diskFree !== null && candidate.downloadBytes > diskFree;

  return (
    <article className={s.sheet} aria-labelledby={`${option.key}-name`}>
      <header className={s.header}>
        <div className={s.titleBlock}>
          <span className={s.kicker}>{option.kind === 'primary' ? t('model.recommended') : t('model.alternativeKicker', { kind: t(`common:alternatives.${option.kind}`) })}</span>
          <h2 className={s.name} id={`${option.key}-name`}>
            {model?.name ?? candidate.modelId}
          </h2>
          <div className={s.meta}>
            {model && <span>{model.publisher}</span>}
            {params && <span>{params}</span>}
            <code className={s.quant}>{candidate.quant}</code>
          </div>
        </div>
        {model && <LicenseBadge license={model.license} />}
      </header>

      <dl className={s.specs}>
        <Spec label={t('model.spec.speed')} value={formatNumber(plan.estTokensPerSec)} unit={t('unit.tokPerSec')} note={t('model.spec.estimate')} />
        <Spec label={t('model.spec.context')} value={formatTokens(plan.context)} unit={t('unit.tokens')} note={plan.kvCacheType !== 'f16' ? t('model.spec.kvCache', { type: plan.kvCacheType }) : null} />
        <Spec
          label={t('model.spec.download')}
          value={formatGB(candidate.downloadBytes)}
          unit={t('unit.gb')}
          note={installed ? t('model.spec.installed') : tooBig ? t('model.spec.noSpace', { free: formatGB(diskFree ?? 0) }) : t('model.spec.fromHf')}
          tone={installed ? 'success' : tooBig ? 'warning' : undefined}
        />
        <Spec label={t('model.spec.placement')} text={t(`common:placement.${plan.placement.kind}`)} note={placementNote} />
      </dl>

      <section className={s.memory} aria-label={t('model.memory.title')}>
        {memoryBars(plan, budget).map((bar) => (
          <MemoryRow key={bar.kind} bar={bar} device={bar.kind === 'vram' ? budget.gpuName : null} />
        ))}
      </section>

      <Why candidateReasons={candidate.reasons} model={model} open={whyOpen} onOpen={onWhyOpen} />
    </article>
  );
}

function LicenseBadge({ license }: { license: Model['license'] }) {
  const { t } = useTranslation('onboarding');
  const label = license.id.startsWith('LicenseRef-') ? license.name : license.id;
  return (
    <Badge tone={license.commercialUse ? 'success' : 'warning'} title={license.commercialUse ? t('model.license.commercial', { name: license.name }) : t('model.license.restricted', { name: license.name })}>
      <Scale size={12} aria-hidden />
      {label}
    </Badge>
  );
}

interface SpecProps {
  label: string;
  value?: string;
  unit?: string;
  /** Instead of a number (placement). */
  text?: string;
  note?: string | null;
  tone?: 'success' | 'warning';
}

function Spec({ label, value, unit, text, note, tone }: SpecProps) {
  return (
    <div className={s.spec}>
      <dt>{label}</dt>
      <dd>
        {text ? (
          <span className={s.specText}>{text}</span>
        ) : (
          <span className={s.specValue}>
            {value}
            {unit && <span className={s.specUnit}>{unit}</span>}
          </span>
        )}
        {note && <span className={`${s.specNote} ${tone ? s[tone] : ''}`}>{note}</span>}
      </dd>
    </div>
  );
}

const PART_TONE: Record<MemoryPart, Segment['tone']> = { weights: 'metal', kv: 'accent', overhead: 'muted' };

function MemoryRow({ bar, device }: { bar: MemoryBar; device: string | null }) {
  const { t } = useTranslation('onboarding');
  const gb = (bytes: number) => formatGiB(bytes);
  const free = Math.max(0, bar.capacity - bar.used);
  const name = t(`model.memory.${bar.kind}`);
  return (
    <div className={s.bar}>
      <div className={s.barHead}>
        <span className={s.barName}>
          {name}
          {device && <span className={s.barDevice}>{device}</span>}
        </span>
        <span className={s.barTotal}>{t('model.memory.used', { used: gb(bar.used), total: gb(bar.capacity) })}</span>
      </div>
      <Progress
        label={t('model.memory.barLabel', { name, used: gb(bar.used), total: gb(bar.capacity) })}
        segments={bar.parts.map((p) => ({ value: p.bytes / bar.capacity, tone: PART_TONE[p.part], label: `${t(`model.memory.${p.part}`)}: ${gb(p.bytes)} ${t('unit.gb')}` }))}
      />
      <ul className={s.legend}>
        {bar.parts.map((p) => (
          <li key={p.part}>
            <span className={`${s.swatch} ${s[`swatch-${p.part}`]}`} aria-hidden />
            {t(`model.memory.${p.part}`)}
            <span className={s.legendValue}>
              {gb(p.bytes)} {t('unit.gb')}
            </span>
          </li>
        ))}
        <li>
          <span className={`${s.swatch} ${s['swatch-free']}`} aria-hidden />
          {t('model.memory.free')}
          <span className={s.legendValue}>
            {gb(free)} {t('unit.gb')}
          </span>
        </li>
      </ul>
    </div>
  );
}

const REASON_ICON: Partial<Record<ReasonCode, ReactNode>> = {
  fitsInVram: <MemoryStick size={14} />,
  moeOffload: <MemoryStick size={14} />,
  partialOffload: <MemoryStick size={14} />,
  unifiedMemory: <MemoryStick size={14} />,
  cpuOnly: <MemoryStick size={14} />,
  quantizedKvCache: <MemoryStick size={14} />,
  autocompleteMovesToCpu: <MemoryStick size={14} />,
  speedEstimate: <Gauge size={14} />,
  slowWarning: <Gauge size={14} />,
  topQualityForBudget: <Award size={14} />,
  benchmark: <Award size={14} />,
  toolCalling: <Wrench size={14} />,
  longContext: <Ruler size={14} />,
  reasoningModel: <Brain size={14} />,
  permissiveLicense: <Scale size={14} />,
  restrictedLicense: <Scale size={14} />,
};

const CAUTION = new Set<ReasonCode>(['slowWarning', 'restrictedLicense']);

export function ReasonText({ reason }: { reason: Reason }) {
  const { t } = useTranslation('onboarding');
  const params = reasonParams(reason, {
    number: (n, digits) => formatNumber(n, digits),
    tokens: formatTokens,
    toolLevel: (level) => t(`common:toolCallingLevel.${level}`),
  });
  const text = t(`common:reasons.${reason.code}`, params);
  if (reason.code !== 'benchmark') return <>{text}</>;
  return (
    <>
      {text} <span className={s.provenance}>({reason.params.selfReported === 'true' ? t('common:reasons.benchmarkSelfReported') : t('common:reasons.benchmarkIndependent')})</span>
    </>
  );
}

function Why({ candidateReasons, model, open, onOpen }: { candidateReasons: Reason[]; model: Model | undefined; open: boolean; onOpen: (open: boolean) => void }) {
  const { t, i18n } = useTranslation('onboarding');
  const panelId = useId();
  const description = pickLocalized(model?.description, i18n.language);
  const strengths = (model?.strengths ?? []).map((st) => pickLocalized(st, i18n.language)).filter(Boolean);

  return (
    <div className={s.why}>
      <button type="button" className={s.whyToggle} aria-expanded={open} aria-controls={panelId} onClick={() => onOpen(!open)}>
        <ChevronDown size={14} aria-hidden className={s.chevron} />
        {t('model.why')}
      </button>
      <div id={panelId} className={s.whyPanel} hidden={!open}>
        {description && <p className={s.description}>{description}</p>}
        {strengths.length > 0 && (
          <div className={s.group}>
            <h3 className={s.groupTitle}>{t('model.strengths')}</h3>
            <ul className={s.strengths}>
              {strengths.map((st) => (
                <li key={st}>{st}</li>
              ))}
            </ul>
          </div>
        )}
        {candidateReasons.length > 0 && (
          <div className={s.group}>
            <h3 className={s.groupTitle}>{t('model.reasons')}</h3>
            <ul className={s.reasons}>
              {candidateReasons.map((r, i) => (
                <li key={`${r.code}-${i}`} className={CAUTION.has(r.code) ? s.caution : ''}>
                  <span className={s.reasonIcon} aria-hidden>
                    {REASON_ICON[r.code] ?? <Info size={14} />}
                  </span>
                  <span>
                    <ReasonText reason={r} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {model && (
          <div className={s.links}>
            <Button variant="ghost" size="sm" icon={<ExternalLink size={13} aria-hidden />} onClick={() => openExternal(`https://huggingface.co/${model.source.hfRepo}`).catch((e: unknown) => reportError(e))}>
              {t('model.modelCard')}
            </Button>
            <Button variant="ghost" size="sm" icon={<ExternalLink size={13} aria-hidden />} onClick={() => openExternal(model.license.url).catch((e: unknown) => reportError(e))}>
              {t('model.licenseText', { name: model.license.name })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
