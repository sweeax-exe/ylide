import { cssVarName, darkTheme, lightTheme, type Theme } from './themes';
import { font, fontSize, layout, lineHeight, motion, radius, space } from './tokens';

/** Writes primitives and the semantic theme as CSS variables on :root. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const set = (name: string, value: string) => root.style.setProperty(name, value);
  for (const [k, v] of Object.entries(theme.colors)) set(cssVarName(k), v);
  for (const [k, v] of Object.entries(theme.syntax)) set(`--syntax-${k}`, v);
  for (const [k, v] of Object.entries(space)) set(`--space-${k}`, v);
  for (const [k, v] of Object.entries(radius)) set(`--radius-${k}`, v);
  for (const [k, v] of Object.entries(fontSize)) set(`--text-${k}`, v);
  for (const [k, v] of Object.entries(lineHeight)) set(`--leading-${k}`, v);
  for (const [k, v] of Object.entries(motion)) set(`--motion-${k}`, v);
  for (const [k, v] of Object.entries(layout)) set(cssVarName(`layout${k[0].toUpperCase()}${k.slice(1)}`), v);
  set('--font-ui', font.ui);
  set('--font-code', font.code);
  root.dataset.theme = theme.kind;
  root.style.colorScheme = theme.kind;
}

export type ThemeChoice = 'dark' | 'light' | 'system';

export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? lightTheme : darkTheme;
  }
  return choice === 'light' ? lightTheme : darkTheme;
}
