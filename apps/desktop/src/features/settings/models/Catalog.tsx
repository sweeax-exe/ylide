// All registry models, filterable by role, with the recommendation for this machine.

import { Cpu, Download, FileInput } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Model } from '../../../bindings/Model';
import type { Reason } from '../../../bindings/Reason';
import type { Recommendation } from '../../../bindings/Recommendation';
import { Badge, Button, Segmented, Spinner } from '../../../components/ui';
import { errorText, reportError } from '../../../lib/errors';
import { formatGB, formatGiB, formatNumber, formatTokens } from '../../../lib/format';
import { api } from '../../../lib/ipc';
import { modelName, useApp } from '../../../state/app';
import { filterByRole, fitsByKey, modelMark, orderCatalog, recommendationMarks, ROLE_FILTERS, selectionKey, splitUncensored, type RoleFilter } from '../logic/catalog';
import { jobFor } from '../logic/downloads';
import { keepFocusInSection, useFocusWhenReplaced } from '../page/focus';
import { isSelfReported, reasonParams } from '../logic/reasons';
import { Note } from '../page/controls';
import { MODEL_SECTIONS, SETTINGS_SECTIONS } from '../page/ids';
import { openSection } from '../page/navigation';
import { scrollToElement } from '../page/scroll';
import { PageSection } from '../page/Page';
import s from './Catalog.module.css';
import { CatalogEntry, markLabelKey, type EntryContext, type Recommended } from './CatalogEntry';
import { ImportButton } from './ImportButton';
import { UncensoredNote } from './Uncensored';

type RecState = { state: 'loading' } | { state: 'ready'; rec: Recommendation } | { state: 'error'; message: string };

