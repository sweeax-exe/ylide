import { describe, expect, it } from 'vitest';
import { clip, formatClock, formatTimeOfDay, formatWhen, roleColor, splitCode, summarizeArgs } from './text';

describe('formatClock', () => {
  it('formats minutes and hours', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(42_400)).toBe('0:42');
    expect(formatClock(725_000)).toBe('12:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-100)).toBe('0:00');
  });
});

describe('splitCode', () => {
  it('splits backtick code spans', () => {
    expect(splitCode('run `npm test` now')).toEqual([
      { code: false, text: 'run ' },
      { code: true, text: 'npm test' },
      { code: false, text: ' now' },
    ]);
    expect(splitCode('plain')).toEqual([{ code: false, text: 'plain' }]);
    expect(splitCode('a ` lone')).toEqual([{ code: false, text: 'a ` lone' }]);
  });
});

describe('summarizeArgs', () => {
  it('picks the most telling argument', () => {
    expect(summarizeArgs('{"path":"src/cart.ts","old_text":"x"}')).toBe('src/cart.ts');
    expect(summarizeArgs('{"command":"npm   test"}')).toBe('npm test');
    expect(summarizeArgs('{"tasks":[]}')).toBe('');
    expect(summarizeArgs('not json')).toBe('not json');
    expect(summarizeArgs(null)).toBe('');
    expect(summarizeArgs(`{"query":"${'x'.repeat(100)}"}`, 10)).toHaveLength(10);
  });
});

describe('clip and roleColor', () => {
  it('clips with an ellipsis', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });
  it('uses the design colours per role', () => {
    expect(roleColor('coder')).toBe('var(--accent)');
    expect(roleColor('reviewer')).toBe('var(--metal)');
    expect(roleColor('orchestrator')).toBe('var(--text-2)');
    expect(roleColor('tester')).toBe('var(--text-1)');
  });
});

describe('formatWhen', () => {
  it('shows the time for today and the date for an earlier day', () => {
    const now = new Date(2026, 9, 17, 15, 0, 0).getTime();
    expect(formatWhen(new Date(2026, 9, 17, 9, 5, 7).getTime(), 'en', now)).toBe(formatTimeOfDay(new Date(2026, 9, 17, 9, 5, 7).getTime(), 'en'));
    const yesterday = formatWhen(new Date(2026, 9, 16, 22, 30).getTime(), 'en', now);
    expect(yesterday).toContain('16');
    expect(yesterday).toContain('Oct');
    expect(yesterday).toContain('30');
  });
});
