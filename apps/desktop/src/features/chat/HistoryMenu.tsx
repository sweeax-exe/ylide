// The list of earlier chats of the open project, opened from the chat header.

import { Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../components/ui';
import { localeOf } from '../../i18n';
import { useConfirm } from '../../state/confirm';
import { reportError } from '../../lib/errors';
import { focusComposer } from './composerFocus';
import { relativeTime } from './history';
import s from './ChatPanel.module.css';
import { useChat } from './store';

export function HistoryMenu({ onClose, anchor }: { onClose: () => void; anchor: HTMLElement | null }) {
  const { t, i18n } = useTranslation('chat');
  const history = useChat((st) => st.history);
  const current = useChat((st) => st.chatId);
  const ref = useRef<HTMLDivElement>(null);
  const locale = localeOf(i18n.language);
  const now = Date.now();
  // Kept in a ref so a new callback from the panel does not re-run the
  // effect below (which would move focus away from where the user is).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus starts on the first entry.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  // Escape and a click outside close the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only Escape pressed in the list or on its button: other overlays
      // (Quick Open, dialogs) handle their own.
      const target = e.target as Node;
      if (e.key !== 'Escape' || (!ref.current?.contains(target) && !anchor?.contains(target))) return;
      e.stopPropagation();
      onCloseRef.current();
      anchor?.focus();
    };
    const onDown = (e: MouseEvent) => {
      // Clicks in the delete question (a modal dialog) keep the list open.
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [anchor]);

  const open = (id: string) => {
    void useChat.getState().openChat(id);
    onClose();
    focusComposer();
  };

  const remove = async (id: string, title: string, button: HTMLElement) => {
    const ok = await useConfirm.getState().ask({
      title: t('history.deleteTitle'),
      body: t('history.deleteBody', { title: title || t('history.untitled') }),
      confirmLabel: t('history.deleteConfirm'),
      danger: true,
    });
    if (!ok) return;
    // The row goes away with its button: focus moves to a neighbour, or to
    // the list itself when it is empty.
    const row = button.closest('li');
    const next = row?.nextElementSibling ?? row?.previousElementSibling;
    try {
      await useChat.getState().deleteChat(id);
    } catch (e) {
      reportError(e);
      return;
    }
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const target = next?.querySelector<HTMLElement>('button');
      (target?.isConnected ? target : ref.current)?.focus();
    });
  };

  return (
    <div ref={ref} className={s.history} role="dialog" aria-label={t('history.title')} tabIndex={-1}>
      <div className={s.historyHead}>{t('history.title')}</div>
      {history.length === 0 ? (
        <p className={s.historyEmpty}>{t('history.empty')}</p>
      ) : (
        <ul className={s.historyList}>
          {history.map((c) => (
            <li key={c.id} className={`${s.historyRow} ${c.id === current ? s.historyCurrent : ''}`}>
              <button type="button" className={s.historyItem} aria-current={c.id === current ? 'true' : undefined} onClick={() => open(c.id)}>
                <span className={s.historyTitle}>{c.title || t('history.untitled')}</span>
                <span className={s.historyMeta}>
                  {relativeTime(c.updatedAtUnixMs, now, locale)} · {t('history.messages', { count: c.turns })}
                </span>
              </button>
              <IconButton label={t('history.delete')} onClick={(e) => void remove(c.id, c.title, e.currentTarget)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
