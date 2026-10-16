// Shown when a project is open but no file: the few shortcuts that matter.

import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { LogoMark } from '../../components/Braid';
import { Kbd } from '../../components/ui';
import { useApp } from '../../state/app';
import s from './EditorArea.module.css';

type Modifier = 'ctrl' | 'shift';

const shortcuts: Array<{ key: string; keys: Array<Modifier | string> }> = [
  { key: 'goToFile', keys: ['ctrl', 'P'] },
  { key: 'editWithAi', keys: ['ctrl', 'K'] },
  { key: 'chat', keys: ['ctrl', 'L'] },
  { key: 'agents', keys: ['ctrl', 'shift', 'A'] },
  { key: 'search', keys: ['ctrl', 'shift', 'F'] },
];

const isModifier = (k: string): k is Modifier => k === 'ctrl' || k === 'shift';

export function Welcome() {
  const { t } = useTranslation('editor');
  const workspace = useApp((st) => st.workspace);
  return (
    <div className={s.center}>
      <div className={s.welcome}>
        <div className={s.welcomeHead}>
          <LogoMark size={28} />
          <div>
            <h2 className={s.welcomeTitle}>{workspace?.name}</h2>
            <p className={s.welcomeBody}>{t('welcome.body')}</p>
          </div>
        </div>
        <dl className={s.shortcuts}>
          {shortcuts.map((sc) => (
            <Fragment key={sc.key}>
              <dt>{t(`welcome.shortcuts.${sc.key}`)}</dt>
              <dd>
                {sc.keys.map((k) => (
                  <Kbd key={k}>{isModifier(k) ? t(`keys.${k}`) : k}</Kbd>
                ))}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}
