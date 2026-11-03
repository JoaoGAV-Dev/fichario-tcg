import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, ChangePill, Chip, Empty, Loading, Panel, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { listCollection, ownedCards, type Item } from '@/lib/collection';
import { onDataChanged } from '@/lib/db';
import { brl, dateBR } from '@/lib/format';
import { LigaStatus, useLiga } from '@/lib/liga';
import {
  PERIODS, changesFor, getCollectionSnapshots, getHistorySince, portfolioChanges, refPrice,
  refreshCards, todayBR, type Snapshot,
} from '@/lib/prices';
import { REF_LABEL, useSettings } from '@/lib/settings';

type Row = { item: Item; unit: number | null; change1m: number | null };

export default function CollectionScreen() {
  const t = useTheme();
  const { refMode } = useSettings();
  const liga = useLiga();
  const [items, setItems] = useState<Item[] | null>(null);
  const [byCard, setByCard] = useState<Map<string, Snapshot[]>>(new Map());
  const [since, setSince] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>('1m');
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [its, snaps, h] = await Promise.all([listCollection(), getCollectionSnapshots(), getHistorySince()]);
      setItems(its);
      setByCard(snaps);
      setSince(h);
    } catch (e) {
      Alert.alert('Erro ao carregar', String(e));
      setItems((cur) => cur ?? []);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => onDataChanged(() => { load(); }), [load]);

  const today = todayBR();
  const rows: Row[] = useMemo(
    () => (items ?? []).map((item) => {
      const s = byCard.get(item.card_id) ?? [];
      return { item, unit: refPrice(s, today, refMode), change1m: changesFor(s, { ref: refMode }, today)[0].pct };
    }),
    [items, byCard, refMode, today],
  );

  const total = rows.reduce((acc, r) => acc + (r.unit ?? 0) * r.item.quantity, 0);
  const priced = rows.filter((r) => r.unit !== null).length;
  const copies = rows.reduce((acc, r) => acc + r.item.quantity, 0);
  const portfolio = useMemo(() => portfolioChanges(items ?? [], byCard, refMode, today), [items, byCard, refMode, today]);
  const sel = portfolio.find((p) => p.key === period);

  const sections = useMemo(() => {
    const groups = new Map<string, { title: string; data: Row[]; value: number }>();
    for (const r of rows) {
      const k = r.item.card.set_id;
      const g = groups.get(k) ?? groups.set(k, { title: r.item.card.set_name, data: [], value: 0 }).get(k)!;
      g.data.push(r);
      g.value += (r.unit ?? 0) * r.item.quantity;
    }
    return [...groups.values()]
      .map((g) => ({ ...g, data: g.data.sort((a, b) => (b.unit ?? 0) - (a.unit ?? 0)) }))
      .sort((a, b) => b.value - a.value);
  }, [rows]);

  async function refreshPrices() {
    const cards = await ownedCards();
    if (!cards.length) return;
    const res = await refreshCards(cards, (d, n) => setProgress(`Atualizando MYP… ${d}/${n}`));
    setProgress(null);
    if (res.failed.length) {
      Alert.alert(
        'Atualização concluída',
        `${res.ok} cartas atualizadas. ${res.failed.length} sem preço na MYP (ex.: ${res.failed.slice(0, 3).map((f) => f.id).join(', ')}).`,
      );
    }
  }

  if (!items) return <Loading label="Carregando sua coleção…" />;

  const header = (
    <View style={{ gap: 14, paddingBottom: 8 }}>
      <Txt variant="title">Minha coleção</Txt>
      <Panel style={{ gap: 10 }}>
        <Txt variant="label">Valor estimado · {REF_LABEL[refMode]}</Txt>
        <Txt variant="money">{brl(total)}</Txt>
        <Txt variant="small">
          {copies} cartas · {rows.length} itens · {priced} com preço
          {since ? ` · histórico desde ${dateBR(since)}` : ''}
        </Txt>
        <View style={styles.chips}>
          {PERIODS.map((p) => (
            <Chip key={p.key} label={p.label} active={period === p.key} onPress={() => setPeriod(p.key)} />
          ))}
        </View>
        <View style={styles.rowBetween}>
          <Txt variant="small">
            {sel && sel.compared
              ? `${brl(sel.valueThen)} → ${brl(sel.valueNow)} (${sel.compared} de ${sel.total} cartas comparáveis)`
              : 'Ainda não há coleta tão antiga para comparar.'}
          </Txt>
          <ChangePill pct={sel?.pct ?? null} style={{ fontSize: 16 }} />
        </View>
      </Panel>
      <View style={styles.actions}>
        <Button title={progress ?? 'Atualizar MYP agora'} kind="secondary" onPress={refreshPrices} loading={!!progress} style={{ flex: 1 }} />
        <Button
          title={liga.running ? 'Ver Liga' : 'Atualizar Liga'} kind="secondary" style={{ flex: 1 }}
          onPress={async () => (liga.running ? liga.show() : liga.start(await ownedCards(), { visible: true }))}
        />
      </View>
      <LigaStatus />
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <SectionList
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        sections={sections}
        keyExtractor={(r) => String(r.item.id)}
        ListHeaderComponent={header}
        stickySectionHeadersEnabled={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={
          <Empty title="Nenhuma carta ainda">
            <Txt variant="small" style={{ textAlign: 'center', marginTop: 8 }}>
              Escaneie uma carta ou adicione pela aba Coleções.
            </Txt>
            <Button title="Escanear carta" onPress={() => router.push('/scan')} style={{ marginTop: 16 }} />
          </Empty>
        }
        renderSectionHeader={({ section }) => (
          <View style={[styles.rowBetween, { marginTop: 18, marginBottom: 8 }]}>
            <Txt variant="h2" numberOfLines={1} style={{ flex: 1 }}>{section.title}</Txt>
            <Txt variant="small">{brl(section.value)}</Txt>
          </View>
        )}
        renderItem={({ item: r }) => (
          <Pressable onPress={() => router.push({ pathname: '/card/[id]', params: { id: r.item.card_id } })}>
            <View style={[styles.item, { backgroundColor: t.card, borderColor: t.border }]}>
              {r.item.card.image ? (
                <Image source={{ uri: `${r.item.card.image}/low.webp` }} style={styles.thumb} contentFit="contain" />
              ) : <View style={[styles.thumb, { backgroundColor: t.backgroundElement }]} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt numberOfLines={1} style={{ fontWeight: '700' }}>{r.item.card.name_pt}</Txt>
                <Txt variant="small">
                  {r.item.card.set_abbr ?? r.item.card.set_id} {r.item.card.local_id}
                  {r.item.card.set_official_count ? `/${r.item.card.set_official_count}` : ''} · {r.item.condition} · {r.item.quantity}x
                </Txt>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Txt style={{ fontWeight: '700' }}>{brl(r.unit)}</Txt>
                <ChangePill pct={r.change1m} />
              </View>
            </View>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  actions: { flexDirection: 'row', gap: 10 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, marginBottom: 8,
  },
  thumb: { width: 44, height: 61, borderRadius: 4 },
});
