import { Braces, FileText, Folder, GraduationCap, ScanText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContextKind } from '../../bindings/ContextKind';
import { formatNumber } from '../../lib/format';
import s from './ContextChip.module.css';

const ICONS: Record<ContextKind, typeof FileText> = { file: FileText, folder: Folder, symbol: Braces, selection: ScanText, skill: GraduationCap };

export interface ChipData {
  kind: ContextKind;
  label: string;
  /** Unknown until the context is resolved. */
  tokens: number | null;
  truncated: boolean;
  error: string | null;
}

/**
 * One piece of attached context. With `onOpen` it opens the file it refers
 * to; with `onRemove` it shows a remove button (composer).
 */
export function ContextChip({ chip, title, onOpen, onRemove }: { chip: ChipData; title?: string; onOpen?: () => void; onRemove?: () => void }) {
  const { t } = useTranslation('chat');
  const Icon = ICONS[chip.kind];
  const tone = chip.error ? s.danger : chip.truncated ? s.warning : '';
  const hint = chip.error ? t('context.error', { message: chip.error }) : chip.truncated ? t('context.truncated') : undefined;
  const body = (
    <>
      <Icon size={12} aria-hidden className={s.icon} />
      <span className={s.label}>{chip.label}</span>
      {chip.tokens !== null && !chip.error && <span className={s.tokens}>{formatNumber(chip.tokens)}</span>}
    </>
  );
  const fullTitle = [title, chip.tokens !== null && !chip.error ? t('common:units.tokens', { value: formatNumber(chip.tokens) }) : null, hint].filter(Boolean).join(' · ');

  return (
    <span className={`${s.chip} ${tone}`} title={fullTitle} role="listitem">
      {onOpen ? (
        <button type="button" className={s.main} onClick={onOpen}>
          {body}
        </button>
      ) : (
        <span className={s.main}>{body}</span>
      )}
      {hint && <span className="visually-hidden">{hint}</span>}
      {onRemove && (
        <button type="button" className={s.remove} onClick={onRemove} aria-label={t('composer.removeMention', { label: chip.label })} title={t('composer.removeMention', { label: chip.label })}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}
