// Layout shared by the settings and models views: a scrollable page with a
// content column and, at wide widths, a section navigation on the left.

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSectionTarget, type View } from './navigation';
import s from './Page.module.css';
import { scrollToElement } from './scroll';

export interface SectionLink {
  id: string;
  title: string;
}

/** Distance from the top of the scroll area at which a section counts as current. */
const SPY_OFFSET = 96;

export function Page({ view, title, intro, sections, children }: { view: View; title: string; intro?: ReactNode; sections: SectionLink[]; children: ReactNode }) {
  const { t } = useTranslation('settings');
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(sections[0]?.id ?? '');
  const target = useSectionTarget((st) => st.target);
  const clearTarget = useSectionTarget((st) => st.clear);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top;
      let id = sections[0]?.id ?? '';
      for (const sec of sections) {
        const el = document.getElementById(sec.id);
        if (el && el.getBoundingClientRect().top - top <= SPY_OFFSET) id = sec.id;
      }
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) id = sections[sections.length - 1]?.id ?? id;
      setCurrent(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [sections]);

  const go = useCallback((id: string, smooth: boolean) => {
    const el = document.getElementById(id);
    if (!el) return;
    scrollToElement(el, smooth);
    el.querySelector<HTMLElement>('[data-section-title]')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (target?.view !== view) return;
    // Wait one frame so sections that depend on loaded data have rendered.
    // The target is cleared only then: clearing re-runs this effect and its
    // cleanup would cancel the frame.
    const frame = requestAnimationFrame(() => {
      go(target.section, false);
      clearTarget();
    });
    return () => cancelAnimationFrame(frame);
  }, [target, view, go, clearTarget]);

  return (
    <div ref={scroller} className={s.page} data-scroll-root>
      <div className={s.layout}>
        <nav className={s.nav} aria-label={t('page.sectionsLabel', { page: title })}>
          <ul className={s.navList}>
            {sections.map((sec) => (
              <li key={sec.id}>
                <button type="button" className={s.navItem} aria-current={current === sec.id ? 'location' : undefined} onClick={() => go(sec.id, true)}>
                  {sec.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={s.content}>
          <header className={s.header}>
            <h1 className={s.title}>{title}</h1>
            {intro && <p className={s.intro}>{intro}</p>}
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

export function PageSection({ id, title, description, actions, children }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={s.section} aria-labelledby={`${id}-title`}>
      <header className={s.sectionHead}>
        <div className={s.sectionText}>
          <h2 id={`${id}-title`} className={s.sectionTitle} tabIndex={-1} data-section-title>
            {title}
          </h2>
          {description && <p className={s.sectionDesc}>{description}</p>}
        </div>
        {actions && <div className={s.sectionActions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}
