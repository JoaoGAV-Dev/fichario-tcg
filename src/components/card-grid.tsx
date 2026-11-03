import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Chip, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { ownedBySet } from '@/lib/collection';
import { setIdOf, setIndex, type CardBrief, type SetBrief, imgUrl } from '@/lib/tcgdex';

type SetInfo = SetBrief & { order: number; serie: string };

/** Grade de cartas de várias coleções (busca e Pokédex), mais novas primeiro, marcando as que você tem. */
export function CardGrid({ cards, header }: { cards: CardBrief[]; header?: React.ReactNode }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [sets, setSets] = useState<Map<string, SetInfo>>(new Map());
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [onlyOwned, setOnlyOwned] = useState(false);

  useEffect(() => { setIndex().then(setSets).catch(() => {}); }, []);
  useFocusEffect(useCallback(() => {
    ownedBySet().then((m) => setOwned(new Set(Object.values(m).flatMap((s) => [...s])))).catch(() => {});
  }, []));

  const list = useMemo(() => cards
    .filter((c) => sets.size === 0 || sets.has(setIdOf(c.id))) // tira cartas do TCG Pocket (digital)
    .filter((c) => !onlyOwned || owned.has(c.id))
    .sort((a, b) => (sets.get(setIdOf(a.id))?.order ?? 999) - (sets.get(setIdOf(b.id))?.order ?? 999)),
  [cards, sets, owned, onlyOwned]);

  const cols = width > 600 ? 5 : 3;
  const size = (width - 16 * 2 - 8 * (cols - 1)) / cols;
  const have = cards.filter((c) => owned.has(c.id)).length;

  return (
    <FlatList
      data={list}
      numColumns={cols}
      key={cols}
      keyExtractor={(c) => c.id}
      contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
      columnWrapperStyle={{ gap: 8 }}
      ListHeaderComponent={
        <View style={{ gap: 10, marginBottom: 12 }}>
          {header}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Chip label={`Todas (${list.length})`} active={!onlyOwned} onPress={() => setOnlyOwned(false)} />
            <Chip label={`Tenho (${have})`} active={onlyOwned} onPress={() => setOnlyOwned(true)} />
          </View>
        </View>
      }
      ListEmptyComponent={<Txt variant="small">Nenhuma carta encontrada.</Txt>}
      renderItem={({ item }) => {
        const mine = owned.has(item.id);
        const set = sets.get(setIdOf(item.id));
        return (
          <Pressable onPress={() => router.push({ pathname: '/card/[id]', params: { id: item.id } })} style={{ width: size, marginBottom: 10 }}>
            <View style={{ opacity: mine || onlyOwned ? 1 : 0.55 }}>
              {item.image ? (
                <Image source={{ uri: imgUrl(item.image, 'low') }} style={{ width: size, height: size * 1.4, borderRadius: 6 }} contentFit="contain" transition={100} />
              ) : (
                <View style={[styles.noimg, { width: size, height: size * 1.4, backgroundColor: t.backgroundElement }]}>
                  <Txt variant="small" style={{ textAlign: 'center' }}>{item.name}</Txt>
                </View>
              )}
            </View>
            <Txt variant="small" numberOfLines={1} style={{ marginTop: 3, fontWeight: mine ? '700' : '400', color: mine ? t.text : t.textSecondary }}>
              {mine ? '● ' : ''}{item.name}
            </Txt>
            <Txt variant="small" numberOfLines={1}>{set?.name ?? setIdOf(item.id)} · {item.localId}</Txt>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  noimg: { borderRadius: 6, alignItems: 'center', justifyContent: 'center', padding: 6 },
});
