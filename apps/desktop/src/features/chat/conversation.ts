// The conversation model of the chat panel and the pure transitions on it.
// The store (store.ts) owns the state; everything here is side-effect free so
// the event handling can be tested without a backend.

import type { AppError } from '../../bindings/AppError';
import type { ChatEvent } from '../../bindings/ChatEvent';
import type { ContextItem } from '../../bindings/ContextItem';
import type { FinishReason } from '../../bindings/FinishReason';
import type { Mention } from '../../bindings/Mention';
import type { Timings } from '../../bindings/Timings';
import type { UiMessage } from '../../bindings/UiMessage';
import type { Usage } from '../../bindings/Usage';

export type AnswerStatus = 'streaming' | 'done' | 'cancelled' | 'error';

export interface UserTurn {
  id: string;
  role: 'user';
  content: string;
  mentions: Mention[];
  /** Context as resolved by the core; null until its `context` event arrives. */
  context: ContextItem[] | null;
}

export interface AssistantTurn {
  id: string;
  role: 'assistant';
  /** Id of the chat request that produces this answer (used for cancel). */
  requestId: string;
  content: string;
  reasoning: string;
  status: AnswerStatus;
  error: AppError | null;
  usage: Usage | null;
  timings: Timings | null;
  finishReason: FinishReason | null;
  /** Client-side timestamps (ms) to show how long the model was thinking. */
  reasoningStartedAt: number | null;
  reasoningMs: number | null;
}

export type Turn = UserTurn | AssistantTurn;

export function userTurn(id: string, content: string, mentions: Mention[]): UserTurn {
  return { id, role: 'user', content, mentions, context: null };
}

export function assistantTurn(id: string, requestId: string): AssistantTurn {
  return {
    id,
    role: 'assistant',
    requestId,
    content: '',
    reasoning: '',
    status: 'streaming',
    error: null,
    usage: null,
    timings: null,
    finishReason: null,
    reasoningStartedAt: null,
    reasoningMs: null,
  };
}

/**
 * The text of a user turn exactly as the core sent it to the model: resolved
 * context blocks first, then the message. Sending earlier turns byte-identical
 * keeps the model's view of the attached files and lets llama-server reuse its
 * KV cache for the whole history.
 */
export function sentUserContent(turn: UserTurn): string {
  const blocks = (turn.context ?? []).filter((i) => i.error === null).map((i) => i.content);
  return blocks.length ? `${blocks.join('\n\n')}\n\n${turn.content}` : turn.content;
}

/**
 * Builds `ChatSendRequest.messages`: the earlier conversation plus the new
 * user message (without its context; the core attaches that itself).
 * Exchanges without an answer (failed, or stopped before any text) are left
 * out so roles keep alternating, which many chat templates require.
 */
export function requestMessages(history: Turn[], newMessage: string): UiMessage[] {
  const out: UiMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const answer = history[i + 1];
    if (!answer || answer.role !== 'assistant' || answer.status === 'streaming' || answer.status === 'error' || !answer.content.trim()) continue;
    out.push({ role: 'user', content: sentUserContent(turn) });
    out.push({ role: 'assistant', content: answer.content });
  }
  out.push({ role: 'user', content: newMessage });
  return out;
}

function updateAnswer(turns: Turn[], requestId: string, change: (turn: AssistantTurn, index: number) => Turn[] | AssistantTurn | null): Turn[] {
  const index = turns.findIndex((t) => t.role === 'assistant' && t.requestId === requestId);
  if (index < 0) return turns;
  const result = change(turns[index] as AssistantTurn, index);
  if (result === null) return turns;
  if (Array.isArray(result)) return result;
  const next = turns.slice();
  next[index] = result;
  return next;
}

function closeReasoning(turn: AssistantTurn, now: number): AssistantTurn {
  if (turn.reasoningMs !== null || turn.reasoningStartedAt === null) return turn;
  return { ...turn, reasoningMs: Math.max(0, now - turn.reasoningStartedAt) };
}

/** Applies one streamed event of request `requestId`. Unknown requests are ignored. */
export function applyChatEvent(turns: Turn[], requestId: string, event: ChatEvent, now: number): Turn[] {
  return updateAnswer(turns, requestId, (turn, index) => {
    switch (event.type) {
      case 'context': {
        const user = turns[index - 1];
        if (!user || user.role !== 'user') return null;
        const next = turns.slice();
        next[index - 1] = { ...user, context: event.items };
        return next;
      }
      case 'delta': {
        // A stopped answer stays as it was when the user pressed Stop.
        if (turn.status !== 'streaming') return null;
        const { delta } = event;
        if (delta.kind === 'reasoning') {
          return { ...turn, reasoning: turn.reasoning + delta.text, reasoningStartedAt: turn.reasoningStartedAt ?? now };
        }
        if (delta.kind === 'content') {
          return { ...closeReasoning(turn, now), content: turn.content + delta.text };
        }
        return null;
      }
      case 'done': {
        const { result } = event;
        const metrics = { usage: result.usage, timings: result.timings, finishReason: result.finishReason };
        if (turn.status === 'cancelled') return { ...turn, ...metrics, finishReason: 'cancelled' };
        if (turn.status !== 'streaming') return null;
        const finished = closeReasoning(turn, now);
        return {
          ...finished,
          ...metrics,
          status: result.finishReason === 'cancelled' ? 'cancelled' : 'done',
          content: result.message.content ?? finished.content,
          reasoning: result.message.reasoning_content ?? finished.reasoning,
        };
      }
      case 'error':
        if (turn.status !== 'streaming') return null;
        return { ...closeReasoning(turn, now), status: 'error', error: event.error };
    }
  });
}

/** The user pressed Stop: the answer keeps its text and is marked as stopped. */
export function markCancelled(turns: Turn[], requestId: string, now: number): Turn[] {
  return updateAnswer(turns, requestId, (turn) => (turn.status === 'streaming' ? { ...closeReasoning(turn, now), status: 'cancelled' } : null));
}

/** The request failed without an `error` event (e.g. rejected before streaming). */
export function markFailed(turns: Turn[], requestId: string, error: AppError, now: number): Turn[] {
  return updateAnswer(turns, requestId, (turn) => (turn.status === 'streaming' ? { ...closeReasoning(turn, now), status: 'error', error } : null));
}

/** The request ended without a `done` event; keep what arrived. */
export function markFinished(turns: Turn[], requestId: string, now: number): Turn[] {
  return updateAnswer(turns, requestId, (turn) => (turn.status === 'streaming' ? { ...closeReasoning(turn, now), status: 'done' } : null));
}

/**
 * Prepares a retry of the failed answer `answerId`: drops it (and anything
 * after it) and clears the context of the question so it is resolved again.
 */
export function prepareRetry(turns: Turn[], answerId: string): { history: Turn[]; question: UserTurn } | null {
  const index = turns.findIndex((t) => t.id === answerId);
  const question = turns[index - 1];
  if (index < 1 || !question || question.role !== 'user') return null;
  return { history: turns.slice(0, index - 1), question: { ...question, context: null } };
}

/** Readable plain text of a Markdown answer, for screen reader announcements. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Sum of tokens of the context items that will actually be sent. */
export function contextTokens(items: ContextItem[]): number {
  return items.reduce((sum, i) => sum + (i.error === null ? i.tokens : 0), 0);
}
