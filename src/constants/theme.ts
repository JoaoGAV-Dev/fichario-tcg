import { Platform } from 'react-native';

// Paleta (tema escuro único): roxo vibrante + amarelo elétrico, verde/vermelho para variação.
const dark = {
  text: '#F5F3FF',
  textSecondary: '#A9A3C9',
  background: '#0B0A14',
  card: '#15132A',
  backgroundElement: '#211D3D',
  backgroundSelected: '#2D2752',
  border: '#2A2547',
  accent: '#8B5CF6',
  accentText: '#FFFFFF',
  highlight: '#FACC15',
  highlightText: '#1F1500',
  up: '#34D399',
  down: '#F87171',
  muted: '#6E6890',
  heroFrom: '#5B21B6',
  heroTo: '#1E1B4B',
} as const;

export const Colors = { light: dark, dark } as const;

export type ThemeColors = { [K in keyof typeof Colors.light]: string };

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', rounded: 'ui-rounded', mono: 'ui-monospace' },
  default: { sans: 'normal', rounded: 'normal', mono: 'monospace' },
  web: { sans: 'var(--font-display)', rounded: 'var(--font-rounded)', mono: 'var(--font-mono)' },
});

export const Spacing = { half: 2, one: 4, two: 8, three: 16, four: 24, five: 32, six: 64 } as const;
