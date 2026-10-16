// One registry model: a scannable row that expands into every detail the
// registry knows, including each quantization with its download.

import { ChevronRight, Download, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localeOf } from '../../../i18n';
import type { Candidate } from '../../../bindings/Candidate';
import type { DownloadJob } from '../../../bindings/DownloadJob';
import type { Model } from '../../../bindings/Model';
import type { Plan } from '../../../bindings/Plan';
import type { Variant } from '../../../bindings/Variant';
import { Badge, Button, IconButton } from '../../../components/ui';
import { reportError } from '../../../lib/errors';
import { formatGB, formatGiB, formatNumber, formatTokens } from '../../../lib/format';
import { api, openExternal } from '../../../lib/ipc';
import { fitFor, localized, selectionKey, variantBytes, type Mark } from '../logic/catalog';
import { jobFor } from '../logic/downloads';
import { keepFocusInSection, useFocusWhenReplaced } from '../page/focus';
import s from './Catalog.module.css';
import { DownloadProgress, JobActions } from './Downloads';
import { UncensoredBadge, UncensoredNote } from './Uncensored';

export interface Recommended {
  mark: Mark;
  candidate: Candidate;
}

export interface EntryContext {
  recommended: Map<string, Recommended>;
  /** Every variant that fits, with its best configuration; null until the recommendation has loaded, and after it failed. */
  fits: Map<string, Candidate> | null;
  installed: Set<string>;
  jobs: Record<string, DownloadJob>;
  downloadsAllowed: boolean;
  /** Id of the note explaining why downloads are off. */
  downloadsOffNoteId: string;
  freeBytes: number | null;
}

const open = (url: string) => void openExternal(url).catch(reportError);

export function markLabelKey(mark: Mark): string {
  if (mark.kind === 'alternative') return `common:alternatives.${mark.alternative}`;
  return `catalog.mark.${mark.kind}`;
}

export function CatalogEntry({ model, mark, expanded, onToggle, ctx }: { model: Model; mark: Mark | null; expanded: boolean; onToggle: () => void; ctx: EntryContext }) {
  const { t, i18n } = useTranslation('settings');
  const arch = model.architecture;
  const installedCount = model.variants.filter((v) => ctx.installed.has(selectionKey(model.id, v.quant))).length;
  const downloading = model.variants.some((v) => jobFor(ctx.jobs, model.id, v.quant));
  const bodyId = `catalog-${model.id}-details`;
  const lang = i18n.language;

  return (
    <li className={s.entry} id={`catalog-${model.id}`}>
      <button type="button" className={s.entryHead} aria-expanded={expanded} aria-controls={expanded ? bodyId : undefined} onClick={onToggle}>
        <ChevronRight size={14} className={s.chevron} aria-hidden />
        <span className={s.entryName}>
          <span className={s.nameLine}>
            <span className={s.name}>{model.name}</span>
            {model.uncensored && <UncensoredBadge />}
            {mark && <Badge tone={mark.kind === 'primary' ? 'accent' : 'neutral'}>{t(markLabelKey(mark))}</Badge>}
            {installedCount > 0 && <Badge tone="success">{t('catalog.installedBadge')}</Badge>}
            {downloading && <Badge tone="accent">{t('catalog.downloadingBadge')}</Badge>}
          </span>
          <span className={s.publisher}>{model.publisher}</span>
        </span>
        <span className={s.cell}>
          <span className="visually-hidden">{t('catalog.parameters')}: </span>
          <span className="tabular">{t('catalog.paramsValue', { value: formatNumber(arch.paramsTotalB, 1) })}</span>
          {arch.type === 'moe' && <span className={s.cellSub}>{t('catalog.activeValue', { value: formatNumber(arch.paramsActiveB, 1) })}</span>}
        </span>
        <span className={s.cell}>
          <span className="visually-hidden">{t('catalog.maxContext')}: </span>
          <span className="tabular">{formatTokens(model.context.max)}</span>
        </span>
        <span className={s.cell}>
          <span className="visually-hidden">{t('catalog.toolCalling')}: </span>
          {t(`common:toolCallingLevel.${model.capabilities.toolCalling}`)}
        </span>
        <span className={s.cellLicense}>
          <Badge tone={model.license.commercialUse ? 'success' : 'warning'} title={model.license.commercialUse ? t('catalog.commercialYes') : t('catalog.commercialCheck')}>
            {model.license.id}
          </Badge>
          {/* The badge colour carries the terms; say them for screen readers too. */}
          <span className="visually-hidden">: {model.license.commercialUse ? t('catalog.commercialYes') : t('catalog.commercialCheck')}</span>
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className={s.details}>
          {model.uncensored && <UncensoredNote />}
          <p className={s.description}>{localized(model.description, lang)}</p>
          {model.strengths.length > 0 && (
            <ul className={s.strengths} aria-label={t('catalog.strengths')}>
              {model.strengths.map((st, i) => (
                <li key={i}>{localized(st, lang)}</li>
              ))}
            </ul>
          )}
          <Facts model={model} />
          {model.benchmarks.length > 0 && <Benchmarks model={model} />}
          <Quantizations model={model} ctx={ctx} />
        </div>
      )}
    </li>
  );
}

