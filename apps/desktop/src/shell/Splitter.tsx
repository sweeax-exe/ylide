import { useCallback } from 'react';
import s from './Workbench.module.css';

/** Drag handle that resizes a neighbouring panel. `direction` is +1 when dragging right grows it. */
export function Splitter({ width, onResize, min, max, direction, label }: { width: number; onResize: (w: number) => void; min: number; max: number; direction: 1 | -1; label: string }) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = width;
      const move = (ev: PointerEvent) => onResize(Math.max(min, Math.min(max, start + direction * (ev.clientX - startX))));
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
      };
      document.body.style.cursor = 'col-resize';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [width, onResize, min, max, direction],
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onResize(Math.max(min, Math.min(max, width - 16 * direction)));
    if (e.key === 'ArrowRight') onResize(Math.max(min, Math.min(max, width + 16 * direction)));
  };
  return (
    <div
      className={s.splitter}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
