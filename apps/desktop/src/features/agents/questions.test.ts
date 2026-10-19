import { describe, expect, it } from 'vitest';
import type { Question } from '../../bindings/Question';
import { answersFor, answersOnClick, answerText, canSend, emptyDrafts, pick, questionsOf } from './questions';

const runner: Question = {
  question: 'Which test runner?',
  options: [
    { label: 'Vitest', recommended: true },
    { label: 'Jest', recommended: false },
  ],
  multiple: false,
};
const browsers: Question = {
  question: 'Which browsers?',
  options: [
    { label: 'Chrome', recommended: false },
    { label: 'Firefox', recommended: false },
    { label: 'Safari', recommended: false },
  ],
  multiple: true,
};
const plain: Question = { question: 'Anything else?', options: [], multiple: false };

describe('question card', () => {
  it('a click picks one answer, or toggles answers that go together', () => {
    let d = emptyDrafts(1)[0];
    d = pick(d, 1, false);
    expect(d.picked).toEqual([1]);
    expect(pick(d, 0, false).picked).toEqual([0]);
    expect(pick(d, 1, false).picked, 'a second click takes it back').toEqual([]);
    let m = pick(pick(emptyDrafts(1)[0], 2, true), 0, true);
    expect(m.picked).toEqual([0, 2]);
    m = pick(m, 2, true);
    expect(m.picked).toEqual([0]);
  });

  it('puts the clicked answers before the own words', () => {
    expect(answerText(browsers, { picked: [0, 2], own: '' })).toBe('Chrome, Safari');
    expect(answerText(runner, { picked: [0], own: '  with coverage ' })).toBe('Vitest\nwith coverage');
    expect(answerText(plain, { picked: [], own: 'No.' })).toBe('No.');
    expect(answerText(runner, { picked: [7], own: '' }), 'an index that is gone gives nothing').toBe('');
  });

  it('sends one answer per question and needs at least one', () => {
    const questions = [runner, browsers, plain];
    const drafts = emptyDrafts(3);
    expect(canSend(questions, drafts)).toBe(false);
    drafts[1] = pick(drafts[1], 1, true);
    expect(canSend(questions, drafts)).toBe(true);
    expect(answersFor(questions, drafts)).toEqual(['', 'Firefox', '']);
    expect(answersFor(questions, [])).toEqual(['', '', '']);
  });

  it('answers on the click only for a single question with one answer', () => {
    expect(answersOnClick([runner])).toBe(true);
    expect(answersOnClick([browsers])).toBe(false);
    expect(answersOnClick([plain])).toBe(false);
    expect(answersOnClick([runner, plain])).toBe(false);
  });

  it('falls back to the text when the event has no list', () => {
    expect(questionsOf({ question: 'Tabs or spaces?' })).toEqual([{ question: 'Tabs or spaces?', options: [], multiple: false }]);
    expect(questionsOf({ question: 'x', questions: [runner] })).toEqual([runner]);
  });
});
