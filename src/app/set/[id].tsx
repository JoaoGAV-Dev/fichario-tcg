// Coleção como um fichário de verdade: páginas 3×3 para folhear, cartas que você tem coloridas e as
// que faltam apagadas, quanto falta para completar e a lista do que falta (da mais barata à mais cara).
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, FlatList, Pressable, ScrollView, Share, StyleSheet, useWindowDimensions, View, type ViewStyle,
} from 'react-native';

import { Chip, Loading, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { onDataChanged } from '@/lib/db';
import { ownedQtyForSet } from '@/lib/collection';
import { brl } from '@/lib/format';
import { setPriceMap } from '@/lib/sources/fast';
import { getSet, imgUrl, type CardBrief, type SetDetail } from '@/lib/tcgdex';
import { metaSet } from '@/lib/cardinfo';
import { visionCard } from '@/lib/vision';

type View_ = 'fichario' | 'grade' | 'faltam';
const PER_PAGE = 9;

// Escala de cinza nas cartas que faltam (Android 12+; nos mais antigos fica só apagada)
const GRAY = { filter: [{ grayscale: 1 }] } as unknown as ViewStyle;

/** Imagem da carta; as que o TCGdex não tem em PT vêm do banco do reconhecimento. */
const imageOf = (c: CardBrief): string | null => c.image ?? visionCard(c.id)?.image ?? null;

const numOf = (c: CardBrief) => {
  const n = parseInt(c.localId, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

export default function SetScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [set, setSet] = useState<SetDetail | null>(null);
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [prices, setPrices] = useState<Map<string, number> | null>(null);
  const [mode, setMode] = useState<View_>('fichario');
  const [withSecret, setWithSecret] = useState(false);
  const [page, setPage] = useState(0);
  const pager = useRef<FlatList<CardBrief[]>>(null);

  useEffect(() => {
    getSet(id).catch(() => getSet(id, 'en')).catch((e) => {
      const m = metaSet(id); // lançamento que o TCGdex ainda não tem
      if (m) return m;
      throw e;
    }).then(setSet).catch((e) => Alert.alert('Erro', String(e)));
  }, [id]);
  const loadOwned = useCallback(() => {
    ownedQtyForSet(id).then(setQty).catch(() => {});
  }, [id]);
  useFocusEffect(loadOwned);
  useEffect(() => onDataChanged(loadOwned), [loadOwned]);

  const official = set ? set.cardCount.official || set.cardCount.total : 0;
  const all = useMemo(() => [...(set?.cards ?? [])].sort((a, b) => numOf(a) - numOf(b) || a.localId.localeCompare(b.localId)), [set]);
  const hasSecret = all.length > official;
  // "Completar" = cartas oficiais; as secretas entram se a pessoa pedir
  const target = useMemo(() => (withSecret || !hasSecret ? all : all.filter((c) => numOf(c) <= official)), [all, withSecret, hasSecret, official]);

  // Preços da coleção inteira na MYP (menor preço), para o "quanto falta"
  useEffect(() => {
    if (!set) return;
    setPriceMap({ id: set.id, name: set.name, abbr: set.abbreviation?.official ?? null, official }, all.map((c) => c.localId))
      .then(setPrices).catch(() => setPrices(new Map()));
  }, [set, all, official]);

  const ownedIn = target.filter((c) => qty.has(c.id));
  const missing = target.filter((c) => !qty.has(c.id));
  const priceOf = (c: CardBrief) => prices?.get(c.localId) ?? null;
  const missingPriced = missing.filter((c) => priceOf(c) !== null);
  const missingCost = missingPriced.reduce((a, c) => a + priceOf(c)!, 0);
  const ownedValue = all.reduce((a, c) => a + (priceOf(c) ?? 0) * (qty.get(c.id) ?? 0), 0);
  const pct = target.length ? ownedIn.length / target.length : 0;
  const missingSorted = [...missing].sort((a, b) => (priceOf(a) ?? 1e9) - (priceOf(b) ?? 1e9));

  const pages = useMemo(() => {
    const out: CardBrief[][] = [];
    for (let i = 0; i < all.length; i += PER_PAGE) out.push(all.slice(i, i + PER_PAGE));
    return out;
  }, [all]);

  if (!set) return <Loading label="Abrindo coleção…" />;

  const pagePad = 14;
  const gap = 8;
  const pocketW = (width - 32 - pagePad * 2 - gap * 2) / 3;
  const pocketH = pocketW * 1.4;

  async function shareMissing() {
    const lines = missingSorted.map((c) => `${c.localId} ${c.name}${priceOf(c) !== null ? ` — ${brl(priceOf(c))}` : ''}`);
    await Share.share({
      message: `Faltam ${missing.length} cartas de ${set!.name}${missingPriced.length ? ` (≈ ${brl(missingCost)})` : ''}:\n${lines.join('\n')}`,
    }).catch(() => {});
  }

  const Header = (
    <View style={{ gap: 12, marginBottom: 12 }}>
      <LinearGradient colors={[t.heroFrom, t.heroTo]} style={styles.hero}>
        <Txt variant="small" color="#E9E5FF">
          {set.serie?.name} · {set.abbreviation?.official ?? set.id.toUpperCase()} · {official} cartas
          {hasSecret ? ` + ${all.length - official} secretas` : ''}
        </Txt>
        <Txt style={{ fontSize: 24, fontWeight: '900', color: '#fff' }}>
          {ownedIn.length} de {target.length} <Txt style={{ fontSize: 16, color: '#E9E5FF' }}>({Math.round(pct * 100)}%)</Txt>
        </Txt>
        <View style={styles.barBg}>
          <View style={[styles.barFg, { width: `${Math.max(2, pct * 100)}%`, backgroundColor: pct >= 1 ? t.up : t.highlight }]} />
        </View>
        <View style={styles.heroRow}>
          <View style={{ flex: 1 }}>
            <Txt variant="small" color="#E9E5FF">Suas cartas valem</Txt>
            <Txt style={{ fontWeight: '800', fontSize: 17, color: '#fff' }}>{prices ? brl(ownedValue) : '…'}</Txt>
          </View>
          <View style={{ flex: 1 }}>
            <Txt variant="small" color="#E9E5FF">Para completar</Txt>
            <Txt style={{ fontWeight: '800', fontSize: 17, color: pct >= 1 ? t.up : '#fff' }}>
              {pct >= 1 ? 'Completa! 🎉' : !prices ? '…' : missingPriced.length ? `≈ ${brl(missingCost)}` : 'sem preço'}
            </Txt>
            {prices && missing.length > missingPriced.length && missingPriced.length ? (
              <Txt variant="small" color="#E9E5FF">{missing.length - missingPriced.length} sem preço na MYP</Txt>
            ) : null}
          </View>
        </View>
      </LinearGradient>
      <View style={styles.chips}>
        <Chip label="Fichário" active={mode === 'fichario'} onPress={() => setMode('fichario')} />
        <Chip label="Grade" active={mode === 'grade'} onPress={() => setMode('grade')} />
        <Chip label={`O que falta (${missing.length})`} active={mode === 'faltam'} onPress={() => setMode('faltam')} />
        {hasSecret ? <Chip label="Incluir secretas" active={withSecret} onPress={() => setWithSecret((v) => !v)} /> : null}
      </View>
    </View>
  );

  const pocket = (c: CardBrief, w: number, h: number) => {
    const n = qty.get(c.id) ?? 0;
    const image = imageOf(c);
    return (
      <Pressable key={c.id} onPress={() => router.push({ pathname: '/card/[id]', params: { id: c.id } })} style={{ width: w }}>
        <View style={[styles.pocket, { width: w, height: h, borderColor: n ? t.highlight : t.border, backgroundColor: t.backgroundElement }]}>
          {image ? (
            <View style={[{ width: w - 6, height: h - 6, opacity: n ? 1 : 0.28 }, !n && GRAY]}>
              <Image source={{ uri: imgUrl(image, 'low') }} style={{ width: '100%', height: '100%', borderRadius: 5 }} contentFit="contain" transition={120} />
            </View>
          ) : (
            <Txt variant="small" style={{ textAlign: 'center', padding: 4 }}>{c.name}</Txt>
          )}
          {!n ? (
            <View style={styles.pocketNum} pointerEvents="none">
              <Txt style={{ fontWeight: '900', fontSize: 18, color: t.textSecondary }}>{c.localId}</Txt>
            </View>
          ) : null}
          {n > 1 ? (
            <View style={[styles.badge, { backgroundColor: t.highlight }]}>
              <Txt style={{ fontWeight: '900', fontSize: 11, color: t.highlightText }}>×{n}</Txt>
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  };

  if (mode === 'fichario') {
    return (
      <>
        <Stack.Screen options={{ title: name ?? set.name }} />
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
          {Header}
          <FlatList
            ref={pager}
            data={pages}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(_, i) => String(i)}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / (width - 32)))}
            getItemLayout={(_, i) => ({ length: width - 32, offset: (width - 32) * i, index: i })}
            renderItem={({ item }) => (
              <View style={[styles.page, { width: width - 32, padding: pagePad, backgroundColor: t.card, borderColor: t.border }]}>
                {[0, 1, 2].map((r) => (
                  <View key={r} style={{ flexDirection: 'row', gap, marginBottom: r < 2 ? gap : 0 }}>
                    {[0, 1, 2].map((col) => {
                      const c = item[r * 3 + col];
                      return c ? pocket(c, pocketW, pocketH)
                        : <View key={col} style={[styles.pocket, { width: pocketW, height: pocketH, borderColor: t.border, borderStyle: 'dashed' }]} />;
                    })}
                  </View>
                ))}
              </View>
            )}
          />
          <View style={styles.pageNav}>
            <Pressable hitSlop={10} disabled={page === 0} onPress={() => pager.current?.scrollToIndex({ index: page - 1 })}>
              <MaterialCommunityIcons name="chevron-left" size={28} color={page === 0 ? t.border : t.text} />
            </Pressable>
            <Txt variant="small">Página {page + 1} de {pages.length} · arraste para o lado</Txt>
            <Pressable hitSlop={10} disabled={page >= pages.length - 1} onPress={() => pager.current?.scrollToIndex({ index: page + 1 })}>
              <MaterialCommunityIcons name="chevron-right" size={28} color={page >= pages.length - 1 ? t.border : t.text} />
            </Pressable>
          </View>
        </ScrollView>
      </>
    );
  }

  if (mode === 'faltam') {
    return (
      <>
        <Stack.Screen options={{ title: name ?? set.name }} />
        <FlatList
          data={missingSorted}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          ListHeaderComponent={
            <View>
              {Header}
              {missing.length ? (
                <Pressable onPress={shareMissing} style={[styles.share, { borderColor: t.border }]}>
                  <MaterialCommunityIcons name="share-variant" size={18} color={t.text} />
                  <Txt style={{ fontWeight: '700' }}>Compartilhar a lista do que falta</Txt>
                </Pressable>
              ) : null}
            </View>
          }
          ListEmptyComponent={<Txt style={{ textAlign: 'center', marginTop: 20 }}>Coleção completa! 🎉</Txt>}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/card/[id]', params: { id: item.id } })}
              style={[styles.row, { borderColor: t.border }]}>
              {imageOf(item) ? <Image source={{ uri: imgUrl(imageOf(item)!, 'low') }} style={styles.thumb} contentFit="contain" /> : <View style={styles.thumb} />}
              <View style={{ flex: 1 }}>
                <Txt style={{ fontWeight: '700' }} numberOfLines={1}>{item.name}</Txt>
                <Txt variant="small">{set.abbreviation?.official ?? set.id.toUpperCase()} {item.localId}/{official}</Txt>
              </View>
              <Txt style={{ fontWeight: '800', color: priceOf(item) !== null ? t.text : t.textSecondary }}>
                {prices === null ? '…' : priceOf(item) !== null ? brl(priceOf(item)) : '—'}
              </Txt>
            </Pressable>
          )}
        />
      </>
    );
  }

  // Grade (todas as cartas, com as que faltam apagadas)
  const cols = width > 600 ? 5 : 3;
  const size = (width - 16 * 2 - 8 * (cols - 1)) / cols;
  return (
    <>
      <Stack.Screen options={{ title: name ?? set.name }} />
      <FlatList
        data={all}
        numColumns={cols}
        key={cols}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        columnWrapperStyle={{ gap: 8 }}
        ListHeaderComponent={Header}
        renderItem={({ item }) => (
          <View style={{ marginBottom: 8 }}>
            {pocket(item, size, size * 1.4)}
            <Txt variant="small" numberOfLines={1} style={{ marginTop: 3, width: size }}>
              {item.localId} · {item.name}
            </Txt>
          </View>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 20, padding: 16, gap: 6 },
  barBg: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.18)', overflow: 'hidden', marginTop: 4 },
  barFg: { height: 10, borderRadius: 5 },
  heroRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  page: { borderRadius: 18, borderWidth: 1 },
  pocket: { borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  pocketNum: { position: 'absolute', alignItems: 'center', justifyContent: 'center', top: 0, bottom: 0, left: 0, right: 0 },
  badge: { position: 'absolute', top: 4, right: 4, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 },
  pageNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  share: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  thumb: { width: 40, height: 56, borderRadius: 4 },
});
