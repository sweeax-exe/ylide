// Saving and restoring chats: the conversation as the panel keeps it, with a
// summary for the history list. Pure functions; the store does the I/O.

import type { ChatSummary } from '../../bindings/ChatSummary';
import type { ContextItem } from '../../bindings/ContextItem';
import type { Mention } from '../../bindings/Mention';
import type { StoredChat } from '../../bindings/StoredChat';
import type { AssistantTurn, Turn } from './conversation';

/** Version of the stored conversation format. */
export const CHAT_FORMAT = 1;
const TITLE_LENGTH = 60;

/** Title of a chat: the start of its first question, on one line. */
export function chatTitle(turns: Turn[]): string {
  const first = turns.find((t) => t.role === 'user');
  const text = (first?.content ?? '').replace(/\s+/g, ' ').trim();
  // Cut by characters, not UTF-16 units: half an emoji is not valid text and
  // the core would refuse every save of the chat.
  const chars = Array.from(text);
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join('').trimEnd()}…` : text;
}

export function toStored(id: string, createdAt: number, turns: Turn[], now: number): StoredChat {
  return {
    summary: { id, title: chatTitle(turns), createdAtUnixMs: createdAt, updatedAtUnixMs: now, turns: turns.length },
    format: CHAT_FORMAT,
    turns: turns as unknown,
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * Turns of a saved chat, ready to show and continue. Entries that do not look
 * like turns are left out; an answer saved while it was still being written
 * (Ylide closed meanwhile) counts as stopped.
 */
export function fromStored(chat: StoredChat): Turn[] {
  if (chat.format !== CHAT_FORMAT || !Array.isArray(chat.turns)) return [];
  const turns: Turn[] = [];
  for (const raw of chat.turns as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (!isString(t.id) || !isString(t.content)) continue;
    if (t.role === 'user') {
      turns.push({
        id: t.id,
        role: 'user',
        content: t.content,
        mentions: Array.isArray(t.mentions) ? (t.mentions as Mention[]) : [],
        context: Array.isArray(t.context) ? (t.context as ContextItem[]) : null,
      });
    } else if (t.role === 'assistant' && isString(t.requestId)) {
      const answer = raw as AssistantTurn;
      turns.push({
        ...answer,
        reasoning: isString(answer.reasoning) ? answer.reasoning : '',
        status: answer.status === 'streaming' ? 'cancelled' : answer.status,
        finishReason: answer.status === 'streaming' ? 'cancelled' : answer.finishReason,
      });
    }
  }
  return turns;
}

/** "5 minutes ago", "yesterday", or a date for older chats, in the UI language. */
export function relativeTime(ms: number, now: number, locale: string): string {
  const minutes = Math.round((ms - now) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return rtf.format(days, 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms);
}

/** Puts a saved summary at the top of the list (replacing an older one of the same chat). */
export function upsertSummary(list: ChatSummary[], summary: ChatSummary): ChatSummary[] {
  return [summary, ...list.filter((s) => s.id !== summary.id)];
}
