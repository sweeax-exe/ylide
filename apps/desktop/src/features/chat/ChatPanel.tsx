import { History, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Braid } from '../../components/Braid';
import { Dialog } from '../../components/Dialog';
import { Button, IconButton } from '../../components/ui';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import s from './ChatPanel.module.css';
import { Composer, type ComposerHandle } from './Composer';
import { registerComposer } from './composerFocus';
import { plainText } from './conversation';
import { HistoryMenu } from './HistoryMenu';
import { MessageList } from './MessageList';
import { StartScreen } from './StartScreen';
import { registerChatPanel, useChat } from './store';
import { splitSuggestions } from './suggestions';

function ModelStatus() {
  const { t } = useTranslation('chat');
  const server = useApp((st) => st.server);
  const streaming = useChat((st) => st.activeRequestId !== null);
  const setMain = useLayout((st) => st.setMain);
  const state = server?.status.state;
  const label = !server
    ? t('common:server.none')
    : state === 'ready'
      ? server.modelName
      : state === 'starting' || state === 'loading'
        ? t(`common:server.${state}`, { model: server.modelName })
        : state === 'crashed'
          ? t('common:server.crashed')
          : t('common:server.stopped');
  const dot = state === 'ready' ? s.ready : state === 'starting' || state === 'loading' ? s.loading : state === 'crashed' ? s.crashed : '';
  return (
    <button type="button" className={s.model} onClick={() => setMain('models')} title={t('common:titlebar.modelMenu')}>
      {streaming ? <Braid active size={10} label={t('header.generating')} /> : <span className={`${s.dot} ${dot}`} aria-hidden />}
      <span className={s.modelName}>{label}</span>
    </button>
  );
}

/** Announces finished answers once, instead of every streamed token. */
function Announcer() {
  const { t } = useTranslation('chat');
  const last = useChat((st) => st.turns[st.turns.length - 1]);
  const [message, setMessage] = useState('');
  const seen = useRef<{ id: string; status: string } | null>(null);

  useEffect(() => {
    if (!last || last.role !== 'assistant') return;
    const before = seen.current;
    seen.current = { id: last.id, status: last.status };
    if (before?.id !== last.id) {
      if (last.status === 'streaming') setMessage(t('announce.started'));
      return;
    }
    if (before.status !== 'streaming' || last.status === 'streaming') return;
    // Errors are announced by their own alert.
    if (last.status === 'done') setMessage(t('announce.answer', { text: plainText(splitSuggestions(last.content).text) }));
    if (last.status === 'cancelled') setMessage(t('announce.stopped'));
  }, [last, t]);

  return (
    <div className="visually-hidden" role="status" aria-live="polite">
      {message}
    </div>
  );
}

export function ChatPanel() {
  const { t } = useTranslation('chat');
  // Only whether there is a conversation: the list subscribes to the turns
  // itself, so streamed tokens do not re-render the composer.
  const hasTurns = useChat((st) => st.turns.length > 0);
  const streaming = useChat((st) => st.activeRequestId !== null);
  const newChat = useChat((st) => st.newChat);
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const saving = useApp((st) => st.settings?.chat.saveHistory ?? false);

  useEffect(() => registerChatPanel(), []);

  useEffect(() => registerComposer(() => composerRef.current?.focus()), []);

  // Mentions handed over by the editor become chips in the composer.
  useEffect(() => {
    const take = () => {
      if (!useEditorBridge.getState().pendingMentions.length) return;
      useChat.getState().addMentions(useEditorBridge.getState().takePendingMentions());
      composerRef.current?.focus();
    };
    take();
    return useEditorBridge.subscribe((state, prev) => {
      if (state.pendingMentions !== prev.pendingMentions) take();
    });
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPanelHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const startNewChat = () => {
    setConfirming(false);
    // A running answer is stopped and kept in the history with what it wrote.
    useChat.getState().stop();
    newChat();
    composerRef.current?.focus();
  };
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  return (
    <div ref={panelRef} className={s.panel}>
      <header className={s.header}>
        <h2 className={s.title}>{t('title')}</h2>
        <ModelStatus />
        <span className={s.grow} />
        {saving && (
          <IconButton ref={historyButton} label={t('history.open')} pressed={historyOpen} onClick={() => setHistoryOpen((o) => !o)}>
            <History size={15} />
          </IconButton>
        )}
        <IconButton label={t('newChat')} onClick={() => (streaming ? setConfirming(true) : startNewChat())} disabled={!hasTurns}>
          <SquarePen size={15} />
        </IconButton>
      </header>
      {historyOpen && saving && <HistoryMenu anchor={historyButton.current} onClose={closeHistory} />}
      <div className={s.body}>
        {hasTurns ? <MessageList /> : <StartScreen onExample={(template, mentions) => composerRef.current?.fillTemplate(template, mentions)} />}
      </div>
      <Composer ref={composerRef} maxHeight={Math.max(96, Math.round(panelHeight * 0.4))} />
      <Announcer />
      <Dialog
        open={confirming}
        title={t('newChatDialog.title')}
        onClose={() => setConfirming(false)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" onClick={startNewChat} data-autofocus>
              {t('newChatDialog.confirm')}
            </Button>
          </>
        }
      >
        {t(saving ? 'newChatDialog.body' : 'newChatDialog.bodyNotSaved')}
      </Dialog>
    </div>
  );
}
