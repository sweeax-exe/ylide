// A small context menu: a floating layer with arrow-key navigation that
// closes on Escape, Tab, outside clicks and window changes.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import s from './ContextMenu.module.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

export type MenuEntry = MenuItem | 'separator';

interface Props {
  x: number;
  y: number;
  items: MenuEntry[];
  label: string;
  onClose(): void;
}

export function ContextMenu({ x, y, items, label, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Focus goes back to where the menu was opened from. This runs before the
  // menu leaves the DOM, so a dialog opened by a menu item remembers the
  // opener (not the document body) and an inline field can still take focus.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && !ref.current?.contains(document.activeElement) ? document.activeElement : null;
    const menu = ref.current;
    return () => {
      if (opener?.isConnected && menu?.contains(document.activeElement)) opener.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) });
    el.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  const focusItem = (step: number | 'first' | 'last') => {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    if (!nodes.length) return;
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    const next = step === 'first' ? 0 : step === 'last' ? nodes.length - 1 : (current + step + nodes.length) % nodes.length;
    nodes[next].focus();
  };

  const select = (item: MenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  return createPortal(
    <div
      ref={ref}
      className={s.menu}
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') focusItem(1);
        else if (e.key === 'ArrowUp') focusItem(-1);
        else if (e.key === 'Home') focusItem('first');
        else if (e.key === 'End') focusItem('last');
        else if (e.key === 'Escape' || e.key === 'Tab') onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`sep-${i}`} className={s.separator} role="separator" />
        ) : (
          <div
            key={item.id}
            role="menuitem"
            tabIndex={-1}
            aria-disabled={item.disabled || undefined}
            className={`${s.item} ${item.danger ? s.danger : ''}`}
            onClick={() => select(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                select(item);
              }
            }}
            onPointerMove={(e) => e.currentTarget.focus()}
          >
            <span className={s.icon}>{item.icon}</span>
            <span className={s.label}>{item.label}</span>
            {item.shortcut && <span className={s.shortcut}>{item.shortcut}</span>}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}
