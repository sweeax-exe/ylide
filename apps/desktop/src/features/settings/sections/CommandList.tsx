// Command prefixes an agent may run without asking.

import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, TextInput } from '../../../components/ui';
import { normalizePrefix, prefixProblem } from '../logic/commands';
import { Note, Panel } from '../page/controls';
import type { Saver } from '../page/save';
import s from './CommandList.module.css';

export function CommandList({ commands, askMode, save }: { commands: string[]; askMode: boolean; save: Saver }) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = prefixProblem(draft, commands);
  const shownProblem = touched && problem && problem !== 'empty' ? problem : null;

  const add = async () => {
    setTouched(true);
    if (problem) return;
    const prefix = normalizePrefix(draft);
    const ok = await save((d) => {
      d.agent.permissions.allowedCommands.push(prefix);
    });
    if (ok) {
      setDraft('');
      setTouched(false);
    }
  };

  const remove = (prefix: string) =>
    void save((d) => {
      d.agent.permissions.allowedCommands = d.agent.permissions.allowedCommands.filter((c) => c !== prefix);
    });

  return (
    <div className={s.wrap}>
      {askMode && <Note>{t('agents.commands.askMode')}</Note>}
      <Panel>
        {commands.length === 0 ? (
          <p className={s.empty}>{t('agents.commands.empty')}</p>
        ) : (
          <ul className={s.list} aria-label={t('agents.commands.title')}>
            {commands.map((c) => (
              <li key={c} className={s.item}>
                <code className={s.prefix}>{c}</code>
                <span className={s.example}>{t('agents.commands.alsoMatches', { example: `${c} …` })}</span>
                <IconButton label={t('agents.commands.remove', { prefix: c })} onClick={() => remove(c)}>
                  <X size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <form
          className={s.add}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label htmlFor={id} className="visually-hidden">
            {t('agents.commands.newLabel')}
          </label>
          <TextInput
            id={id}
            className={s.input}
            value={draft}
            placeholder={t('agents.commands.placeholder')}
            onChange={(e) => {
              setDraft(e.target.value);
              setTouched(true);
            }}
            aria-invalid={shownProblem ? true : undefined}
            aria-describedby={shownProblem ? `${id}-error` : undefined}
          />
          <Button type="submit" icon={<Plus size={14} />} disabled={problem !== null}>
            {t('agents.commands.add')}
          </Button>
        </form>
        {shownProblem && (
          <div id={`${id}-error`} className={s.error} role="alert">
            {t(`agents.commands.problem.${shownProblem}`)}
          </div>
        )}
      </Panel>
    </div>
  );
}
