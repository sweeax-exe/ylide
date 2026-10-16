// Many actions disable or replace the button that triggered them: the shared
// Button is disabled while `loading`, Download becomes a progress bar, Use
// becomes a badge. The browser then drops focus to the page body; these
// helpers keep keyboard users where they were working.

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const afterRender = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

const focusLost = () => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
};

/**
 * Call with the clicked element before the action and run the returned
 * function after it. If focus was lost meanwhile, it goes back to that element
 * when it is usable again, otherwise to the nearest control that is still
 * there (e.g. Stop, which replaced Start), otherwise to the section title.
 */
export function keepFocusInSection(from: HTMLElement | null): () => void {
  const section = from?.closest('section') ?? null;
  const ancestors: Element[] = [];
  for (let el = from?.parentElement ?? null; el && el !== section; el = el.parentElement) ancestors.push(el);
  // Two frames: the re-render that re-enables or replaces the button has committed by then.
  return () =>
    afterRender(() => {
      if (!focusLost()) return;
      if (from?.isConnected && !from.matches(':disabled')) {
        from.focus();
        return;
      }
      for (const el of ancestors) {
        if (!el.isConnected) continue;
        const target = el.querySelector<HTMLElement>(FOCUSABLE);
        if (target) {
          target.focus();
          return;
        }
      }
      section?.querySelector<HTMLElement>('[data-section-title]')?.focus({ preventScroll: true });
    });
}

/**
 * For a button that is replaced only when a later core event arrives (a
 * download job): after `arm()`, once `present` turns true, focus moves to the
 * first control in `container` if it was lost.
 */
export function useFocusWhenReplaced<T extends HTMLElement>(present: boolean): { container: RefObject<T | null>; arm: () => void; disarm: () => void } {
  const container = useRef<T>(null);
  const armed = useRef(false);
  useEffect(() => {
    if (!present || !armed.current) return;
    armed.current = false;
    if (focusLost()) container.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [present]);
  return {
    container,
    arm: () => {
      armed.current = true;
    },
    disarm: () => {
      armed.current = false;
    },
  };
}
