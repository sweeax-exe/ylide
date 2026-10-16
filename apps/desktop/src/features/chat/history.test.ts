import { describe, expect, it } from 'vitest';
import type { StoredChat } from '../../bindings/StoredChat';
import { assistantTurn, userTurn, type AssistantTurn, type Turn } from './conversation';
import { CHAT_FORMAT, chatTitle, fromStored, relativeTime, toStored, upsertSummary } from './history';

const answer = (status: AssistantTurn['status']): AssistantTurn => ({ ...assistantTurn('a1', 'r1'), content: 'Antwort', status });

describe('chat history', () => {
  it('titles a chat with the start of its first question, on one line', () => {
    expect(chatTitle([userTurn('u', '  What does\n applyDiscount do?  ', [])])).toBe('What does applyDiscount do?');
    const long = 'x'.repeat(100);
    expect(chatTitle([userTurn('u', long, [])])).toHaveLength(60);
    expect(chatTitle([userTurn('u', long, [])]).endsWith('…')).toBe(true);
    expect(chatTitle([])).toBe('');
    // An emoji at the cut stays whole (half of one would make the title invalid text).
    const emoji = chatTitle([userTurn('u', `${'a'.repeat(58)}😀${'b'.repeat(10)}`, [])]);
    // encodeURIComponent throws on a lone surrogate.
    expect(() => encodeURIComponent(emoji)).not.toThrow();
    expect(emoji.endsWith('😀…')).toBe(true);
  });

  it('stores and restores a conversation unchanged', () => {
    const turns: Turn[] = [userTurn('u1', 'Frage', [{ kind: 'file', path: 'src/cart.js' } as never]), answer('done')];
    const stored = toStored('c1', 5, turns, 9);
    expect(stored.summary).toEqual({ id: 'c1', title: 'Frage', createdAtUnixMs: 5, updatedAtUnixMs: 9, turns: 2 });
    expect(stored.format).toBe(CHAT_FORMAT);
    expect(fromStored(JSON.parse(JSON.stringify(stored)) as StoredChat)).toEqual(turns);
  });

  it('turns an answer that was still being written into a stopped one', () => {
    const [, restored] = fromStored(toStored('c', 1, [userTurn('u', 'q', []), answer('streaming')], 2));
    expect((restored as AssistantTurn).status).toBe('cancelled');
    expect((restored as AssistantTurn).finishReason).toBe('cancelled');
  });

  it('leaves out entries that are not turns and refuses other formats', () => {
    const stored = toStored('c', 1, [userTurn('u', 'q', [])], 2);
    const broken = { ...stored, turns: [null, 7, { role: 'user' }, { id: 'x', role: 'robot', content: '?' }, ...(stored.turns as unknown[])] } as StoredChat;
    expect(fromStored(broken)).toHaveLength(1);
    expect(fromStored({ ...stored, format: 99 })).toEqual([]);
    expect(fromStored({ ...stored, turns: 'nope' })).toEqual([]);
  });

  it('describes times relative to now, and older ones as a date', () => {
    const now = new Date(2026, 9, 16, 12, 0).getTime();
    expect(relativeTime(now - 5 * 60_000, now, 'en-US')).toBe('5 minutes ago');
    expect(relativeTime(now - 26 * 3_600_000, now, 'de-DE')).toBe('gestern');
    expect(relativeTime(now - 30 * 86_400_000, now, 'en-US')).toMatch(/2026/);
  });

  it('moves a saved chat to the top of the list', () => {
    const a = { id: 'a', title: 'A', createdAtUnixMs: 1, updatedAtUnixMs: 1, turns: 2 };
    const b = { id: 'b', title: 'B', createdAtUnixMs: 1, updatedAtUnixMs: 2, turns: 2 };
    expect(upsertSummary([b, a], { ...a, updatedAtUnixMs: 3 }).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