export function Catalog() {
  const { t } = useTranslation('settings');
  const registry = useApp((st) => st.registry);
  const installedModels = useApp((st) => st.installed);
  const jobs = useApp((st) => st.downloads);
  const allowed = useApp((st) => st.settings?.network.allowModelDownloads ?? false);
  const freeBytes = useApp((st) => st.hardware?.disk?.freeBytes ?? null);
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rec, setRec] = useState<RecState>({ state: 'loading' });
  const noteId = useId();
  const uncensoredId = useId();

  // Planned again for a newer model list, so its new variants are not read as "does not fit".
  const registryVersion = registry?.registryVersion;
  useEffect(() => {
    let alive = true;
    setRec({ state: 'loading' });
    api.recommend().then(
      (r) => alive && setRec({ state: 'ready', rec: r }),
      (e: unknown) => alive && setRec({ state: 'error', message: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [registryVersion]);

  const recommendation = rec.state === 'ready' ? rec.rec : null;
  const marks = useMemo(() => recommendationMarks(recommendation), [recommendation]);
  const recommended = useMemo(() => {
    const map = new Map<string, Recommended>();
    if (!recommendation) return map;
    const candidates = [recommendation.primary, ...recommendation.alternatives.map((a) => a.candidate), recommendation.autocomplete, recommendation.embedding];
    for (const c of candidates) {
      if (!c) continue;
      const key = selectionKey(c.modelId, c.quant);
      const mark = marks.get(key);
      if (mark && !map.has(key)) map.set(key, { mark, candidate: c });
    }
    return map;
  }, [recommendation, marks]);
  // Every other variant shows its own estimate, or that it does not fit.
  const fits = useMemo(() => fitsByKey(recommendation), [recommendation]);

  const models = useMemo(() => orderCatalog(filterByRole(registry?.models ?? [], filter), marks), [registry, filter, marks]);
  // Uncensored variants are listed apart, below the models Ylide recommends from.
  const groups = useMemo(() => splitUncensored(models), [models]);
  const ctx: EntryContext = {
    recommended,
    fits,
    installed: new Set(installedModels.map((m) => selectionKey(m.modelId, m.quant))),
    jobs,
    downloadsAllowed: allowed,
    downloadsOffNoteId: noteId,
    freeBytes,
  };

  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const entry = (m: Model) => <CatalogEntry key={m.id} model={m} mark={modelMark(marks, m)} expanded={expanded.has(m.id)} onToggle={() => toggle(m.id)} ctx={ctx} />;

  const reveal = (id: string) => {
    if (!models.some((m) => m.id === id)) setFilter('all');
    setExpanded((cur) => new Set(cur).add(id));
    requestAnimationFrame(() => {
      const el = document.getElementById(`catalog-${id}`);
      if (el) scrollToElement(el);
    });
  };

  return (
    <PageSection id={MODEL_SECTIONS.catalog} title={t('catalog.title')} description={t('catalog.description', { count: registry?.models.length ?? 0 })}>
      <div className={s.stack}>
        <RecommendationCard state={rec} onReveal={reveal} ctx={ctx} />
        {!allowed && (
          <div id={noteId}>
            <Note
              tone="warning"
              action={
                <Button size="sm" onClick={() => openSection('settings', SETTINGS_SECTIONS.network)}>
                  {t('catalog.openNetwork')}
                </Button>
              }
            >
              {t('catalog.downloadsOffNote')}
            </Note>
          </div>
        )}
        <div className={s.toolbar}>
          <Segmented<RoleFilter>
            label={t('catalog.filter')}
            value={filter}
            options={ROLE_FILTERS.map((r) => ({ value: r, label: r === 'all' ? t('catalog.all') : t(`common:modelRoles.${r}`) }))}
            onChange={setFilter}
            wrap
          />
          <span className={s.count} role="status">
            {t('catalog.shown', { count: models.length })}
          </span>
        </div>
        {models.length === 0 && <div className={s.empty}>{t('catalog.none')}</div>}
        {groups.normal.length > 0 && <EntryList>{groups.normal.map(entry)}</EntryList>}
        {groups.uncensored.length > 0 && (
          <div className={s.group}>
            <h3 id={uncensoredId} className={s.groupTitle}>
              {t('catalog.uncensored.title')}
            </h3>
            <UncensoredNote />
            <EntryList labelledBy={uncensoredId}>{groups.uncensored.map(entry)}</EntryList>
          </div>
        )}
        {(filter === 'all' || filter === 'chat' || filter === 'agent') && (
          <div className={s.own}>
            <FileInput size={14} className={s.ownIcon} aria-hidden />
            <div className={s.ownText}>
              <span className={s.ownTitle}>{t('catalog.own.title')}</span>
              <span className={s.ownBody}>{t('catalog.own.body')}</span>
            </div>
            <ImportButton />
          </div>
        )}
      </div>
    </PageSection>
  );
}

/** Catalog rows under the column headings; both groups share the columns. */
function EntryList({ labelledBy, children }: { labelledBy?: string; children: ReactNode }) {
  const { t } = useTranslation('settings');
  return (
    <div className={s.listWrap}>
      <div className={s.columns} aria-hidden>
        <span />
        <span>{t('catalog.model')}</span>
        <span>{t('catalog.parameters')}</span>
        <span>{t('catalog.maxContext')}</span>
        <span>{t('catalog.toolCalling')}</span>
        <span>{t('catalog.license')}</span>
      </div>
      <ul className={s.list} aria-labelledby={labelledBy}>
        {children}
      </ul>
    </div>
  );
}

function RecommendationCard({ state, onReveal, ctx }: { state: RecState; onReveal: (modelId: string) => void; ctx: EntryContext }) {
  const { t } = useTranslation('settings');
  const registry = useApp((st) => st.registry);
  const [busy, setBusy] = useState(false);
  const primary = state.state === 'ready' ? state.rec.primary : null;
  const key = primary ? selectionKey(primary.modelId, primary.quant) : '';
  const installed = !!primary && ctx.installed.has(key);
  const job = primary ? jobFor(ctx.jobs, primary.modelId, primary.quant) : undefined;
  // The download button is replaced by a badge once the first job event arrives.
  const actionsFocus = useFocusWhenReplaced<HTMLDivElement>(installed || !!job);

  if (state.state === 'loading') {
    return (
      <div className={s.recCard}>
        <div className={s.recLoading}>
          <Spinner label={t('catalog.recLoading')} />
          <span>{t('catalog.recLoading')}</span>
        </div>
      </div>
    );
  }
  if (state.state === 'error') return <Note tone="danger">{t('catalog.recFailed', { message: state.message })}</Note>;

  const { rec } = state;
  const budget = rec.budget;
  const reasonText = (r: Reason) => {
    const text = t(`common:reasons.${r.code}`, reasonParams(r, { level: (l) => t(`common:toolCallingLevel.${l}`), tokens: formatTokens }));
    return isSelfReported(r) ? `${text} (${t('common:reasons.benchmarkSelfReported')})` : text;
  };
  const notices = rec.notices.map(reasonText);

  const tooBig = !!primary && ctx.freeBytes !== null && primary.downloadBytes > ctx.freeBytes;

  const download = async (from: HTMLElement) => {
    if (!primary) return;
    const restoreFocus = keepFocusInSection(from);
    actionsFocus.arm();
    setBusy(true);
    try {
      await api.models.download(primary.modelId, primary.quant);
    } catch (e) {
      actionsFocus.disarm();
      reportError(e);
    } finally {
      setBusy(false);
      restoreFocus();
    }
  };

  return (
    <div className={s.recCard}>
      <div className={s.recHead}>
        <Cpu size={16} className={s.recIcon} aria-hidden />
        <span className={s.recLabel}>{t('catalog.recTitle')}</span>
        <span className={s.recBudget}>
          {budget.unified
            ? t('catalog.budgetUnified', { memory: formatGiB(budget.unifiedBytes) })
            : budget.vramBytes > 0
              ? t('catalog.budgetGpu', { gpu: budget.gpuName ?? t(`common:backend.${budget.backend}`), vram: formatGiB(budget.vramBytes), ram: formatGiB(budget.ramBytes) })
              : t('catalog.budgetCpu', { ram: formatGiB(budget.ramBytes) })}
        </span>
      </div>
      {primary ? (
        <>
          <div className={s.recMain}>
            <div className={s.recModel}>
              <span className={s.recName}>{modelName(registry, primary.modelId)}</span>
              <Badge tone="metal">{primary.quant}</Badge>
            </div>
            <div ref={actionsFocus.container} className={s.recActions}>
              <Button size="sm" variant="ghost" onClick={() => onReveal(primary.modelId)}>
                {t('catalog.showEntry')}
              </Button>
              {installed ? (
                <Badge tone="success">{t('catalog.installedBadge')}</Badge>
              ) : job ? (
                <Badge tone="accent">{t('catalog.downloadingBadge')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Download size={13} />}
                  loading={busy}
                  disabled={!ctx.downloadsAllowed || tooBig}
                  title={tooBig ? t('catalog.noSpace', { free: formatGB(ctx.freeBytes ?? 0) }) : undefined}
                  aria-describedby={!ctx.downloadsAllowed ? ctx.downloadsOffNoteId : undefined}
                  onClick={(e) => void download(e.currentTarget)}
                >
                  {t('catalog.downloadSize', { size: formatGB(primary.downloadBytes) })}
                </Button>
              )}
            </div>
          </div>
          <div className={s.recPlan}>
            {t('catalog.recPlan', {
              placement: t(`common:placement.${primary.plan.placement.kind}`),
              tps: formatNumber(primary.plan.estTokensPerSec),
              context: formatTokens(primary.plan.context),
            })}
          </div>
          <ul className={s.reasons}>
            {primary.reasons.map((r, i) => (
              <li key={i}>{reasonText(r)}</li>
            ))}
          </ul>
          {rec.alternatives.length > 0 && (
            <div className={s.alternatives}>
              <span className={s.altLabel}>{t('catalog.alternatives')}</span>
              {rec.alternatives.map((a) => (
                <button key={`${a.kind}-${a.candidate.modelId}-${a.candidate.quant}`} type="button" className={s.alt} onClick={() => onReveal(a.candidate.modelId)}>
                  <span className={s.altKind}>{t(markLabelKey({ kind: 'alternative', alternative: a.kind }))}</span>
                  <span>
                    {modelName(registry, a.candidate.modelId)} {a.candidate.quant}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className={s.recNone}>
          <p>{t('catalog.recNone')}</p>
          <ImportButton />
        </div>
      )}
      {notices.length > 0 && (
        <ul className={s.notices}>
          {notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
