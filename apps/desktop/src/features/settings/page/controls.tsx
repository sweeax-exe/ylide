// Setting rows and inputs that keep a local draft and commit on blur or Enter,
// so a value is saved once per edit instead of on every keystroke.

import { AlertTriangle, Check, RotateCcw } from 'lucide-react';
import type { InputHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, Switch, TextArea, TextInput } from '../../../components/ui';
import { formatLines, numberText, parseLines, parseNumber, sameList, type NumberRule } from '../logic/forms';
import s from './controls.module.css';
import { SaveProvider, useSaverState, type Saver, type SaveStatus } from './save';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ------------------------------------------------------------------ layout

export function SavedLabel({ status }: { status: SaveStatus }) {
  const { t } = useTranslation('settings');
  return (
    <span className={s.saved} role="status" aria-live="polite">
      {status === 'saved' && (
        <span className={s.savedInner}>
          <Check size={12} aria-hidden />
          {t('saved')}
        </span>
      )}
    </span>
  );
}

/** A titled panel of rows. Rows inside save through it and it shows "Saved". */
export function Group({
  title,
  description,
  actions,
  children,
  flush,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode | ((save: Saver) => ReactNode);
  /** Rows, or a function that receives the group's saver. */
  children: ReactNode | ((save: Saver) => ReactNode);
  /** Render children without the bordered panel (they bring their own). */
  flush?: boolean;
}) {
  const { save, status } = useSaverState();
  const id = useId();
  const body = typeof children === 'function' ? children(save) : children;
  return (
    <div className={s.group} role="group" aria-labelledby={id}>
      <div className={s.groupHead}>
        <div className={s.groupText}>
          <h3 id={id} className={s.groupTitle} tabIndex={-1} data-group-title>
            {title}
          </h3>
          {description && <p className={s.groupDesc}>{description}</p>}
        </div>
        <div className={s.groupActions}>
          <SavedLabel status={status} />
          {typeof actions === 'function' ? actions(save) : actions}
        </div>
      </div>
      <SaveProvider value={save}>{flush ? body : <div className={s.panel}>{body}</div>}</SaveProvider>
    </div>
  );
}

/** A bordered panel without its own title (lists, tables). */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(s.panel, className)}>{children}</div>;
}

interface RowIds {
  id: string;
  describedBy: string | undefined;
}

/** Label and hint on the left, control on the right; `wide` puts the control below. */
export function Row({ label, hint, warning, wide, children }: { label: ReactNode; hint?: ReactNode; warning?: ReactNode; wide?: boolean; children: (ids: RowIds) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cx(s.row, wide && s.wide)}>
      <div className={s.rowText}>
        <label className={s.rowLabel} htmlFor={id}>
          {label}
        </label>
        {hint && (
          <div id={hintId} className={s.rowHint}>
            {hint}
          </div>
        )}
        <WarningSlot>{warning}</WarningSlot>
      </div>
      <div className={s.rowControl}>{children({ id, describedBy: hint ? hintId : undefined })}</div>
    </div>
  );
}

/** A row whose control is not a single labelled input (button groups, segmented controls). */
export function StaticRow({ label, hint, warning, wide, children }: { label: ReactNode; hint?: ReactNode; warning?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx(s.row, wide && s.wide)}>
      <div className={s.rowText}>
        <div className={s.rowLabel}>{label}</div>
        {hint && <div className={s.rowHint}>{hint}</div>}
        <WarningSlot>{warning}</WarningSlot>
      </div>
      <div className={cx(s.rowControl, !wide && s.end)}>{children}</div>
    </div>
  );
}

export function SwitchRow({ label, hint, warning, checked, onChange, disabled }: { label: string; hint?: ReactNode; warning?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cx(s.row, s.switchRow)}>
      <div className={s.rowText}>
        {/* The switch carries the accessible name; this copy is the visible, clickable label. */}
        <div className={cx(s.rowLabel, !disabled && s.clickable)} aria-hidden onClick={() => !disabled && onChange(!checked)}>
          {label}
        </div>
        {hint && <div className={s.rowHint}>{hint}</div>}
        <WarningSlot>{warning}</WarningSlot>
      </div>
      <div className={cx(s.rowControl, s.end)}>
        <Switch checked={checked} onChange={onChange} disabled={disabled} label={<span className="visually-hidden">{label}</span>} />
      </div>
    </div>
  );
}

function WarningSlot({ children }: { children?: ReactNode }) {
  return (
    // Always rendered (it is empty and takes no space without a warning) so the live region exists before it is announced.
    <div aria-live="polite">
      {children && (
        <div className={s.warning}>
          <AlertTriangle size={13} aria-hidden className={s.warningIcon} />
          <span>{children}</span>
        </div>
      )}
    </div>
  );
}

