// Settings outside Ylide that would make models faster, such as a RAM kit
// that runs below its rated speed because its EXPO/XMP profile is off.

import { Lightbulb, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HardwareTips as Tips } from '../../../bindings/HardwareTips';
import { IconButton } from '../../../components/ui';
import { api } from '../../../lib/ipc';
import { Note } from '../page/controls';
import s from './HardwareTips.module.css';

const DISMISSED_KEY = 'ylide.tips.ramSpeed';

function readDismissed(): string | null {
  try {
    return globalThis.localStorage?.getItem(DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeDismissed(value: string) {
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, value);
  } catch {
    // storage unavailable: the tip comes back next time
  }
}

export function HardwareTips() {
  const { t } = useTranslation('settings');
  const [tips, setTips] = useState<Tips | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    // A tip is optional: without one (or on an error) nothing is shown.
    api.hardware.tips().then(setTips, () => setTips(null));
  }, []);

  const ram = tips?.ramSpeed;
  // Hidden until the situation changes (other modules or another speed).
  const id = ram ? `${ram.configuredMts}-${ram.ratedMts}` : null;
  if (!ram || dismissed === id) return null;

  return (
    <div className={s.tips}>
      <Note
        tone="metal"
        icon={<Lightbulb size={15} aria-hidden />}
        action={
          <IconButton
            label={t('tips.dismiss')}
            onClick={() => {
              writeDismissed(id!);
              setDismissed(id);
            }}
          >
            <X size={14} />
          </IconButton>
        }
      >
        <div className={s.title}>{t('tips.ramSpeed.title')}</div>
        <p className={s.body}>
          {t('tips.ramSpeed.body', { kind: ram.kind, part: ram.partNumber, configured: ram.configuredMts, rated: ram.ratedMts })}
        </p>
        <p className={s.caveat}>{t('tips.ramSpeed.caveat')}</p>
      </Note>
    </div>
  );
}
