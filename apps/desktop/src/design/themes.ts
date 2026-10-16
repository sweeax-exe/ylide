// Semantic themes. Every key becomes a CSS variable (`bgApp` -> `--bg-app`).
// Adding a theme means adding one more `Theme` object; nothing else changes.

import { palette as p } from './tokens';

export interface ThemeColors {
  bgSunken: string;
  bgApp: string;
  bgRaised: string;
  bgOverlay: string;
  bgHover: string;
  bgActive: string;
  bgSelected: string;
  border: string;
  borderStrong: string;
  text1: string;
  text2: string;
  text3: string;
  textOnAccent: string;
  accent: string;
  accentHover: string;
  accentMuted: string;
  metal: string;
  metalMuted: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  focus: string;
  selection: string;
  diffAddBg: string;
  diffDelBg: string;
  scrollbar: string;
  shadowFloat: string;
}

export interface SyntaxColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  variable: string;
  operator: string;
  tag: string;
  attribute: string;
}

export interface Theme {
  id: string;
  kind: 'dark' | 'light';
  colors: ThemeColors;
  syntax: SyntaxColors;
}

export const darkTheme: Theme = {
  id: 'ylide-dark',
  kind: 'dark',
  colors: {
    bgSunken: p.cryo[950],
    bgApp: p.cryo[900],
    bgRaised: p.cryo[800],
    bgOverlay: 'rgba(6, 9, 16, 0.62)',
    bgHover: p.cryo[750],
    bgActive: p.cryo[700],
    bgSelected: 'rgba(34, 211, 238, 0.12)',
    border: p.cryo[700],
    borderStrong: p.cryo[600],
    text1: p.cryo[100],
    text2: p.cryo[300],
    text3: p.cryo[400],
    textOnAccent: p.qubit[900],
    accent: p.qubit[400],
    accentHover: p.qubit[300],
    accentMuted: 'rgba(34, 211, 238, 0.14)',
    metal: p.brass[400],
    metalMuted: 'rgba(201, 166, 107, 0.16)',
    success: p.signal.greenDark,
    successMuted: 'rgba(61, 214, 140, 0.14)',
    warning: p.signal.amberDark,
    warningMuted: 'rgba(242, 169, 59, 0.14)',
    danger: p.signal.coralDark,
    dangerMuted: 'rgba(244, 112, 103, 0.14)',
    focus: p.qubit[400],
    selection: 'rgba(34, 211, 238, 0.24)',
    diffAddBg: 'rgba(61, 214, 140, 0.13)',
    diffDelBg: 'rgba(244, 112, 103, 0.13)',
    scrollbar: 'rgba(154, 166, 187, 0.22)',
    shadowFloat: '0 16px 40px -12px rgba(3, 6, 12, 0.7), 0 2px 8px rgba(3, 6, 12, 0.4)',
  },
  syntax: {
    keyword: '#B6A6FF',
    string: '#9FD9A8',
    number: p.brass[300],
    comment: '#6E7A93',
    function: p.qubit[300],
    type: '#F0B37E',
    variable: p.cryo[100],
    operator: p.cryo[300],
    tag: p.signal.coralDark,
    attribute: p.brass[300],
  },
};

export const lightTheme: Theme = {
  id: 'ylide-light',
  kind: 'light',
  colors: {
    bgSunken: p.paper[0],
    bgApp: p.paper[50],
    bgRaised: p.paper[0],
    bgOverlay: 'rgba(18, 24, 38, 0.32)',
    bgHover: p.paper[100],
    bgActive: p.paper[150],
    bgSelected: 'rgba(14, 116, 144, 0.10)',
    border: p.paper[200],
    borderStrong: p.paper[300],
    text1: p.paper[900],
    text2: p.paper[600],
    text3: p.paper[500],
    textOnAccent: '#FFFFFF',
    accent: p.qubit[700],
    accentHover: p.qubit[800],
    accentMuted: 'rgba(14, 116, 144, 0.10)',
    metal: p.brass[700],
    metalMuted: 'rgba(126, 95, 36, 0.10)',
    success: p.signal.greenLight,
    successMuted: 'rgba(15, 122, 69, 0.10)',
    warning: p.signal.amberLight,
    warningMuted: 'rgba(148, 86, 0, 0.10)',
    danger: p.signal.coralLight,
    dangerMuted: 'rgba(184, 50, 39, 0.09)',
    focus: p.qubit[700],
    selection: 'rgba(14, 116, 144, 0.18)',
    diffAddBg: 'rgba(15, 122, 69, 0.10)',
    diffDelBg: 'rgba(184, 50, 39, 0.09)',
    scrollbar: 'rgba(74, 84, 104, 0.25)',
    shadowFloat: '0 16px 40px -12px rgba(18, 24, 38, 0.25), 0 2px 8px rgba(18, 24, 38, 0.10)',
  },
  syntax: {
    keyword: '#5B3FD9',
    string: '#1E6E39',
    number: '#7E5F24',
    comment: '#6B7486',
    function: p.qubit[700],
    type: '#A24306',
    variable: p.paper[900],
    operator: p.paper[600],
    tag: p.signal.coralLight,
    attribute: '#7E5F24',
  },
};

export const themes: Record<string, Theme> = {
  [darkTheme.id]: darkTheme,
  [lightTheme.id]: lightTheme,
};

export function cssVarName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d+)/g, '-$1')}`;
}
