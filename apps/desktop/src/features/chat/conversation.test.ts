import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../../bindings/ChatResult';
import type { ContextItem } from '../../bindings/ContextItem';
import {
  applyChatEvent,
  assistantTurn,
  contextTokens,
  markCancelled,
  markFailed,
  markFinished,
  plainText,
  prepareRetry,
  requestMessages,
  sentUserContent,
  userTurn,
  type AssistantTurn,
  type Turn,
} from './conversation';

const item = (content: string, extra: Partial<ContextItem> = {}): ContextItem => ({ kind: 'file', label: 'cart.ts', path: 'src/cart.ts', content, tokens: 10, truncated: false, error: null, ...extra });

const result = (content: string, finishReason: ChatResult['finishReason'] = 'stop'): ChatResult => ({
  message: { role: 'assistant', content, reasoning_content: null },
  finishReason,
  usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 60 },
  timings: { promptTokensPerSecond: 3000, generationTokensPerSecond: 50, promptMs: 30, generationMs: 400 },
});

function started(): Turn[] {
  return [userTurn('u1', 'Why?', [{ type: 'file', path: 'src/cart.ts' }]), assistantTurn('a1', 'r1')];
}

const answer = (turns: Turn[]) => turns[turns.length - 1] as AssistantTurn;

describe('sentUserContent', () => {
  it('prefixes resolved context like the core does and skips failed items', () => {
    const turn = { ...userTurn('u', 'Explain', []), context: [item('File `a`'), item('File `b`', { error: 'missing' }), item('File `c`')] };
    expect(sentUserContent(turn)).toBe('File `a`\n\nFile `c`\n\nExplain');
  });
  it('is the plain message without context', () => {
    expect(sentUserContent(userTurn('u', 'Hi', []))).toBe('Hi');
  });
});

describe('requestMessages', () => {
  it('sends earlier turns as they were sent and the new message without context', () => {
    let turns = started();
    turns = applyChatEvent(turns, 'r1', { type: 'context', items: [item('CTX')] }, 0);
    turns = applyChatEvent(turns, 'r1', { type: 'done', result: result('Because.') }, 0);
    expect(requestMessages(turns, 'And now?')).toEqual([
      { role: 'user', content: 'CTX\n\nWhy?' },
      { role: 'assistant', content: 'Because.' },
      { role: 'user', content: 'And now?' },
    ]);
  });
  it('leaves out exchanges without an answer so roles alternate', () => {
    let turns = started();
    turns = markFailed(turns, 'r1', { code: 'model', message: 'boom' }, 0);
    expect(requestMessages(turns, 'Again')).toEqual([{ role: 'user', content: 'Again' }]);
  });
  it('keeps a stopped answer that has text', () => {
    let turns = started();
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'content', text: 'Part' } }, 0);
    turns = markCancelled(turns, 'r1', 0);
    expect(requestMessages(turns, 'Go on').map((m) => m.content)).toEqual(['Why?', 'Part', 'Go on']);
  });
});

describe('applyChatEvent', () => {
  it('stores context on the question', () => {
    const turns = applyChatEvent(started(), 'r1', { type: 'context', items: [item('x')] }, 0);
    expect((turns[0] as { context: ContextItem[] }).context).toHaveLength(1);
  });
  it('appends content and reasoning and measures thinking time', () => {
    let turns = started();
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'reasoning', text: 'Hm' } }, 1000);
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'reasoning', text: 'm.' } }, 1500);
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'content', text: 'A' } }, 3000);
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'content', text: 'B' } }, 3100);
    expect(answer(turns)).toMatchObject({ reasoning: 'Hmm.', content: 'AB', reasoningMs: 2000, status: 'streaming' });
  });
  it('finishes with metrics and the authoritative text', () => {
    let turns = applyChatEvent(started(), 'r1', { type: 'delta', delta: { kind: 'content', text: 'Draft' } }, 0);
    turns = applyChatEvent(turns, 'r1', { type: 'done', result: result('Final') }, 0);
    expect(answer(turns)).toMatchObject({ status: 'done', content: 'Final', finishReason: 'stop', usage: { cachedTokens: 60 } });
  });
  it('marks a cancelled finish as stopped', () => {
    const turns = applyChatEvent(started(), 'r1', { type: 'done', result: result('', 'cancelled') }, 0);
    expect(answer(turns).status).toBe('cancelled');
  });
  it('ignores text after the user stopped but keeps metrics', () => {
    let turns = applyChatEvent(started(), 'r1', { type: 'delta', delta: { kind: 'content', text: 'Kept' } }, 0);
    turns = markCancelled(turns, 'r1', 0);
    turns = applyChatEvent(turns, 'r1', { type: 'delta', delta: { kind: 'content', text: ' late' } }, 0);
    turns = applyChatEvent(turns, 'r1', { type: 'done', result: result('Kept late') }, 0);
    expect(answer(turns)).toMatchObject({ status: 'cancelled', content: 'Kept', finishReason: 'cancelled' });
    expect(answer(turns).usage).not.toBeNull();
  });
  it('records errors once', () => {
    let turns = applyChatEvent(started(), 'r1', { type: 'error', error: { code: 'model', message: 'first' } }, 0);
    turns = markFailed(turns, 'r1', { code: 'generic', message: 'second' }, 0);
    expect(answer(turns)).toMatchObject({ status: 'error', error: { message: 'first' } });
  });
  it('ignores events of unknown requests', () => {
    const turns = started();
    expect(applyChatEvent(turns, 'other', { type: 'delta', delta: { kind: 'content', text: 'x' } }, 0)).toBe(turns);
  });
  it('closes a request that ended without a done event', () => {
    expect(answer(markFinished(started(), 'r1', 0)).status).toBe('done');
  });
});

describe('prepareRetry', () => {
  it('returns the history before the question and clears its context', () => {
    let turns = applyChatEvent(started(), 'r1', { type: 'context', items: [item('x')] }, 0);
    turns = markFailed(turns, 'r1', { code: 'model', message: 'boom' }, 0);
    const retry = prepareRetry(turns, 'a1');
    expect(retry?.history).toEqual([]);
    expect(retry?.question).toMatchObject({ id: 'u1', context: null, mentions: [{ type: 'file', path: 'src/cart.ts' }] });
  });
  it('returns null for an unknown answer', () => {
    expect(prepareRetry(started(), 'nope')).toBeNull();
  });
});

describe('plainText', () => {
  it('drops Markdown syntax that screen readers would spell out', () => {
    expect(plainText('## Fix\n\nUse `total()` in **cart**:\n\n```ts\nconst a = 1;\n```\n\nSee [docs](https://x.y).')).toBe('Fix\n\nUse total() in cart:\n\nconst a = 1;\n\nSee docs.');
  });
});

describe('contextTokens', () => {
  it('counts only items that are sent', () => {
    expect(contextTokens([item('a', { tokens: 5 }), item('b', { tokens: 7, error: 'missing' }), item('c', { tokens: 3 })])).toBe(8);
  });
});