export function Note({ tone = 'neutral', icon, children, action }: { tone?: 'neutral' | 'warning' | 'danger' | 'metal'; icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  // Warnings and errors carry an icon so they do not rely on colour alone.
  const shownIcon = icon ?? (tone === 'warning' || tone === 'danger' ? <AlertTriangle size={15} aria-hidden /> : null);
  return (
    <div className={cx(s.note, s[`note-${tone}`])}>
      {shownIcon && <span className={s.noteIcon}>{shownIcon}</span>}
      <div className={s.noteText}>{children}</div>
      {action && <div className={s.noteAction}>{action}</div>}
    </div>
  );
}

/**
 * A text button that resets a whole group or item. It is disabled once the
 * values are back to default, so focus then moves to the group title instead
 * of being dropped to the page.
 */
export function GroupResetButton({ disabled, onReset, variant = 'ghost', children }: { disabled: boolean; onReset: () => unknown; variant?: 'ghost' | 'secondary'; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Button
      ref={ref}
      size="sm"
      variant={variant}
      icon={<RotateCcw size={13} />}
      disabled={disabled}
      onClick={async () => {
        const group = ref.current?.closest('[role="group"]');
        await onReset();
        // After the re-render that disables this button.
        requestAnimationFrame(() => {
          const button = ref.current;
          if (!button || button.disabled || !button.isConnected) group?.querySelector<HTMLElement>('[data-group-title]')?.focus();
        });
      }}
    >
      {children}
    </Button>
  );
}

/**
 * Small "Reset to default" icon button placed next to a field. Hidden when the
 * value is the default; focus then moves to the field `fieldId` so it is not lost.
 */
export function ResetButton({ visible, onReset, label, fieldId }: { visible: boolean; onReset: () => void; label?: string; fieldId?: string }) {
  const { t } = useTranslation('settings');
  if (!visible) return null;
  return (
    <IconButton
      label={label ?? t('common:actions.reset')}
      onClick={() => {
        onReset();
        if (fieldId) document.getElementById(fieldId)?.focus();
      }}
    >
      <RotateCcw size={14} />
    </IconButton>
  );
}

// ------------------------------------------------------------------ inputs

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'id'>;

interface DraftOptions<T> {
  value: T;
  toText: (v: T) => string;
  /** Returns the parsed value, or an error message. */
  parse: (text: string) => { ok: true; value: T } | { ok: false; error: string };
  equal: (a: T, b: T) => boolean;
  onCommit: (v: T) => unknown;
}

/** Draft text that follows the stored value unless the user is editing it. */
function useDraft<T>({ value, toText, parse, equal, onCommit }: DraftOptions<T>) {
  const [text, setText] = useState(() => toText(value));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const external = toText(value);
  useEffect(() => {
    if (!editing.current) {
      setText(external);
      setError(null);
    }
  }, [external]);
  const commit = () => {
    editing.current = false;
    const parsed = parse(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (!equal(parsed.value, value)) void onCommit(parsed.value);
    else setText(toText(value));
  };
  const revert = () => {
    editing.current = false;
    setText(external);
    setError(null);
  };
  const change = (t: string) => {
    editing.current = true;
    setText(t);
  };
  return { text, error, commit, revert, change };
}

function inputKeys(commit: () => void, revert: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      revert();
    }
  };
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <div id={id} className={s.error}>
      {message}
    </div>
  );
}

export function TextSetting({
  id,
  describedBy,
  value,
  onCommit,
  validate,
  mono,
  ...rest
}: InputProps & { id: string; describedBy?: string; value: string; onCommit: (v: string) => unknown; validate?: (v: string) => string | null; mono?: boolean }) {
  const errId = `${id}-error`;
  const d = useDraft({
    value,
    toText: (v) => v,
    parse: (t) => {
      const problem = validate?.(t);
      return problem ? { ok: false, error: problem } : { ok: true, value: t };
    },
    equal: (a, b) => a === b,
    onCommit,
  });
  return (
    <div className={s.control}>
      <TextInput
        {...rest}
        id={id}
        className={cx(mono && s.mono)}
        value={d.text}
        onChange={(e) => d.change(e.target.value)}
        onBlur={d.commit}
        onKeyDown={inputKeys(d.commit, d.revert)}
        aria-invalid={d.error ? true : undefined}
        aria-describedby={[describedBy, d.error ? errId : null].filter(Boolean).join(' ') || undefined}
      />
      <FieldError id={errId} message={d.error} />
    </div>
  );
}

export function NumberSetting({
  id,
  describedBy,
  value,
  onCommit,
  rule,
  unit,
  placeholder,
  disabled,
  trailing,
}: {
  id: string;
  describedBy?: string;
  value: number | null;
  onCommit: (v: number | null) => unknown;
  rule: NumberRule;
  unit?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered after the unit, e.g. a reset button. */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const errId = `${id}-error`;
  const d = useDraft<number | null>({
    value,
    toText: numberText,
    parse: (text) => {
      const r = parseNumber(text, rule);
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: t(`validation.${r.problem}`, { min: rule.min, max: rule.max }) };
    },
    equal: (a, b) => a === b,
    onCommit,
  });
  return (
    <div className={s.control}>
      <div className={s.numberLine}>
        <TextInput
          id={id}
          className={s.number}
          inputMode={rule.integer ? 'numeric' : 'decimal'}
          value={d.text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => d.change(e.target.value)}
          onBlur={d.commit}
          onKeyDown={inputKeys(d.commit, d.revert)}
          aria-invalid={d.error ? true : undefined}
          aria-describedby={[describedBy, d.error ? errId : null].filter(Boolean).join(' ') || undefined}
        />
        {unit && <span className={s.unit}>{unit}</span>}
        {trailing}
      </div>
      <FieldError id={errId} message={d.error} />
    </div>
  );
}

/** A list of strings edited as one entry per line. */
export function LinesSetting({ id, describedBy, value, onCommit, rows = 4, placeholder }: { id: string; describedBy?: string; value: string[]; onCommit: (v: string[]) => unknown; rows?: number; placeholder?: string }) {
  const d = useDraft<string[]>({
    value,
    toText: formatLines,
    parse: (t) => ({ ok: true, value: parseLines(t) }),
    equal: sameList,
    onCommit,
  });
  return (
    <TextArea
      id={id}
      className={s.mono}
      rows={rows}
      value={d.text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => d.change(e.target.value)}
      onBlur={d.commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          d.revert();
        }
      }}
      aria-describedby={describedBy}
    />
  );
}
