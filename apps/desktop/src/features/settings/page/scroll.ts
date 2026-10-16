// Scrolling inside the page's own scroll area. `scrollIntoView` would also
// scroll the workbench's overflow-hidden ancestors and push the title bar away.

const OFFSET = 20;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function scrollToElement(el: HTMLElement, smooth = true): void {
  const root = el.closest<HTMLElement>('[data-scroll-root]');
  if (!root) return;
  const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - OFFSET;
  root.scrollTo({ top: Math.max(0, top), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
}
