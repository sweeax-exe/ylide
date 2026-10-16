// The Ylide braid: two world lines (qubit cyan and brass) that twist around
// each other. It animates only while a model is generating, so motion always
// means "the model is working".

import { useId } from 'react';
import s from './Braid.module.css';

export function Braid({ active = false, size = 20, label }: { active?: boolean; size?: number; label?: string }) {
  return (
    <svg
      className={`${s.braid} ${active ? s.active : ''}`}
      width={size * 1.6}
      height={size}
      viewBox="0 0 32 20"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path className={s.metal} d="M0 10 C 4 2, 8 2, 12 10 S 20 18, 24 10 S 32 2, 36 10" />
      <path className={s.gap} d="M-4 10 C 0 18, 4 18, 8 10 S 16 2, 20 10 S 28 18, 32 10" />
      <path className={s.qubit} d="M-4 10 C 0 18, 4 18, 8 10 S 16 2, 20 10 S 28 18, 32 10" />
    </svg>
  );
}

/** What the name stands for. Not translated, because it spells out the name. */
export const SLOGAN = 'Your Local IDE';

/**
 * The logo mark: two world lines braiding into a Y, in one colour (the text
 * colour unless `color` is set). The gap where one line passes under the other
 * is cut out, so it shows the surface behind in both themes. Same drawing as
 * src-tauri/icons/ylide.svg and docs/brand/ylide-mark.svg.
 */
export function LogoMark({ size = 22, color = 'var(--text-1)' }: { size?: number; color?: string }) {
  // Clip ids must be unique per instance (the mark appears several times).
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <clipPath id={`${id}-cut`}>
          <rect x="0" y="128" width="1024" height="768" />
        </clipPath>
        <clipPath id={`${id}-under`}>
          <path clipRule="evenodd" d="M-64 -64 H1088 V1088 H-64 Z M430.04 83.53 L725.72 435.91 L593.96 546.47 L298.28 194.09 Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-cut)`} fill="none" stroke={color} strokeWidth="120" strokeLinecap="butt">
        <path d="M736.04 48 L512 315 L436.05 405.51 A175 175 0 0 0 436.05 630.49 L474.57 676.39 A160 160 0 0 1 512 779.24 L512 976" clipPath={`url(#${id}-under)`} />
        <path d="M287.96 48 L512 315 L587.95 405.51 A175 175 0 0 1 587.95 630.49 L549.43 676.39 A160 160 0 0 0 512 779.24 L512 976" />
      </g>
    </svg>
  );
}
