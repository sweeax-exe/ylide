import { FileInput, Info, Plug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Recommendation } from '../../bindings/Recommendation';
import { Button, Spinner, Switch } from '../../components/ui';
import { errorText, reportError } from '../../lib/errors';
import { formatBytes, formatGB } from '../../lib/format';
import { api } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useGgufImport } from '../settings/models/useGgufImport';
import { ExternalServerDialog } from './ExternalServerDialog';
import type { ModelPath } from './flow';
import s from './ModelStep.module.css';
import { OptionList } from './OptionList';
import { modelOptions, runtimeOffer } from './recommend';
import { ReasonText, SpecSheet } from './SpecSheet';
import { StepLayout } from './StepLayout';

interface ModelStepProps {
  recommendation: Recommendation | null;
  onRecommendation: (r: Recommendation) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  runtimeWanted: boolean;
  onRuntimeWanted: (wanted: boolean) => void;
  onBack: () => void;
  onChoose: (path: ModelPath) => void;
}

export function ModelStep({ recommendation, onRecommendation, selectedKey, onSelect, runtimeWanted, onRuntimeWanted, onBack, onChoose }: ModelStepProps) {
  const { t } = useTranslation('onboarding');
  const registry = useApp((st) => st.registry);
  const installed = useApp((st) => st.installed);
  const runtime = useApp((st) => st.runtime);
  const refreshRuntime = useApp((st) => st.refreshRuntime);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [whyOpen, setWhyOpen] = useState(false);
  const [serverDialog, setServerDialog] = useState(false);
  const { importing, importFile } = useGgufImport(t('model.importFailed'), (model) => onChoose({ kind: 'imported', model }));

  useEffect(() => {
    refreshRuntime().catch((e: unknown) => reportError(e));
  }, [refreshRuntime]);

  useEffect(() => {
    if (recommendation) return;
    let alive = true;
    api
      .recommend()
      .then((r) => alive && onRecommendation(r))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [recommendation, onRecommendation, attempt]);

  const options = useMemo(() => (recommendation ? modelOptions(recommendation) : []), [recommendation]);
  const selected = options.find((o) => o.key === selectedKey) ?? options[0] ?? null;
  const model = selected ? registry?.models.find((m) => m.id === selected.candidate.modelId) : undefined;
  const isInstalled = selected ? installed.some((m) => m.modelId === selected.candidate.modelId && m.quant === selected.candidate.quant) : false;
  const offer = runtimeOffer(runtime);
  const withRuntime = offer !== null && runtimeWanted;

  const closeDialog = useCallback(() => setServerDialog(false), []);

  const choose = () => {
    if (!selected) return;
    onChoose({ kind: 'registry', candidate: selected.candidate, needsModel: !isInstalled, runtimeVariant: withRuntime ? offer.variant : null });
  };

  const total = (isInstalled ? 0 : (selected?.candidate.downloadBytes ?? 0)) + (withRuntime ? offer.sizeBytes : 0);
  const primaryLabel = !selected || isInstalled
    ? isInstalled && withRuntime
      ? t('model.downloadRuntime', { size: formatGB(total) })
      : t('model.useModel')
    : withRuntime
      ? t('model.downloadBoth', { size: formatGB(total) })
      : t('model.download', { size: formatGB(total) });

  return (
    <StepLayout
      wide
      title={t('model.title')}
      lead={t('model.lead')}
      onBack={onBack}
      actions={
        // Without a candidate the ways out are the file and server buttons in the body.
        (selected || !recommendation) && (
          <Button variant="primary" size="lg" disabled={!selected} onClick={choose}>
            {primaryLabel}
          </Button>
        )
      }
    >
      {!recommendation && !error && (
        <div className={s.loading} role="status">
          <Spinner />
          {t('model.loading')}
        </div>
      )}
      {(recommendation || error !== null) && (
        <div className={s.layout}>
          <div className={s.main}>
            {recommendation ? (
              <>
                {recommendation.notices.length > 0 && (
                  <ul className={s.notices}>
                    {recommendation.notices.map((n) => (
                      <li key={n.code} className={s.notice}>
                        <Info size={15} aria-hidden />
                        <span>
                          <ReasonText reason={n} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {selected ? (
                  <SpecSheet option={selected} model={model} budget={recommendation.budget} installed={isInstalled} whyOpen={whyOpen} onWhyOpen={setWhyOpen} key={selected.key} />
                ) : (
                  // The core's nothingFits notice above already says this.
                  !recommendation.notices.some((n) => n.code === 'nothingFits') && (
                    <div className={s.nothing}>
                      <p>{t('model.nothingBody')}</p>
                    </div>
                  )
                )}
              </>
            ) : (
              <div className={s.failure} role="alert">
                <p>{t('model.failed', { error: errorText(error) })}</p>
                <Button
                  onClick={() => {
                    setError(null);
                    setAttempt((a) => a + 1);
                  }}
                >
                  {t('common:actions.retry')}
                </Button>
              </div>
            )}
          </div>
          {/* Every state offers the own file and the server; without a fitting candidate the file is the main way on. */}
          <aside className={s.aside}>
            {selected && options.length > 1 && (
              <div className={s.block}>
                <h3 className={s.asideTitle}>{t('model.options')}</h3>
                <OptionList options={options} selected={selected.key} registry={registry} onSelect={onSelect} />
              </div>
            )}
            {selected && offer && (
              <div className={`${s.block} ${s.runtime}`}>
                <Switch
                  checked={runtimeWanted}
                  onChange={onRuntimeWanted}
                  label={<span className={s.runtimeLabel}>{t('model.runtime.label', { size: formatBytes(offer.sizeBytes) })}</span>}
                />
                <p className={s.runtimeBody}>{t('model.runtime.body')}</p>
              </div>
            )}
            <OwnModel importing={importing} primary={!!recommendation && !selected} onImport={() => void importFile()} />
            <div className={s.otherWays}>
              <h3 className={s.asideTitle}>{t('model.otherWays')}</h3>
              <Button variant="ghost" icon={<Plug size={15} aria-hidden />} onClick={() => setServerDialog(true)}>
                {t('model.external')}
              </Button>
            </div>
          </aside>
        </div>
      )}
      {serverDialog && <ExternalServerDialog open onClose={closeDialog} onConnect={onChoose} />}
    </StepLayout>
  );
}

/** A GGUF file the user already has, such as a fine-tune: used as it is, nothing to download. */
function OwnModel({ importing, primary, onImport }: { importing: boolean; primary: boolean; onImport: () => void }) {
  const { t } = useTranslation('onboarding');
  return (
    <div className={s.own}>
      <FileInput size={16} className={s.ownIcon} aria-hidden />
      <div className={s.ownText}>
        <h3 className={s.asideTitle}>{t('model.own.title')}</h3>
        <p className={s.ownBody}>{t('model.own.body')}</p>
        <Button variant={primary ? 'primary' : 'secondary'} loading={importing} onClick={onImport}>
          {t('model.own.choose')}
        </Button>
      </div>
    </div>
  );
}
