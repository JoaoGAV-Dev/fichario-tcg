import { Platform } from 'react-native';

// Paleta: fundo neutro, destaque amarelo-elétrico (cara de carta Pokémon), verde/vermelho para variação.
export const Colors = {
  light: {
    text: '#15161A',
    textSecondary: '#62656E',
    background: '#F6F5F1',
    card: '#FFFFFF',
    backgroundElement: '#ECEAE3',
    backgroundSelected: '#DEDBD0',
    border: '#E2DFD6',
    accent: '#F2B705',
    accentText: '#2A2100',
    up: '#1E8E4E',
    down: '#C9372C',
    muted: '#9A9CA3',
  },
  dark: {
    text: '#F3F2EE',
    textSecondary: '#A6A8AF',
    background: '#0F1013',
    card: '#191A1F',
    backgroundElement: '#22242A',
    backgroundSelected: '#2E3138',
    border: '#2A2C33',
    accent: '#F7C934',
    accentText: '#2A2100',
    up: '#3CCB7F',
    down: '#FF6B5E',
    muted: '#6E717A',
  },
} as const;

export type ThemeColors = { [K in keyof typeof Colors.light]: string };

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', rounded: 'ui-rounded', mono: 'ui-monospace' },
  default: { sans: 'normal', rounded: 'normal', mono: 'monospace' },
  web: { sans: 'var(--font-display)', rounded: 'var(--font-rounded)', mono: 'var(--font-mono)' },
});

export const Spacing = { half: 2, one: 4, two: 8, three: 16, four: 24, five: 32, six: 64 } as const;
