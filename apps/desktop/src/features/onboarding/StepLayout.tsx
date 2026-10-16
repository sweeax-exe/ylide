import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui';
import s from './StepLayout.module.css';

interface StepLayoutProps {
  /** Shown above the heading (the logo on the welcome step). */
  mark?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  /** The welcome headline uses the display size. */
  display?: boolean;
  /** Scan and model steps may use two columns on wide windows. */
  wide?: boolean;
  onBack?: () => void;
  /** Text at the start of the footer, e.g. what the primary action will do. */
  note?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * Frame of one onboarding step: heading, lead, body and a footer that stays
 * visible when the body scrolls. Focus moves to the heading when a step opens,
 * so keyboard and screen reader users start at the top of the new step.
 */
export function StepLayout({ mark, title, lead, display, wide, onBack, note, actions, children }: StepLayoutProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section className={`${s.step} ${wide ? s.wide : ''} ${display ? s.hero : ''}`} aria-labelledby={headingId}>
      <div className={s.inner}>
        <header className={s.header}>
          {mark}
          <h1 ref={heading} id={headingId} tabIndex={-1} className={display ? s.display : s.title}>
            {title}
          </h1>
          {lead && <p className={display ? s.heroLead : s.lead}>{lead}</p>}
        </header>
        {children}
      </div>
      <footer className={s.footer}>
        <div className={s.footerInner}>
          {onBack && (
            <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden />} onClick={onBack}>
              {t('actions.back')}
            </Button>
          )}
          {note && <span className={s.note}>{note}</span>}
          <span className={s.grow} />
          {actions}
        </div>
      </footer>
    </section>
  );
}
