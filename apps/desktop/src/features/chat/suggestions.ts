// Next steps the chat suggests. The model ends an answer with a fenced block
// (see interaction_section in the core's chat.rs):
//
//   ```suggestions
//   Explain how the cart test works
//   change: Add a test for an empty cart
//   ```
//
// The block never shows as text: it is cut out of the answer, also while it
// streams, and its lines become buttons. "change:" marks a change to the
// project, which the agents can make. A malformed block gives fewer or no
// buttons, never raw markup.

export interface Suggestion {
  text: string;
  /** A change to the project's files: the agents can make it. */
  change: boolean;
}

export interface SplitAnswer {
  /** The answer without the block, as it is shown and copied. */
  text: string;
  suggestions: Suggestion[];
}

export const MAX_SUGGESTIONS = 3;
export const SUGGESTION_CHARS = 160;

const INFO = /^(suggestions?|next[-_ ]?steps?)$/i;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/;
const BULLET = /^(?:[-*•+]|\d{1,2}[.)])\s+/;
// "change:" as asked, and the words small models translate it to ("Ändere:", "Modifier :").
const CHANGE = /^(?:\[\s*(?:change|code|agent)\s*\]|\(\s*(?:change|code|agent)\s*\)|(?:change|code|agent|edit|fix|änder\p{L}*|cambi\p{L}*|chang\p{L}*|modif\p{L}*|alter\p{L}*|mudan\p{L}*|perubah\p{L}*|ubah|измен\p{L}*|変更|변경|修改|更改|परिवर्तन|बदलाव)\s*[:：])\s*/iu;
// Labels models put on the other lines although they were asked not to.
const LABEL = /^(?:explain|explanation|question|ask|info|idea|tip|next|frage|erklär\p{L}*|pregunta|question|pergunta|pertanyaan|вопрос|質問|질문|问题)\s*[:：]\s*/iu;

/**
 * Splits an answer into its text and its suggestions. Only a block outside
 * other code blocks counts; with several, the last one gives the buttons.
 * While the answer streams, an unfinished block or opening fence at the end
 * is hidden too.
 */
export function splitSuggestions(answer: string, streaming = false): SplitAnswer {
  if (!answer.includes('```') && !answer.includes('~~~')) return { text: answer, suggestions: [] };
  const lines = answer.split('\n');
  const kept: string[] = [];
  let block: string[] | null = null;
  let last: string[] | null = null;
  /** The fence of the code block (or suggestions block) we are in. */
  let open: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (block) {
      if (fence && closes(fence, open)) {
        last = block;
        block = null;
        open = null;
      } else {
        block.push(line);
      }
      continue;
    }
    if (open) {
      if (fence && closes(fence, open)) open = null;
      kept.push(line);
      continue;
    }
    if (fence && INFO.test(fence[2])) {
      block = [];
      open = fence[1];
      continue;
    }
    if (fence) open = fence[1];
    // A fence still being typed at the very end may become a suggestions block.
    if (streaming && i === lines.length - 1 && /^[ \t]{0,3}(`{3,}|~{3,})/.test(line) && isPrefixOfInfo(line.replace(/^[ \t]*[`~]+[ \t]*/, ''))) {
      if (fence) open = null;
      continue;
    }
    kept.push(line);
  }
  // An unclosed block: still streaming, or the model never closed it.
  if (block) last = block;
  const removed = kept.length !== lines.length;
  const text = removed ? kept.join('\n').replace(/\s+$/, '') : answer;
  const suggestions = last ? parseLines(last) : [];
  // A model that put its question back into the block, with no text around it:
  // the question is the answer, the rest stay buttons.
  if (!streaming && !text.trim() && suggestions.some(isQuestion)) {
    const asked = suggestions.filter(isQuestion);
    return { text: asked.map((s) => s.text).join('\n\n'), suggestions: suggestions.filter((s) => !isQuestion(s)) };
  }
  return { text, suggestions };
}

const isQuestion = (s: Suggestion) => !s.change && /[?？]$/.test(s.text);

function closes(fence: RegExpExecArray, open: string | null): boolean {
  return open !== null && fence[2] === '' && fence[1][0] === open[0] && fence[1].length >= open.length;
}

function isPrefixOfInfo(partial: string): boolean {
  const p = partial.toLowerCase();
  return 'suggestions'.startsWith(p) || 'next-steps'.startsWith(p) || 'next steps'.startsWith(p) || 'next_steps'.startsWith(p);
}

/** The block's lines as buttons: bullets and quotes removed, cut, without duplicates. */
export function parseLines(lines: string[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const raw of lines) {
    let text = raw.trim().replace(BULLET, '');
    const marker = CHANGE.exec(text);
    const change = marker !== null;
    if (marker) text = text.slice(marker[0].length);
    else text = text.replace(LABEL, '');
    text = text
      .replace(/^\*\*(.*)\*\*$/, '$1')
      .replace(/^["'“„«`](.*)["'”«»`]$/, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    // The form's placeholders, copied as they are.
    if (!text || /^<[^<>]*>$/.test(text)) continue;
    if (text.length > SUGGESTION_CHARS) text = `${text.slice(0, SUGGESTION_CHARS - 1).trimEnd()}…`;
    if (out.some((s) => s.text.toLowerCase() === text.toLowerCase())) continue;
    out.push({ text, change });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}
