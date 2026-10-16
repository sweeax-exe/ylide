import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Settings } from '../../bindings/Settings';
import type { ThemeChoice } from '../../bindings/ThemeChoice';
import { LogoMark, SLOGAN } from '../../components/Braid';
import { LanguageSelect } from '../../components/LanguageSelect';
import { Button, Segmented } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { useApp } from '../../state/app';
import { StepLayout } from './StepLayout';
import s from './WelcomeStep.module.css';

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation('onboarding');
  const language = useApp((st) => st.settings?.language ?? null);
  const theme = useApp((st) => st.settings?.theme ?? 'dark');
  const updateSettings = useApp((st) => st.updateSettings);

  // updateSettings clones the current settings when called, so two quick
  // clicks would each save a copy without the other's change. Run them in order.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const save = (change: (draft: Settings) => void) => {
    queue.current = queue.current.then(() => updateSettings(change)).catch((e: unknown) => reportError(e));
  };

  return (
    <StepLayout
      display
      mark={
        <div className={s.lockup}>
          <LogoMark size={44} />
          {/* The name spelled out; English in every language, like the name. */}
          <span className={s.slogan} lang="en">
            {SLOGAN}
          </span>
        </div>
      }
      title={t('welcome.title')}
      lead={t('welcome.body')}
      note={t('welcome.hint')}
      actions={
        <Button variant="primary" size="lg" onClick={onNext}>
          {t('welcome.start')}
        </Button>
      }
    >
      <div className={s.prefs}>
        <div className={s.pref}>
          <span className={s.prefLabel}>{t('welcome.language')}</span>
          <LanguageSelect
            label={t('welcome.language')}
            systemLabel={t('welcome.languageSystem')}
            value={language}
            onChange={(v) =>
              save((d) => {
                d.language = v;
              })
            }
          />
        </div>
        <div className={s.pref}>
          <span className={s.prefLabel}>{t('welcome.theme')}</span>
          <Segmented<ThemeChoice>
            label={t('welcome.theme')}
            value={theme}
            options={[
              { value: 'dark', label: t('welcome.themeDark') },
              { value: 'light', label: t('welcome.themeLight') },
              { value: 'system', label: t('welcome.themeSystem') },
            ]}
            onChange={(v) =>
              save((d) => {
                d.theme = v;
              })
            }
          />
        </div>
      </div>
    </StepLayout>
  );
}
