import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Loading, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { ownedBySet } from '@/lib/collection';
import { getSeries, setLogo, type Serie } from '@/lib/tcgdex';

export default function SetsScreen() {
  const t = useTheme();
  const [series, setSeries] = useState<Serie[] | null>(null);
  const [owned, setOwned] = useState<Record<string, Set<string>>>({});
  const [q, setQ] = useState('');

  useEffect(() => {
    getSeries().then(setSeries).catch((e) => { Alert.alert('Erro ao carregar coleções', String(e)); setSeries([]); });
  }, []);
  useFocusEffect(useCallback(() => { ownedBySet().then(setOwned).catch(() => {}); }, []));

  const sections = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (series ?? [])
      .map((s) => ({
        title: s.name,
        data: s.sets.filter((x) => !term || x.name.toLowerCase().includes(term) || x.id.toLowerCase().includes(term)),
      }))
      .filter((s) => s.data.length);
  }, [series, q]);

  if (!series) return <Loading label="Baixando lista de coleções…" />;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <SectionList
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        sections={sections}
        keyExtractor={(s) => s.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            <Txt variant="title">Coleções</Txt>
            <TextInput
              value={q} onChangeText={setQ} placeholder="Buscar coleção (ex.: Obsidiana, 151)"
              placeholderTextColor={t.muted}
              style={[styles.search, { backgroundColor: t.card, borderColor: t.border, color: t.text }]}
            />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Txt variant="label" style={{ marginTop: 18, marginBottom: 8 }}>{section.title}</Txt>
        )}
        renderItem={({ item }) => {
          const have = owned[item.id]?.size ?? 0;
          const total = item.cardCount.official || item.cardCount.total;
          const ratio = total ? Math.min(1, have / total) : 0;
          const logo = setLogo(item);
          return (
            <Pressable onPress={() => router.push({ pathname: '/set/[id]', params: { id: item.id, name: item.name } })}>
              <View style={[styles.row, { backgroundColor: t.card, borderColor: t.border }]}>
                <View style={styles.logoBox}>
                  {logo ? <Image source={{ uri: logo }} style={styles.logo} contentFit="contain" /> : null}
                </View>
                <View style={{ flex: 1, gap: 6 }}>
                  <Txt numberOfLines={1} style={{ fontWeight: '700' }}>{item.name}</Txt>
                  <View style={[styles.bar, { backgroundColor: t.backgroundElement }]}>
                    <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: t.accent }]} />
                  </View>
                </View>
                <Txt variant="small" style={{ minWidth: 64, textAlign: 'right' }}>{have}/{total}</Txt>
              </View>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: 8,
  },
  logoBox: { width: 72, height: 36, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 72, height: 36 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
});
