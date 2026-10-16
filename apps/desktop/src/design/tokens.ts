// Ylide design primitives. Themes (themes.ts) map these to semantic roles;
// components only ever use the semantic CSS variables. See docs/design.md.

export const palette = {
  /** Cryostat blues: surfaces of the dark theme. */
  cryo: {
    950: '#0C111B',
    900: '#111726',
    850: '#141B2A',
    800: '#18202F',
    750: '#1E2839',
    700: '#273246',
    600: '#35425B',
    500: '#4A5670',
    400: '#808CA6',
    300: '#9AA6BB',
    200: '#C6CEDC',
    100: '#E7ECF4',
  },
  /** Qubit cyan: the single signal colour. */
  qubit: {
    200: '#A5F3FC',
    300: '#67E8F9',
    400: '#22D3EE',
    500: '#06B6D4',
    600: '#0891B2',
    700: '#0E7490',
    800: '#0B4F5F',
    900: '#0B2530',
  },
  /** Brass (the cryostat chandelier): hardware, memory, "local". */
  brass: {
    200: '#EFDDB8',
    300: '#E2C795',
    400: '#C9A66B',
    600: '#93702F',
    700: '#7E5F24',
    900: '#2A2112',
  },
  /** Paper: surfaces of the light theme. */
  paper: {
    0: '#FFFFFF',
    50: '#F5F7FA',
    100: '#EDF0F5',
    150: '#E4E8EF',
    200: '#D6DCE5',
    300: '#B9C1CE',
    500: '#667085',
    600: '#4A5468',
    900: '#121826',
  },
  signal: {
    greenDark: '#3DD68C',
    greenLight: '#0F7A45',
    amberDark: '#F2A93B',
    amberLight: '#945600',
    coralDark: '#F47067',
    coralLight: '#B83227',
  },
} as const;

/** 4 px grid. */
export const space = {
  0: '0px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  7: '32px',
  8: '40px',
  9: '48px',
  10: '64px',
} as const;

/** Radii follow hierarchy: chips < controls < panels < dialogs. */
export const radius = {
  chip: '3px',
  control: '5px',
  panel: '8px',
  dialog: '12px',
  round: '999px',
} as const;

export const font = {
  ui: '"Instrument Sans Variable", "Instrument Sans", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  code: '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Mono", Consolas, monospace',
} as const;

/** Type scale in px; 13 is the UI base. */
export const fontSize = {
  xs: '11px',
  sm: '12px',
  base: '13px',
  md: '14px',
  lg: '16px',
  xl: '20px',
  xxl: '28px',
  display: '44px',
} as const;

export const lineHeight = {
  tight: '1.2',
  ui: '1.45',
  prose: '1.6',
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '360ms',
  scan: '1600ms',
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

export const layout = {
  titleBar: '38px',
  statusBar: '26px',
  activityRail: '44px',
  sidebar: '264px',
  rightPanel: '400px',
} as const;
