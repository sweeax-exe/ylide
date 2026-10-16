// Inline text field for creating or renaming an entry in the file tree.

import { useEffect, useRef, useState } from 'react';
import s from './FileTreePanel.module.css';

interface Props {
  initial: string;
  label: string;
  error: string | null;
  /** Resolves to true when the name was accepted and the field can close. */
  onCommit(name: string): Promise<boolean>;
  onCancel(): void;
  onChange(): void;
}

export function NameInput({ initial, label, error, onCommit, onCancel, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, like other editors do.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  /** On errors the field stays open with the message; focus returns to it only after Enter, so leaving it never traps focus. */
  const commit = async (fromBlur: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!value.trim() || value === initial) {
      onCancel();
      return;
    }
    const ok = await onCommit(value);
    if (ok) return;
    done.current = false;
    if (!fromBlur) ref.current?.focus();
  };

  return (
    <span className={s.nameField}>
      <input
        ref={ref}
        className={`${s.nameInput} ${error ? s.nameInvalid : ''}`}
        value={value}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          onChange();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
      />
      {error && (
        <span className={s.nameError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
