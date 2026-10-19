// What the user has picked and typed on a question card, one draft per
// question. Pure, so the card's rules can be tested: a single question with
// answers to click is answered by the click; several questions (or a
// question that takes several answers) are answered together.

import type { Question } from '../../bindings/Question';

export interface AnswerDraft {
  /** Indexes of the clicked answers, in the order of the options. */
  picked: number[];
  /** "Eigene Antwort". */
  own: string;
}

export function emptyDrafts(count: number): AnswerDraft[] {
  return Array.from({ length: count }, () => ({ picked: [], own: '' }));
}

/** A click on answer `index`: picks it (or with `multiple`, toggles it). */
export function pick(draft: AnswerDraft, index: number, multiple: boolean): AnswerDraft {
  if (!multiple) return { ...draft, picked: draft.picked.length === 1 && draft.picked[0] === index ? [] : [index] };
  const picked = draft.picked.includes(index) ? draft.picked.filter((i) => i !== index) : [...draft.picked, index].sort((a, b) => a - b);
  return { ...draft, picked };
}

/** The answer as the agent reads it: the clicked answers, then the user's own words. */
export function answerText(question: Question, draft: AnswerDraft): string {
  const labels = draft.picked.map((i) => question.options[i]?.label).filter((l): l is string => !!l);
  const own = draft.own.trim();
  return [labels.join(', '), own].filter(Boolean).join('\n');
}

export function isAnswered(question: Question, draft: AnswerDraft): boolean {
  return answerText(question, draft) !== '';
}

/** One answer per question; an empty one leaves that question to the agent. */
export function answersFor(questions: Question[], drafts: AnswerDraft[]): string[] {
  return questions.map((q, i) => answerText(q, drafts[i] ?? { picked: [], own: '' }));
}

/** A card can be sent once at least one question has an answer. */
export function canSend(questions: Question[], drafts: AnswerDraft[]): boolean {
  return questions.some((q, i) => isAnswered(q, drafts[i] ?? { picked: [], own: '' }));
}

/** A click on an answer sends the card: one question that takes one answer. */
export function answersOnClick(questions: Question[]): boolean {
  return questions.length === 1 && questions[0].options.length > 0 && !questions[0].multiple;
}

/** The card's questions; an event without the list (older core) has the text only. */
export function questionsOf(event: { question: string; questions?: Question[] | null }): Question[] {
  return event.questions?.length ? event.questions : [{ question: event.question, options: [], multiple: false }];
}
