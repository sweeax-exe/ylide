// Monaco editor themes derived from the same semantic tokens as the UI.

import type * as Monaco from 'monaco-editor';
import type { Theme } from './themes';

const strip = (hex: string) => hex.replace('#', '');

/** Converts `rgba(r, g, b, a)` or `#rrggbb` to Monaco's `#rrggbbaa`. */
export function toMonacoColor(color: string): string {
  if (color.startsWith('#')) return color;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(+r)}${hex(+g)}${hex(+b)}${hex(parseFloat(a) * 255)}`;
}

export function monacoTheme(theme: Theme): Monaco.editor.IStandaloneThemeData {
  const s = theme.syntax;
  const c = theme.colors;
  return {
    base: theme.kind === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: strip(s.variable) },
      { token: 'comment', foreground: strip(s.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(s.keyword) },
      { token: 'storage', foreground: strip(s.keyword) },
      { token: 'string', foreground: strip(s.string) },
      { token: 'string.escape', foreground: strip(s.number) },
      { token: 'regexp', foreground: strip(s.string) },
      { token: 'number', foreground: strip(s.number) },
      { token: 'constant', foreground: strip(s.number) },
      { token: 'type', foreground: strip(s.type) },
      { token: 'type.identifier', foreground: strip(s.type) },
      { token: 'identifier.function', foreground: strip(s.function) },
      { token: 'function', foreground: strip(s.function) },
      { token: 'operator', foreground: strip(s.operator) },
      { token: 'delimiter', foreground: strip(s.operator) },
      { token: 'tag', foreground: strip(s.tag) },
      { token: 'attribute.name', foreground: strip(s.attribute) },
      { token: 'attribute.value', foreground: strip(s.string) },
      { token: 'variable', foreground: strip(s.variable) },
      { token: 'variable.predefined', foreground: strip(s.type) },
    ],
    colors: {
      'editor.background': toMonacoColor(c.bgSunken),
      'editor.foreground': toMonacoColor(c.text1),
      'editorLineNumber.foreground': toMonacoColor(c.text3),
      'editorLineNumber.activeForeground': toMonacoColor(c.text2),
      'editorCursor.foreground': toMonacoColor(c.accent),
      'editor.selectionBackground': toMonacoColor(c.selection),
      'editor.inactiveSelectionBackground': toMonacoColor(c.bgSelected),
      'editor.lineHighlightBackground': toMonacoColor(c.bgApp),
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background1': toMonacoColor(c.border),
      'editorIndentGuide.activeBackground1': toMonacoColor(c.borderStrong),
      'editorWhitespace.foreground': toMonacoColor(c.border),
      'editorWidget.background': toMonacoColor(c.bgRaised),
      'editorWidget.border': toMonacoColor(c.border),
      'editorSuggestWidget.background': toMonacoColor(c.bgRaised),
      'editorSuggestWidget.selectedBackground': toMonacoColor(c.bgActive),
      'editorHoverWidget.background': toMonacoColor(c.bgRaised),
      'editorGutter.background': toMonacoColor(c.bgSunken),
      'editorBracketMatch.border': toMonacoColor(c.accent),
      'editorBracketMatch.background': '#00000000',
      'diffEditor.insertedTextBackground': toMonacoColor(c.diffAddBg),
      'diffEditor.removedTextBackground': toMonacoColor(c.diffDelBg),
      'diffEditor.insertedLineBackground': toMonacoColor(c.diffAddBg),
      'diffEditor.removedLineBackground': toMonacoColor(c.diffDelBg),
      'scrollbarSlider.background': toMonacoColor(c.scrollbar),
      'scrollbarSlider.hoverBackground': toMonacoColor(c.borderStrong),
      'focusBorder': toMonacoColor(c.focus),
      'editorGhostText.foreground': toMonacoColor(c.text3),
    },
  };
}
