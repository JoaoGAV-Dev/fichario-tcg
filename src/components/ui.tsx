import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
  type StyleProp, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';
import { brl, pctLabel } from '@/lib/format';

type Variant = 'title' | 'h2' | 'body' | 'small' | 'label' | 'money';

export function Txt({ variant = 'body', color, style, ...rest }: TextProps & { variant?: Variant; color?: string }) {
  const t = useTheme();
  return <Text {...rest} style={[styles[variant], { color: color ?? (variant === 'small' || variant === 'label' ? t.textSecondary : t.text) }, style]} />;
}

export function Panel({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.panel, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

export function Button({
  title, onPress, kind = 'primary', loading, disabled, style,
}: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'secondary' ? t.backgroundElement : 'transparent';
  const fg = kind === 'primary' ? t.accentText : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? t.text : t.backgroundElement }]}>
      <Text style={[styles.chipText, { color: active ? t.background : t.text }]}>{label}</Text>
    </Pressable>
  );
}

/** "+12,4%" verde / "-3,1%" vermelho / "sem histórico" cinza */
export function ChangePill({ pct, style }: { pct: number | null; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  const color = pct === null ? t.muted : pct > 0 ? t.up : pct < 0 ? t.down : t.textSecondary;
  return <Text style={[styles.pill, { color }, style]}>{pctLabel(pct)}</Text>;
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={t.text} />
      {label ? <Txt variant="small" style={{ marginTop: 8 }}>{label}</Txt> : null}
    </View>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={[styles.center, { paddingVertical: 48, paddingHorizontal: 24 }]}>
      <Txt variant="h2" style={{ textAlign: 'center' }}>{title}</Txt>
      {children}
    </View>
  );
}

/** Gráfico de linha simples (sem biblioteca extra) com mínimo e máximo marcados. */
export function PriceChart({ points, height = 140 }: { points: { date: string; value: number }[]; height?: number }) {
  const t = useTheme();
  const width = 320;
  if (points.length < 2) {
    return (
      <View style={[styles.center, { height }]}>
        <Txt variant="small" style={{ textAlign: 'center' }}>
          O gráfico aparece a partir de 2 dias de coleta.
        </Txt>
      </View>
    );
  }
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = 14;
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2 - 10));
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const last = points[points.length - 1];
  const up = last.value >= points[0].value;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      <Line x1={pad} x2={width - pad} y1={y(min)} y2={y(min)} stroke={t.border} strokeDasharray="3 4" />
      <Line x1={pad} x2={width - pad} y1={y(max)} y2={y(max)} stroke={t.border} strokeDasharray="3 4" />
      <Polyline points={line} fill="none" stroke={up ? t.up : t.down} strokeWidth={2.2} strokeLinejoin="round" />
      <Circle cx={x(points.length - 1)} cy={y(last.value)} r={3.5} fill={up ? t.up : t.down} />
      <SvgText x={width - pad} y={height - 2} fontSize={10} fill={t.textSecondary} textAnchor="end">
        {`mín ${brl(min)} · máx ${brl(max)}`}
      </SvgText>
    </Svg>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  h2: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 15 },
  small: { fontSize: 13 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  money: { fontSize: 32, fontWeight: '800', fontVariant: ['tabular-nums'] },
  panel: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 15, fontWeight: '700' },
  chip: { borderRadius: 999, paddingVertical: 7, paddingHorizontal: 13 },
  chipText: { fontSize: 13, fontWeight: '600' },
  pill: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  center: { alignItems: 'center', justifyContent: 'center', padding: 16 },
});
