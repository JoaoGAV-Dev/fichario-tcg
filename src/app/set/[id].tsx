import { Image } from 'expo-image';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Chip, Loading, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { ownedBySet } from '@/lib/collection';
import { getSet, type SetDetail, imgUrl } from '@/lib/tcgdex';

type Filter = 'todas' | 'tenho' | 'faltam';

export default function SetScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [set, setSet] = useState<SetDetail | null>(null);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('todas');

  useEffect(() => {
    getSet(id).then(setSet).catch((e) => Alert.alert('Erro', String(e)));
  }, [id]);
  useFocusEffect(useCallback(() => {
    ownedBySet().then((m) => setOwned(m[id] ?? new Set())).catch(() => {});
  }, [id]));

  const cols = width > 600 ? 5 : 3;
  const size = (width - 16 * 2 - 8 * (cols - 1)) / cols;

  const cards = useMemo(() => {
    const all = set?.cards ?? [];
    if (filter === 'tenho') return all.filter((c) => owned.has(c.id));
    if (filter === 'faltam') return all.filter((c) => !owned.has(c.id));
    return all;
  }, [set, owned, filter]);

  if (!set) return <Loading label="Abrindo coleção…" />;
  const official = set.cardCount.official || set.cardCount.total;

  return (
    <>
      <Stack.Screen options={{ title: name ?? set.name }} />
      <FlatList
        data={cards}
        numColumns={cols}
        key={cols}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        columnWrapperStyle={{ gap: 8 }}
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 12 }}>
            <Txt variant="small">
              {set.serie.name} · {set.abbreviation?.official ?? set.id.toUpperCase()} · {official} cartas oficiais
              {set.cardCount.total > official ? ` (+${set.cardCount.total - official} secretas)` : ''}
            </Txt>
            <Txt variant="h2">Você tem {owned.size} de {set.cardCount.total}</Txt>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['todas', 'tenho', 'faltam'] as Filter[]).map((f) => (
                <Chip key={f} label={f[0].toUpperCase() + f.slice(1)} active={filter === f} onPress={() => setFilter(f)} />
              ))}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const have = owned.has(item.id);
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/card/[id]', params: { id: item.id } })}
              style={{ width: size, marginBottom: 8 }}>
              <View style={{ opacity: have || filter !== 'todas' ? 1 : 0.38 }}>
                {item.image ? (
                  <Image source={{ uri: imgUrl(item.image, 'low') }} style={{ width: size, height: size * 1.4, borderRadius: 6 }} contentFit="contain" transition={120} />
                ) : (
                  <View style={[styles.noimg, { width: size, height: size * 1.4, backgroundColor: t.backgroundElement }]}>
                    <Txt variant="small" style={{ textAlign: 'center' }}>{item.name}</Txt>
                  </View>
                )}
              </View>
              <Txt variant="small" numberOfLines={1} style={{ marginTop: 3 }}>
                {have ? '● ' : ''}{item.localId} · {item.name}
              </Txt>
            </Pressable>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  noimg: { borderRadius: 6, alignItems: 'center', justifyContent: 'center', padding: 6 },
});
