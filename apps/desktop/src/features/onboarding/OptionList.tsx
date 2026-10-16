import type { KeyboardEvent } from 'react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Registry } from '../../bindings/Registry';
import { formatGiB, formatNumber } from '../../lib/format';
import { footprint, type ModelOption } from './recommend';
import s from './OptionList.module.css';

interface OptionListProps {
  options: ModelOption[];
  selected: string;
  registry: Registry | null;
  onSelect: (key: string) => void;
}

/**
 * The recommendation and its alternatives as a radio group. Every row shows
 * speed, quality and memory; the fact that makes an alternative different is
 * the one in full contrast.
 */
export function OptionList({ options, selected, registry, onSelect }: OptionListProps) {
  const { t } = useTranslation('onboarding');
  const baseId = useId();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    const jump = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
    if (!step && jump === null) return;
    e.preventDefault();
    const next = jump ?? (index + step + options.length) % options.length;
    onSelect(options[next].key);
    const radios = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios?.[next]?.focus();
  };

  return (
    <div className={s.list} role="radiogroup" aria-label={t('model.options')}>
      {options.map((o, i) => {
        const model = registry?.models.find((m) => m.id === o.candidate.modelId);
        const checked = o.key === selected;
        const lead = o.kind === 'faster' ? 'speed' : o.kind === 'stronger' ? 'quality' : o.kind === 'lighter' ? 'memory' : null;
        const id = `${baseId}-${i}`;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={`${id}-kind ${id}-name`}
            aria-describedby={`${id}-facts`}
            tabIndex={checked ? 0 : -1}
            className={s.option}
            onClick={() => onSelect(o.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <span className={s.radio} aria-hidden />
            <span className={s.main}>
              <span id={`${id}-kind`} className={s.kind}>{o.kind === 'primary' ? t('model.optionPrimary') : t(`common:alternatives.${o.kind}`)}</span>
              <span id={`${id}-name`} className={s.name}>
                {model?.name ?? o.candidate.modelId} <code className={s.quant}>{o.candidate.quant}</code>
              </span>
              <span id={`${id}-facts`} className={s.facts}>
                <span className={lead === 'speed' ? s.lead : ''}>{t('model.diff.speed', { value: formatNumber(o.candidate.plan.estTokensPerSec) })}</span>
                {model && (
                  <span className={lead === 'quality' ? s.lead : ''} title={t('model.diff.qualityHint')}>
                    {t('model.diff.quality', { value: formatNumber(model.quality.agentic) })}
                  </span>
                )}
                <span className={lead === 'memory' ? s.lead : ''}>{t('model.diff.memory', { value: formatGiB(footprint(o.candidate)) })}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
