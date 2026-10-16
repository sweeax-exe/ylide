import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Recommendation } from '../../bindings/Recommendation';
import { windowControls } from '../../shell/window';
import { useApp } from '../../state/app';
import { DownloadStep } from './DownloadStep';
import { type ModelPath, type StepId, stepAfterModel } from './flow';
import { ModelStep } from './ModelStep';
import s from './Onboarding.module.css';
import { ReadyStep } from './ReadyStep';
import { type ScanResult, ScanStep } from './ScanStep';
import { StepRail } from './StepRail';
import { WelcomeStep } from './WelcomeStep';
import { WindowBar } from './WindowBar';

/**
 * First run, shown full-window instead of the workbench: welcome, hardware
 * scan, model recommendation, download and first start. Results of earlier
 * steps are kept here so going back never repeats work.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<StepId>('welcome');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [runtimeWanted, setRuntimeWanted] = useState(() => useApp.getState().settings?.network.allowRuntimeDownloads ?? true);
  const [path, setPath] = useState<ModelPath | null>(null);

  useEffect(() => {
    void windowControls.setTitle(t('app.name'));
  }, [t]);

  const onScan = useCallback((result: ScanResult) => {
    setScan(result);
    // A new measurement may change what fits.
    setRecommendation(null);
    setSelectedKey(null);
  }, []);

  const onChoose = useCallback((next: ModelPath) => {
    setPath(next);
    setStep(stepAfterModel(next));
  }, []);

  return (
    <div className={s.window}>
      <WindowBar />
      <div className={s.body}>
        <StepRail current={step} path={path} />
        {/* Keyed by step so every step opens scrolled to the top. */}
        <main key={step} className={s.content}>
          {step === 'welcome' && <WelcomeStep onNext={() => setStep('scan')} />}
          {step === 'scan' && <ScanStep result={scan} onResult={onScan} onBack={() => setStep('welcome')} onNext={() => setStep('model')} />}
          {step === 'model' && (
            <ModelStep
              recommendation={recommendation}
              onRecommendation={setRecommendation}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              runtimeWanted={runtimeWanted}
              onRuntimeWanted={setRuntimeWanted}
              onBack={() => setStep('scan')}
              onChoose={onChoose}
            />
          )}
          {step === 'download' && path?.kind === 'registry' && <DownloadStep path={path} onBack={() => setStep('model')} onNext={() => setStep('ready')} />}
          {step === 'ready' && path && <ReadyStep path={path} onChangeModel={() => setStep('model')} onDone={onDone} />}
        </main>
      </div>
    </div>
  );
}
