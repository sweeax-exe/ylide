// "Import GGUF file" on the Models page. After the import a toast offers to
// use the model right away, the same as its Use button under Installed models.

import { FileInput } from 'lucide-react';
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui';
import type { InstalledModel } from '../../../bindings/InstalledModel';
import { reportError } from '../../../lib/errors';
import { useApp } from '../../../state/app';
import { useToasts } from '../../../state/toasts';
import { assignModel, slotOf, type Slot } from './assign';
import { useGgufImport } from './useGgufImport';

interface ImportButtonProps {
  size?: 'sm' | 'md';
  variant?: 'primary' | 'secondary';
}

export const ImportButton = forwardRef<HTMLButtonElement, ImportButtonProps>(function ImportButton({ size = 'sm', variant }, ref) {
  const { t } = useTranslation('settings');
  const { importing, importFile } = useGgufImport(t('installed.importFailed'), (model) => {
    const slot = slotOf(model);
    useToasts.getState().push({
      tone: 'success',
      title: t('installed.imported', { name: model.name }),
      // It stays until used or closed, so there is time to reach the button.
      duration: 0,
      action: {
        label: t(`installed.use.${slot}`),
        run: () => {
          if (stillWanted(model, slot)) void assignModel(model, slot).catch((e: unknown) => reportError(e));
        },
      },
    });
  });
  return (
    <Button ref={ref} size={size} variant={variant} icon={<FileInput size={14} />} loading={importing} onClick={(e) => void importFile(e.currentTarget)}>
      {t('installed.import')}
    </Button>
  );
});

/** The toast stays open: when its button is used, the model may be gone, or already chosen and running. */
function stillWanted(model: InstalledModel, slot: Slot): boolean {
  const { installed, settings, server } = useApp.getState();
  const same = (m: { modelId: string; quant: string } | null | undefined) => !!m && m.modelId === model.modelId && m.quant === model.quant;
  if (!installed.some(same)) return false;
  if (!same(settings?.models[slot])) return true;
  // Chosen already; for chat it is only done once its server runs.
  const running = !!server && server.runtime !== 'external' && same(server) && server.status.state !== 'stopped' && server.status.state !== 'crashed';
  return slot === 'chat' && !running;
}
