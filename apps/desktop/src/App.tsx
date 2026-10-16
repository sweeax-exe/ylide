import { useEffect } from 'react';
import { ConfirmHost } from './components/ConfirmHost';
import { Toaster } from './components/Toaster';
import { Onboarding } from './features/onboarding/Onboarding';
import { reportError } from './lib/errors';
import { Workbench } from './shell/Workbench';
import { useApp } from './state/app';

export function App() {
  const ready = useApp((s) => s.ready);
  const onboardingDone = useApp((s) => s.settings?.onboardingDone ?? false);
  const init = useApp((s) => s.init);
  const updateSettings = useApp((s) => s.updateSettings);

  useEffect(() => {
    init().catch(reportError);
  }, [init]);

  if (!ready) return null;
  return (
    <>
      {onboardingDone ? (
        <Workbench />
      ) : (
        <Onboarding
          onDone={() =>
            updateSettings((s) => {
              s.onboardingDone = true;
            }).catch(reportError)
          }
        />
      )}
      <ConfirmHost />
      <Toaster />
    </>
  );
}