function Facts({ model }: { model: Model }) {
  const { t, i18n } = useTranslation('settings');
  const arch = model.architecture;
  const homepage = model.source.homepage;
  const locale = localeOf(i18n.language);
  const released = new Date(`${model.releaseDate}T00:00:00`);
  const date = Number.isNaN(released.getTime()) ? model.releaseDate : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(released);
  return (
    <dl className={s.facts}>
      <div>
        <dt>{t('catalog.publisher')}</dt>
        <dd>{model.publisher}</dd>
      </div>
      <div>
        <dt>{t('catalog.released')}</dt>
        <dd className="tabular">{date}</dd>
      </div>
      <div>
        <dt>{t('catalog.parameters')}</dt>
        <dd className="tabular">
          {arch.type === 'moe'
            ? t('catalog.paramsMoe', { total: formatNumber(arch.paramsTotalB, 1), active: formatNumber(arch.paramsActiveB, 1) })
            : t('catalog.paramsDense', { total: formatNumber(arch.paramsTotalB, 1) })}
        </dd>
      </div>
      <div>
        <dt>{t('catalog.context')}</dt>
        <dd className="tabular">{t('catalog.contextValue', { max: formatTokens(model.context.max), recommended: formatTokens(model.context.recommended) })}</dd>
      </div>
      <div>
        <dt>{t('catalog.toolCalling')}</dt>
        <dd>{t(`common:toolCallingLevel.${model.capabilities.toolCalling}`)}</dd>
      </div>
      <div>
        <dt>{t('catalog.reasoning')}</dt>
        <dd>{t(`catalog.reasoningLevel.${model.capabilities.reasoning}`)}</dd>
      </div>
      <div>
        <dt>{t('catalog.roles')}</dt>
        <dd>{model.roles.map((r) => t(`common:modelRoles.${r}`)).join(', ')}</dd>
      </div>
      <div className={s.factWide}>
        <dt>{t('catalog.license')}</dt>
        <dd className={s.licenseLine}>
          <span>{model.license.name}</span>
          <Badge tone={model.license.commercialUse ? 'success' : 'warning'}>{model.license.commercialUse ? t('catalog.commercialYes') : t('catalog.commercialCheck')}</Badge>
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => open(model.license.url)}>
            {t('catalog.readLicense')}
          </Button>
        </dd>
      </div>
      <div className={s.factWide}>
        <dt>{t('catalog.source')}</dt>
        <dd className={s.licenseLine}>
          <code className="selectable">
            {model.source.hfRepo}@{model.source.revision.slice(0, 7)}
          </code>
          {homepage && (
            <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => open(homepage)}>
              {t('catalog.modelCard')}
            </Button>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Benchmarks({ model }: { model: Model }) {
  const { t } = useTranslation('settings');
  return (
    <div className={s.block}>
      <h4 className={s.blockTitle}>{t('catalog.benchmarks')}</h4>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">{t('catalog.benchmark')}</th>
              <th scope="col" className={s.num}>
                {t('catalog.score')}
              </th>
              <th scope="col">{t('catalog.measuredBy')}</th>
              <th scope="col">{t('catalog.date')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('catalog.sourceLink')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {model.benchmarks.map((b) => (
              <tr key={b.name}>
                <td>{b.name}</td>
                <td className={s.num}>{t('catalog.scoreValue', { score: formatNumber(b.score, 1), unit: b.unit })}</td>
                <td>{b.selfReported ? <Badge tone="warning">{t('catalog.selfReported')}</Badge> : <Badge>{t('catalog.independent')}</Badge>}</td>
                <td className="tabular">{b.date ?? '–'}</td>
                <td className={s.linkCell}>
                  <IconButton label={t('catalog.openSource', { name: b.name })} onClick={() => open(b.sourceUrl)}>
                    <ExternalLink size={13} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Quantizations({ model, ctx }: { model: Model; ctx: EntryContext }) {
  const { t } = useTranslation('settings');
  return (
    <div className={s.block}>
      <h4 className={s.blockTitle}>{t('catalog.quantizations')}</h4>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">{t('catalog.quant')}</th>
              <th scope="col" className={`${s.num} ${s.bits}`}>
                {t('catalog.bits')}
              </th>
              <th scope="col" className={s.num}>
                {t('catalog.size')}
              </th>
              <th scope="col">{t('catalog.fit')}</th>
              <th scope="col" className={s.actionHead}>
                <span className="visually-hidden">{t('catalog.download')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {model.variants.map((v) => (
              <QuantRow key={v.quant} model={model} variant={v} ctx={ctx} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuantRow({ model, variant, ctx }: { model: Model; variant: Variant; ctx: EntryContext }) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const key = selectionKey(model.id, variant.quant);
  const rec = ctx.recommended.get(key);
  const fit = fitFor(ctx.fits, key);
  const size = variantBytes(variant);
  const job = jobFor(ctx.jobs, model.id, variant.quant);
  const installed = ctx.installed.has(key);
  const tooBig = ctx.freeBytes !== null && size > ctx.freeBytes;
  const reason = !ctx.downloadsAllowed ? t('catalog.downloadsOff') : tooBig ? t('catalog.noSpace', { free: formatGB(ctx.freeBytes ?? 0) }) : undefined;

  // The button is replaced by the job's controls once the first job event arrives.
  const progressFocus = useFocusWhenReplaced<HTMLTableCellElement>(!!job);

  const download = async (from: HTMLElement) => {
    const restoreFocus = keepFocusInSection(from);
    progressFocus.arm();
    setBusy(true);
    try {
      await api.models.download(model.id, variant.quant);
    } catch (e) {
      progressFocus.disarm();
      reportError(e);
    } finally {
      setBusy(false);
      restoreFocus();
    }
  };

  return (
    <tr className={rec?.mark.kind === 'primary' ? s.recommendedRow : undefined}>
      <td>
        <code className={s.quant}>{variant.quant}</code>
      </td>
      <td className={`${s.num} ${s.bits}`}>{formatNumber(variant.bitsPerWeight, 2)}</td>
      <td className={s.num}>{t('common:units.gb', { value: formatGB(size) })}</td>
      <td className={s.fit}>
        {/* While it downloads, the progress takes the place of the estimate; a recommendation keeps its badge. */}
        {job && !installed ? (
          <span className={s.fitLine}>
            {rec && <Badge tone={rec.mark.kind === 'primary' ? 'accent' : 'neutral'}>{t(markLabelKey(rec.mark))}</Badge>}
            <span className={s.fitProgress}>
              <DownloadProgress job={job} />
            </span>
          </span>
        ) : rec ? (
          <span className={s.fitLine}>
            <Badge tone={rec.mark.kind === 'primary' ? 'accent' : 'neutral'}>{t(markLabelKey(rec.mark))}</Badge>
            <PlanText plan={rec.candidate.plan} />
          </span>
        ) : fit.kind === 'estimate' ? (
          <PlanText plan={fit.candidate.plan} />
        ) : fit.kind === 'noFit' ? (
          <span className={s.noFit}>{t('catalog.noFit')}</span>
        ) : (
          <span className={s.fitNone}>–</span>
        )}
      </td>
      <td ref={progressFocus.container} className={s.actionCell}>
        {installed ? (
          <Badge tone="success">{t('catalog.installedBadge')}</Badge>
        ) : job ? (
          <JobActions job={job} compact />
        ) : (
          <Button
            size="sm"
            icon={<Download size={13} />}
            loading={busy}
            disabled={!!reason}
            title={reason}
            aria-describedby={!ctx.downloadsAllowed ? ctx.downloadsOffNoteId : undefined}
            aria-label={t('catalog.downloadNamed', { name: model.name, quant: variant.quant })}
            onClick={(e) => void download(e.currentTarget)}
          >
            {t('catalog.download')}
          </Button>
        )}
        {!installed && !job && tooBig && ctx.downloadsAllowed && <div className={s.noSpace}>{t('catalog.noSpaceShort')}</div>}
      </td>
    </tr>
  );
}

/** Placement, speed and memory of a configuration. */
function PlanText({ plan }: { plan: Plan }) {
  const { t } = useTranslation('settings');
  return (
    <span className={s.fitText}>
      {t('catalog.plan', {
        placement: t(`common:placement.${plan.placement.kind}`),
        tps: formatNumber(plan.estTokensPerSec),
        memory: [plan.vramBytes > 0 ? t('catalog.memVram', { value: formatGiB(plan.vramBytes) }) : null, plan.ramBytes > 0 ? t('catalog.memRam', { value: formatGiB(plan.ramBytes) }) : null]
          .filter(Boolean)
          .join(', '),
      })}
    </span>
  );
}
