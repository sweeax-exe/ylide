// A large monospace editor for prompts and templates. Saves on blur and with
// Ctrl+S, shows whether the text differs from the shipped default, and can
// insert `{placeholder}` fields at the caret.

import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, TextArea } from '../../../components/ui';
import { formatNumber } from '../../../lib/format';
import { insertText } from '../logic/templates';
import s from './controls.module.css';

/** Rough token estimate for display (about 3.5 characters per token for English prose and code). */
const approxTokens = (text: string) => Math.ceil(text.length / 3.5);

export function PromptEditor({
  label,
  hint,
  value,
  defaultValue,
  onSave,
  rows = 12,
  placeholders,
  issues,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  /** `undefined` while defaults load (reset disabled); `null` when there is no default (reset hidden). */
  defaultValue: string | null | undefined;
  onSave: (text: string) => Promise<unknown> | unknown;
  rows?: number;
  placeholders?: readonly string[];
  /** Rendered under the editor, computed from the current draft. */
  issues?: (draft: string) => ReactNode;
}) {
  const { t } = useTranslation('settings');
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<{ start: number; end: number }>({ start: value.length, end: value.length });
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = (text = draft) => {
    editing.current = false;
    if (text !== value) void onSave(text);
  };

  const insert = (name: string) => {
    const { start, end } = caret.current;
    const next = insertText(draft, start, end, `{${name}}`);
    editing.current = true;
    setDraft(next.text);
    caret.current = { start: next.caret, end: next.caret };
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const hasDefault = defaultValue !== null;
  const isDefault = typeof defaultValue === 'string' && value === defaultValue;

  return (
    <div className={s.prompt}>
      <div className={s.promptHead}>
        <label htmlFor={id} className={s.rowLabel}>
          {label}
        </label>
        {typeof defaultValue === 'string' && <Badge tone={isDefault ? 'neutral' : 'accent'}>{isDefault ? t('prompt.isDefault') : t('prompt.isChanged')}</Badge>}
        <span className={s.grow} />
        {hasDefault && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={13} />}
            // Several editors share a group; the name says which one is reset.
            aria-label={t('prompt.resetNamed', { name: label })}
            disabled={typeof defaultValue !== 'string' || (isDefault && draft === value)}
            onClick={() => {
              if (typeof defaultValue !== 'string') return;
              editing.current = false;
              setDraft(defaultValue);
              void onSave(defaultValue);
              // This button is disabled now; continue in the editor instead of losing focus.
              area.current?.focus();
            }}
          >
            {t('common:actions.reset')}
          </Button>
        )}
      </div>
      {hint && (
        <div className={s.rowHint} id={`${id}-hint`}>
          {hint}
        </div>
      )}
      {placeholders && placeholders.length > 0 && (
        <div className={s.placeholders} role="group" aria-label={t('prompt.insertPlaceholder')}>
          <span className={s.placeholdersLabel}>{t('prompt.placeholders')}</span>
          {placeholders.map((p) => (
            <button
              key={p}
              type="button"
              className={s.placeholder}
              title={t('prompt.insertNamed', { name: `{${p}}` })}
              // Keep the caret in the editor when inserting with the mouse.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(p)}
            >
              {`{${p}}`}
            </button>
          ))}
        </div>
      )}
      <TextArea
        ref={area}
        id={id}
        className={s.promptArea}
        rows={rows}
        value={draft}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
        }}
        onSelect={(e) => {
          caret.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            commit();
            editing.current = true;
          }
        }}
      />
      <div className={s.promptFoot}>
        <span className={s.promptIssues}>{issues?.(draft)}</span>
        <span className="tabular">{t('prompt.size', { chars: formatNumber(draft.length), tokens: formatNumber(approxTokens(draft)) })}</span>
      </div>
    </div>
  );
}
