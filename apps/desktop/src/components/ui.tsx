// Shared building blocks. Features compose these; they never restyle them.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import s from './ui.module.css';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

export type Tone = 'neutral' | 'accent' | 'metal' | 'success' | 'warning' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, children, className, disabled, onClick, ...rest },
  ref,
) {
  // While loading the button stays focusable (aria-disabled instead of
  // disabled), so keyboard focus is not dropped to <body>.
  return (
    <button
      ref={ref}
      className={cx(s.button, s[variant], size !== 'md' && s[size], className)}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name, also shown as tooltip. */
  label: string;
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, pressed, className, children, ...rest }, ref) {
  return (
    <button ref={ref} className={cx(s.iconButton, className)} aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
});

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={cx(s.badge, s[`tone-${tone}`])} title={title}>
      {children}
    </span>
  );
}

/** A key cap. `children` is optional so it can be a `<Trans>` placeholder. */
export function Kbd({ children }: { children?: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className={s.spinner} role="status" aria-label={label} />;
}

export interface Segment {
  value: number;
  tone?: 'accent' | 'metal' | 'success' | 'warning' | 'danger' | 'muted';
  label?: string;
}

/** A progress bar (`value` 0..1) or a stacked bar of `segments` (fractions of the whole). */
export function Progress({ value, segments, tone = 'accent', label }: { value?: number; segments?: Segment[]; tone?: Segment['tone']; label?: string }) {
  const parts = segments ?? [{ value: value ?? 0, tone }];
  const now = value !== undefined ? Math.round(value * 100) : undefined;
  return (
    <div className={s.progress} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={now}>
      {parts.map((p, i) => (
        <div key={i} className={cx(s.progressSegment, s[`fill-${p.tone ?? 'accent'}`])} style={{ width: `${Math.max(0, Math.min(1, p.value)) * 100}%` }} title={p.label} />
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <div className={s.hint}>{hint}</div>}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(s.input, className)} spellCheck={false} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(s.textarea, className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(s.select, className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={s.switch}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={s.switchTrack} aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  wrap,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
  /** Lets the segments wrap onto more lines in a narrow column instead of widening it. */
  wrap?: boolean;
}) {
  return (
    <div className={cx(s.segmented, wrap && s.segmentedWrap)} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={s.segment} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <h3 className={s.emptyTitle}>{title}</h3>
      {body && <p className={s.emptyBody}>{body}</p>}
      {action}
    </div>
  );
}

export function SectionHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className={s.sectionHeader}>
      <span className={s.sectionTitle}>{title}</span>
      {actions && <div className={s.sectionActions}>{actions}</div>}
    </div>
  );
}
