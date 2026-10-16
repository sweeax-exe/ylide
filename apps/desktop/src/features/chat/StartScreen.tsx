import { AtSign, BookOpen, Bug, CircleAlert, Compass, FlaskConical } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import type { Mention } from '../../bindings/Mention';
import { LogoMark } from '../../components/Braid';
import { KeyCap } from './KeyCap';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import s from './StartScreen.module.css';

type ExampleKey = 'overview' | 'explain' | 'review' | 'tests' | 'error';

interface Example {
  key: ExampleKey;
  icon: typeof Compass;
}

const PROJECT_EXAMPLES: Example[] = [
  { key: 'overview', icon: Compass },
  { key: 'explain', icon: BookOpen },
  { key: 'review', icon: Bug },
  { key: 'tests', icon: FlaskConical },
];

// Without a project there is nothing to give an overview of or to select.
const PLAIN_EXAMPLES: Example[] = [
  { key: 'explain', icon: BookOpen },
  { key: 'tests', icon: FlaskConical },
  { key: 'error', icon: CircleAlert },
];

/** Calm first screen of an empty conversation; examples fill the composer. */
export function StartScreen({ onExample }: { onExample: (template: string, mentions: Mention[]) => void }) {
  const { t } = useTranslation('chat');
  const hasProject = useApp((st) => st.workspace !== null);
  // "Never leaves this computer" is only true for the managed local runtime.
  const external = useApp((st) => st.server?.runtime === 'external' || (!st.server && st.settings?.endpoint.enabled === true));

  // Examples attach the context they talk about, when it exists.
  const contextFor = (key: ExampleKey): Mention[] => {
    if (!hasProject) return [];
    if (key === 'overview') return [{ type: 'folder', path: '' }];
    const selection = useEditorBridge.getState().selection;
    if (key === 'review' && selection) return [{ type: 'selection', path: selection.path, startLine: selection.startLine, endLine: selection.endLine, text: selection.text }];
    return [];
  };

  return (
    <div className={s.start}>
      <div className={s.intro}>
        <LogoMark size={28} />
        <h2 className={s.title}>{t(hasProject ? 'start.title' : 'start.titleNoProject')}</h2>
        <p className={s.body}>{t(external ? 'start.bodyExternal' : 'start.body')}</p>
      </div>
      <ul className={s.examples} aria-label={t('start.examples')}>
        {(hasProject ? PROJECT_EXAMPLES : PLAIN_EXAMPLES).map(({ key, icon: Icon }) => {
          const template = t(`examples.${key}`);
          return (
            <li key={key}>
              <button type="button" className={s.example} onClick={() => onExample(template, contextFor(key))}>
                <Icon size={15} className={s.exampleIcon} aria-hidden />
                <span>{template.replace('@', '…').trim()}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className={s.hints}>
        {/* Without a project the composer explains how to open one. */}
        {hasProject && (
          <p className={s.hint}>
            <AtSign size={13} className={s.hintIcon} aria-hidden />
            <span>{t('start.mentionHint')}</span>
          </p>
        )}
        <p className={s.keys}>
          <Trans t={t} i18nKey="start.keys" components={[<KeyCap key="enter" />, <KeyCap key="shift" />, <KeyCap key="enter2" />]} />
        </p>
      </div>
    </div>
  );
}
