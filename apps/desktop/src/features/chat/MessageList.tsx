import { ArrowDown } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui';
import { AssistantMessage, UserMessage } from './Message';
import s from './MessageList.module.css';
import { useChat } from './store';
import { useStickToBottom } from './useStickToBottom';

export function MessageList() {
  const { t } = useTranslation('chat');
  const turns = useChat((st) => st.turns);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { atBottom, pin } = useStickToBottom(scrollRef, contentRef);

  // A new question always brings the conversation back to its end.
  const questions = turns.filter((turn) => turn.role === 'user').length;
  useEffect(() => {
    pin();
  }, [questions, pin]);

  return (
    <div className={s.wrap}>
      <div ref={scrollRef} className={s.scroller}>
        {/* Streaming text is not announced token by token; see Announcer in ChatPanel. */}
        <div ref={contentRef} className={s.list} role="log" aria-live="off" aria-label={t('messages.label')}>
          {turns.map((turn, i) => (turn.role === 'user' ? <UserMessage key={turn.id} turn={turn} /> : <AssistantMessage key={turn.id} turn={turn} last={i === turns.length - 1} />))}
        </div>
      </div>
      {!atBottom && (
        <div className={s.jump}>
          <Button size="sm" icon={<ArrowDown size={13} />} onClick={pin} className={s.jumpButton}>
            {t('messages.jumpToLatest')}
          </Button>
        </div>
      )}
    </div>
  );
}
