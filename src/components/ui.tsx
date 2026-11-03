import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
  type StyleProp, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';

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

/** Gráfico de linha com área, eixo de valores (3 marcas) e datas — sem biblioteca extra. */
export function PriceChart({
  points, height = 170, color,
}: { points: { date: string; value: number }[]; height?: number; color?: string }) {
  const t = useTheme();
  const width = 340;
  if (points.length < 2) {
    return (
      <View style={[styles.center, { height: 110 }]}>
        <Txt variant="small" style={{ textAlign: 'center' }}>
          {points.length === 1
            ? `Hoje: ${brl(points[0].value)}. A linha aparece a partir do 2º dia de coleta.`
            : 'Sem preços ainda para montar o gráfico.'}
        </Txt>
      </View>
    );
  }
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max === min) {
    max = max * 1.05 + 1;
    min = Math.max(0, min * 0.95 - 1);
  }
  const left = 52;
  const right = 10;
  const top = 10;
  const bottom = 24;
  const x = (i: number) => left + (i / (points.length - 1)) * (width - left - right);
  const y = (v: number) => top + (1 - (v - min) / (max - min)) * (height - top - bottom);
  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const area = `${x(0)},${height - bottom} ${line} ${x(points.length - 1)},${height - bottom}`;
  const stroke = color ?? (points[points.length - 1].value >= points[0].value ? t.up : t.down);
  const ticks = [max, (max + min) / 2, min];
  const dLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const mid = Math.floor((points.length - 1) / 2);
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
      {ticks.map((v, i) => (
        <Line key={i} x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke={t.border} strokeDasharray="3 4" />
      ))}
      {ticks.map((v, i) => (
        <SvgText key={`l${i}`} x={left - 6} y={y(v) + 4} fontSize={10} fill={t.textSecondary} textAnchor="end">
          {brl(v).replace(',00', '')}
        </SvgText>
      ))}
      <Polygon points={area} fill={stroke} fillOpacity={0.12} />
      <Polyline points={line} fill="none" stroke={stroke} strokeWidth={2.2} strokeLinejoin="round" />
      <Circle cx={x(points.length - 1)} cy={y(points[points.length - 1].value)} r={3.5} fill={stroke} />
      {[0, mid, points.length - 1].map((i, k) => (
        <SvgText key={`d${k}`} x={x(i)} y={height - 6} fontSize={10} fill={t.textSecondary} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>
          {dLabel(points[i].date)}
        </SvgText>
      ))}
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
