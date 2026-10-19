import { describe, expect, it } from 'vitest';
import { MAX_SUGGESTIONS, splitSuggestions, SUGGESTION_CHARS } from './suggestions';

const answer = 'Multiply by the quantity.\n\n```ts\nconst x = 1;\n```';

describe('chat suggestions', () => {
  it('takes the block out of the answer and turns its lines into suggestions', () => {
    const split = splitSuggestions(`${answer}\n\n\`\`\`suggestions\nExplain the test\nchange: Add a test for an empty cart\n\`\`\`\n`);
    expect(split.text).toBe(answer);
    expect(split.suggestions).toEqual([
      { text: 'Explain the test', change: false },
      { text: 'Add a test for an empty cart', change: true },
    ]);
  });

  it('leaves answers without a block as they are', () => {
    expect(splitSuggestions(answer)).toEqual({ text: answer, suggestions: [] });
    expect(splitSuggestions('No code here.\n')).toEqual({ text: 'No code here.\n', suggestions: [] });
  });

  it('cleans bullets, quotes and markers, drops duplicates and caps count and length', () => {
    const long = 'x'.repeat(300);
    const split = splitSuggestions(['Text', '```Suggestions', '- "Explain it"', '1. explain it', '* [change] Fix it', '', `2) ${long}`, 'One too many', '```'].join('\n'));
    expect(split.text).toBe('Text');
    expect(split.suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(split.suggestions[0]).toEqual({ text: 'Explain it', change: false });
    expect(split.suggestions[1]).toEqual({ text: 'Fix it', change: true });
    expect(split.suggestions[2].text).toHaveLength(SUGGESTION_CHARS);
    expect(split.suggestions[2].text.endsWith('…')).toBe(true);
  });

  it('understands translated change markers and drops other labels', () => {
    const split = splitSuggestions('Hallo\n```suggestions\nÄnderung: Test ergänzen\n変更：テストを追加\nWarum?\n```');
    expect(split.suggestions.map((s) => s.change)).toEqual([true, true, false]);
    expect(split.suggestions[0].text).toBe('Test ergänzen');
    // What a real model wrote (Qwen3.6 35B-A3B, German chat).
    const real = splitSuggestions('Text\n```suggestions\nÄndere: total() soll negative Mengen ignorieren\nexplain: How to handle floating point precision issues\nVitest: wie richte ich es ein?\n```');
    expect(real.suggestions).toEqual([
      { text: 'total() soll negative Mengen ignorieren', change: true },
      { text: 'How to handle floating point precision issues', change: false },
      { text: 'Vitest: wie richte ich es ein?', change: false },
    ]);
  });

  it('hides the block while it streams and an opening fence still being typed', () => {
    expect(splitSuggestions(`${answer}\n\n\`\`\`sugg`, true).text).toBe(answer);
    expect(splitSuggestions(`${answer}\n\n\`\`\``, true).text).toBe(answer);
    const open = splitSuggestions(`${answer}\n\n\`\`\`suggestions\nExplain the te`, true);
    expect(open.text).toBe(answer);
    expect(open.suggestions).toEqual([{ text: 'Explain the te', change: false }]);
    // Another code block being typed shows as usual.
    expect(splitSuggestions('See:\n```py', true).text).toBe('See:\n```py');
    // Once the answer is done, a lone fence at the end is the model's own text.
    expect(splitSuggestions('See:\n```', false).text).toBe('See:\n```');
  });

  it('reads an unclosed block at the end of a finished answer', () => {
    const split = splitSuggestions('Done.\n```suggestions\n- Run the tests');
    expect(split).toEqual({ text: 'Done.', suggestions: [{ text: 'Run the tests', change: false }] });
  });

  it('ignores the convention quoted inside another code block, and takes the last block', () => {
    const quoted = 'Use this format:\n````md\n```suggestions\nA\n```\n````';
    expect(splitSuggestions(quoted)).toEqual({ text: quoted, suggestions: [] });
    const two = splitSuggestions('A\n```suggestions\nOld\n```\nB\n```next-steps\nNew\n```');
    expect(two.text).toBe('A\nB');
    expect(two.suggestions).toEqual([{ text: 'New', change: false }]);
  });

  it('shows a question the model put into the block as the answer', () => {
    // What a real model wrote for "Kannst du das schneller machen?" with no file attached.
    const real = splitSuggestions('```suggestions\nWelchen Teil soll ich beschleunigen?\nÄnderungen für mehr Geschwindigkeit vorschlagen?\nDen Build\n```');
    expect(real.text).toBe('Welchen Teil soll ich beschleunigen?\n\nÄnderungen für mehr Geschwindigkeit vorschlagen?');
    expect(real.suggestions).toEqual([{ text: 'Den Build', change: false }]);
    // Not while it streams, and not when the answer has text of its own.
    expect(splitSuggestions('```suggestions\nWelcher Teil?\n```', true).text).toBe('');
    expect(splitSuggestions('Gern.\n```suggestions\nWelcher Teil?\n```').suggestions).toHaveLength(1);
  });

  it('drops placeholders copied from the form', () => {
    expect(splitSuggestions('Hi\n```suggestions\n<a question the user could ask next>\nchange: <a change to the project>\nExplain it\n```').suggestions).toEqual([{ text: 'Explain it', change: false }]);
  });

  it('never shows an empty block', () => {
    expect(splitSuggestions('Hi.\n\n```suggestions\n\n```')).toEqual({ text: 'Hi.', suggestions: [] });
    expect(splitSuggestions('~~~suggestions\nAsk me\n~~~')).toEqual({ text: '', suggestions: [{ text: 'Ask me', change: false }] });
  });
});
