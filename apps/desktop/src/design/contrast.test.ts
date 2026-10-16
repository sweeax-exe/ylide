import { describe, expect, it } from 'vitest';
import { darkTheme, lightTheme, type Theme } from './themes';

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const AA = 4.5;

describe.each([darkTheme, lightTheme])('$id meets WCAG AA', (theme: Theme) => {
  const c = theme.colors;
  const surfaces = { bgSunken: c.bgSunken, bgApp: c.bgApp, bgRaised: c.bgRaised };
  const foregrounds = {
    text1: c.text1,
    text2: c.text2,
    text3: c.text3,
    accent: c.accent,
    metal: c.metal,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
  };
  for (const [fgName, fg] of Object.entries(foregrounds)) {
    for (const [bgName, bg] of Object.entries(surfaces)) {
      it(`${fgName} on ${bgName}`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA);
      });
    }
  }
  it('text on accent buttons', () => {
    expect(contrast(c.textOnAccent, c.accent)).toBeGreaterThanOrEqual(AA);
  });
  it('syntax colours stay readable on the editor canvas (comments may be softer)', () => {
    for (const [k, v] of Object.entries(theme.syntax)) {
      const min = k === 'comment' ? 3.5 : AA;
      expect(contrast(v, c.bgSunken), k).toBeGreaterThanOrEqual(min);
    }
  });
});
