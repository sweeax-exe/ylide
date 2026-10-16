import { Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../state/app';
import { isLocalAddress } from './endpoint';
import { type ModelPath, STEPS, type StepId, stepStates } from './flow';
import s from './StepRail.module.css';

/** The setup sequence as one world line: steps behind the user are drawn in the signal colour. */
export function StepRail({ current, path }: { current: StepId; path: ModelPath | null }) {
  const { t } = useTranslation('onboarding');
  const version = useApp((st) => st.info?.version);
  const states = stepStates(current, path);
  // The promise only holds while models run here (or on a server on this computer).
  const local = path?.kind !== 'external' || isLocalAddress(path.baseUrl);
  return (
    <nav className={s.rail} aria-label={t('steps.label')}>
      <ol className={s.list}>
        {STEPS.map((step, i) => {
          const state = states[step];
          return (
            <li key={step} className={`${s.item} ${s[state]}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className={s.node} aria-hidden>
                {state === 'done' ? <Check size={11} strokeWidth={3} /> : state === 'skipped' ? <Minus size={11} strokeWidth={2.5} /> : i + 1}
              </span>
              <span className={s.text}>
                <span className={s.label}>{t(`steps.${step}`)}</span>
                {state === 'skipped' && <span className={s.note}>{t('steps.skipped')}</span>}
                {state === 'done' && <span className="visually-hidden">{t('steps.done')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className={s.footer}>
        {local && (
          <span className={s.local}>
            <span className={s.dot} aria-hidden />
            {t('rail.local')}
          </span>
        )}
        {version && <span className={s.version}>{t('rail.version', { version })}</span>}
      </div>
    </nav>
  );
}
