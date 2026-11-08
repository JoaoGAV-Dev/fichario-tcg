// Meus lacrados: ETB, booster, box, blister… com idioma, quantidade e valor estimado.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { Chip, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { onDataChanged } from '@/lib/db';
import { brl } from '@/lib/format';
import { LANG_LABEL, listSealed, sealedBRL, setSealedQty, type SealedItem } from '@/lib/sealed';
import { getFx } from '@/lib/sources/fast';

export default function SealedScreen() {
  const t = useTheme();
  const [items, setItems] = useState<SealedItem[] | null>(null);
  const [fx, setFx] = useState<number | null>(null);
  const load = useCallback(() => {
    listSealed().then(setItems).catch(() => setItems([]));
  }, []);
  useFocusEffect(load);
  useEffect(() => onDataChanged(load), [load]);
  useEffect(() => {
    getFx().then((f) => setFx(f?.USD ?? null)).catch(() => {});
  }, []);

  const count = (items ?? []).reduce((a, i) => a + i.quantity, 0);
  const total = (items ?? []).reduce((a, i) => a + (sealedBRL(i.usd, fx) ?? 0) * i.quantity, 0);

  return (
    <>
      <Stack.Screen options={{ title: 'Meus lacrados' }} />
      <FlatList
        data={items ?? []}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={{ padding: 16, paddingBottom: 60, gap: 10 }}
        ListHeaderComponent={
          <View style={[styles.head, { backgroundColor: t.card, borderColor: t.border }]}>
            <Txt variant="small">{count} {count === 1 ? 'produto' : 'produtos'} lacrados</Txt>
            <Txt style={{ fontSize: 26, fontWeight: '900', color: t.up }}>≈ {brl(total)}</Txt>
            <Txt variant="small">Valor de mercado nos EUA (TCGplayer) convertido para reais.</Txt>
          </View>
        }
        ListEmptyComponent={
          items ? (
            <Pressable onPress={() => router.push('/scan')} style={[styles.empty, { borderColor: t.border }]}>
              <MaterialCommunityIcons name="package-variant-closed" size={36} color={t.muted} />
              <Txt style={{ textAlign: 'center' }}>
                Nenhum lacrado ainda. No Escanear, toque em “Lacrados” e aponte para a frente do produto.
              </Txt>
            </Pressable>
          ) : undefined
        }
        renderItem={({ item }) => {
          const v = sealedBRL(item.usd, fx);
          return (
            <View style={[styles.row, { backgroundColor: t.card, borderColor: t.border }]}>
              {item.image ? <Image source={{ uri: item.image }} style={styles.img} contentFit="contain" /> : <View style={styles.img} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt numberOfLines={2} style={{ fontWeight: '800' }}>{item.name}</Txt>
                <Txt variant="small" style={{ color: t.highlight }} numberOfLines={1}>
                  {item.type} · {LANG_LABEL[item.lang] ?? item.lang}
                </Txt>
                <Txt style={{ fontWeight: '800' }}>{v !== null ? `≈ ${brl(v)}` : 'sem preço'}</Txt>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Chip label="−" onPress={() => setSealedQty(item.id, item.quantity - 1)} />
                <Txt style={{ minWidth: 20, textAlign: 'center', fontWeight: '700' }}>{item.quantity}</Txt>
                <Chip label="+" onPress={() => setSealedQty(item.id, item.quantity + 1)} />
              </View>
            </View>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  head: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 4, marginBottom: 6 },
  empty: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 20, padding: 24, alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  img: { width: 56, height: 70, borderRadius: 6 },
});
