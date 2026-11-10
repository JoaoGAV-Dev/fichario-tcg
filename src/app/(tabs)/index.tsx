// Painel da coleção (inspirado no "Minha Coleção" do Deck Certo), tudo calculado no celular.
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Button, ChangePill, Chip, Empty, HeroPanel, Loading, Panel, PriceChart, SectionTitle, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { backfillCards, listCollection, ownedCards, type Item } from '@/lib/collection';
import { onDataChanged } from '@/lib/db';
import { listSealed, sealedBRL } from '@/lib/sealed';
import { getFx } from '@/lib/sources/fast';
import { brl, dateBR, pctLabel } from '@/lib/format';
import { LigaStatus, useLiga } from '@/lib/liga';
import { buildDashboard, holdingsOf, movers, pokedexGroups, valueSeries } from '@/lib/portfolio';
import { getCollectionSnapshots, getHistorySince, refreshCards, todayBR, type Snapshot } from '@/lib/prices';
import { useSettings } from '@/lib/settings';
import { imgUrl } from '@/lib/tcgdex';

type Segment = 'colecoes' | 'pokedex';
const RANGES = [
  { key: 7, label: '7 dias' },
  { key: 30, label: '30 dias' },
  { key: 90, label: '90 dias' },
  { key: 'all', label: 'Tudo' },
] as const;

export default function Home() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const { refMode } = useSettings();
  const liga = useLiga();
  const [items, setItems] = useState<Item[] | null>(null);
  const [byCard, setByCard] = useState<Map<string, Snapshot[]>>(new Map());
  const [since, setSince] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>('colecoes');
  const [range, setRange] = useState<7 | 30 | 90 | 'all'>(30);
  const [setFilter, setSetFilter] = useState<string | null>(null);
  const [moverTab, setMoverTab] = useState<'down' | 'up'>('down');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [its, snaps, h] = await Promise.all([listCollection(), getCollectionSnapshots(1200), getHistorySince()]);
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
  useEffect(() => { backfillCards().then(load).catch(() => {}); }, [load]);

  const today = todayBR();
  const dash = useMemo(() => buildDashboard(items ?? [], byCard, refMode, today), [items, byCard, refMode, today]);
  const holdings = useMemo(() => holdingsOf(items ?? [], byCard, refMode, today), [items, byCard, refMode, today]);
  const series = useMemo(() => valueSeries(holdings, byCard, refMode, range, setFilter, today), [holdings, byCard, refMode, range, setFilter, today]);
  const moves = useMemo(() => movers(holdings, byCard, refMode, 30, today), [holdings, byCard, refMode, today]);
  const dex = useMemo(() => pokedexGroups(holdings), [holdings]);

  async function refreshPrices() {
    const cards = await ownedCards();
    if (!cards.length) return;
    const res = await refreshCards(cards, (d, n) => setProgress(`MYP ${d}/${n}`));
    setProgress(null);
    if (res.failed.length) Alert.alert('MYP', `${res.ok} cartas atualizadas, ${res.failed.length} sem preço na MYP.`);
  }

  if (!items) return <Loading label="Carregando sua coleção…" />;

  const col = Math.floor((width - 16 * 2 - 10) / 2) - 1;
  const seriesDelta = series.length >= 2 ? series[series.length - 1].value - series[0].value : null;
  const seriesPct = series.length >= 2 && series[0].value ? ((series[series.length - 1].value - series[0].value) / series[0].value) * 100 : null;
  const moveList = moverTab === 'down' ? moves.down : moves.up;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <View style={styles.rowBetween}>
          <Txt variant="title">Minha Coleção</Txt>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable accessibilityLabel="Conferir preço de um anúncio" onPress={() => router.push('/check')}
              style={[styles.scanFab, { backgroundColor: t.backgroundElement }]}>
              <MaterialCommunityIcons name="tag-search-outline" size={22} color={t.highlight} />
            </Pressable>
            <Pressable onPress={() => router.push('/scan')} style={[styles.scanFab, { backgroundColor: t.accent }]}>
              <MaterialCommunityIcons name="line-scan" size={22} color={t.accentText} />
            </Pressable>
          </View>
        </View>

        <View style={styles.segRow}>
          <Pressable onPress={() => setSegment('colecoes')}>
            <Txt style={[styles.seg, { color: t.textSecondary }, segment === 'colecoes' && { color: t.text, borderBottomColor: t.accent }]}>Coleções</Txt>
          </Pressable>
          <Pressable onPress={() => setSegment('pokedex')}>
            <Txt style={[styles.seg, { color: t.textSecondary }, segment === 'pokedex' && { color: t.text, borderBottomColor: t.accent }]}>Pokédex</Txt>
          </Pressable>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Buscar carta…"
            placeholderTextColor={t.muted}
            returnKeyType="search"
            onSubmitEditing={() => q.trim().length >= 2 && router.push({ pathname: '/search', params: { q: q.trim() } })}
            style={[styles.search, { backgroundColor: t.card, borderColor: t.border, color: t.text }]}
          />
        </View>

        {items.length === 0 ? (
          <Empty title="Nenhuma carta ainda">
            <MaterialCommunityIcons name="cards-playing-outline" size={64} color={t.accent} style={{ marginBottom: 8 }} />
            <Txt variant="small" style={{ textAlign: 'center', marginTop: 8 }}>
              Escaneie suas cartas ou marque pela aba Explorar.
            </Txt>
            <Button title="Escanear cartas" icon="camera-outline" onPress={() => router.push('/scan')} style={{ marginTop: 16 }} />
          </Empty>
        ) : segment === 'pokedex' ? (
          <View style={styles.grid}>
            {dex.map((g) => (
              <Pressable key={g.dexId} onPress={() => router.push({ pathname: '/pokemon/[dex]', params: { dex: String(g.dexId), name: g.name } })}>
                <View style={[styles.dexCard, { width: col, backgroundColor: t.card, borderColor: t.border }]}>
                  {g.image ? <Image source={{ uri: imgUrl(g.image, 'low') }} style={styles.dexImg} contentFit="cover" contentPosition="top" /> : null}
                  <Txt variant="small">#{String(g.dexId).padStart(4, '0')}</Txt>
                  <Txt style={{ fontWeight: '700' }} numberOfLines={1}>{g.name}</Txt>
                  <Txt variant="small">{g.cards} {g.cards === 1 ? 'carta' : 'cartas'} · {brl(g.value)}</Txt>
                </View>
              </Pressable>
            ))}
            {!dex.length ? <Txt variant="small">Nenhum Pokémon identificado ainda.</Txt> : null}
          </View>
        ) : (
          <>
            {/* ---------------------------------------------------- painel */}
            <HeroPanel style={{ gap: 10 }}>
              <Txt variant="label" color={t.highlight}>Minha coleção · painel</Txt>
              <Txt style={styles.hero}>
                Sua coleção vale <Txt style={[styles.hero, { color: t.up }]}>{brl(dash.value).replace(',00', '')}</Txt>
              </Txt>
              {dash.change30.pct !== null ? (
                <Txt>
                  <Txt style={{ color: dash.change30.delta < 0 ? t.down : t.up, fontWeight: '700' }}>
                    {dash.change30.delta < 0 ? '−' : '+'}{brl(Math.abs(dash.change30.delta))} ({pctLabel(dash.change30.pct)})
                  </Txt>{' '}
                  em 30 dias, pela variação de preço das suas cartas.
                  {dash.change30.estimated ? (
                    <Txt variant="small"> ({dash.change30.estimated} de {dash.change30.compared} estimadas pela tendência do TCGplayer)</Txt>
                  ) : null}
                </Txt>
              ) : (
                <Txt variant="small">
                  A variação de 30 dias aparece quando houver histórico{since ? ` (coletando desde ${dateBR(since)})` : ''}.
                </Txt>
              )}
              <Txt>
                Entraram <Txt style={{ fontWeight: '700' }}>{dash.entries30.distinct} cartas</Txt> ({dash.entries30.copies} cópias)
                nos últimos 30 dias, somando <Txt style={{ fontWeight: '700' }}>{brl(dash.entries30.value)}</Txt>.
              </Txt>
              <View style={styles.tiles}>
                <Tile n={String(dash.copies)} label="cartas na coleção" w={(width - 16 * 2 - 32 - 10) / 2} />
                <Tile n={String(dash.activeSets)} label="coleções ativas" w={(width - 16 * 2 - 32 - 10) / 2} />
                <Tile n={String(dash.priced)} label="cartas com preço" w={(width - 16 * 2 - 32 - 10) / 2} />
                <Tile
                  n={dash.change30.pct === null ? '—' : pctLabel(dash.change30.pct)}
                  color={dash.change30.pct === null ? undefined : dash.change30.pct < 0 ? t.down : t.up}
                  label="preço em 30 dias" w={(width - 16 * 2 - 32 - 10) / 2}
                />
              </View>
            </HeroPanel>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title={progress ?? 'Atualizar MYP'} icon="refresh" kind="secondary" loading={!!progress} onPress={refreshPrices} style={{ flex: 1 }} />
              <Button
                title={liga.running ? 'Ver Liga' : 'Atualizar Liga'} icon="web" kind="secondary" style={{ flex: 1 }}
                onPress={async () => (liga.running ? liga.show() : liga.start(await ownedCards(), { visible: true }))}
              />
            </View>
            <LigaStatus />

            {/* ---------------------------------------------------- coleções */}
            <SectionTitle icon="cards-outline" title="Coleções" right={<Txt variant="small">{dash.activeSets} ativas</Txt>} />
            <View style={styles.grid}>
              {dash.sets.map((s) => {
                const ratio = s.total ? Math.min(1, s.owned / s.total) : 0;
                return (
                  <Pressable key={s.setId} onPress={() => router.push({ pathname: '/set/[id]', params: { id: s.setId, name: s.name } })}>
                    <View style={[styles.setCard, { width: col, backgroundColor: t.card, borderColor: t.border }]}>
                      {s.cover ? (
                        <Image source={{ uri: imgUrl(s.cover, 'low') }} style={styles.cover} contentFit="cover" contentPosition="top" />
                      ) : <View style={[styles.cover, { backgroundColor: t.backgroundElement }]} />}
                      <Txt style={{ fontWeight: '700' }} numberOfLines={2}>{s.name}</Txt>
                      <View style={styles.rowBetween}>
                        <View style={[styles.bar, { backgroundColor: t.backgroundElement }]}>
                          <View style={[styles.barFill, { width: `${Math.max(ratio * 100, 2)}%`, backgroundColor: t.accent }]} />
                        </View>
                        <Txt variant="small">{s.owned} de {s.total ?? '?'}</Txt>
                      </View>
                      <Txt style={{ fontWeight: '800' }}>{s.value ? brl(s.value) : '—'}</Txt>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Button title="Abrir outra coleção" icon="plus" kind="secondary" onPress={() => router.push('/sets')} />

            {/* ---------------------------------------------------- lacrados */}
            <SealedSummary />
            <Pressable onPress={() => router.push('/check')}>
              <View style={[sealedStyles.box, { backgroundColor: t.card, borderColor: t.border }]}>
                <MaterialCommunityIcons name="tag-search-outline" size={28} color={t.highlight} />
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: '800' }}>Conferir preço de um anúncio</Txt>
                  <Txt variant="small">Mande o print de uma carta, graduada ou lacrado e veja se o preço está ok</Txt>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={22} color={t.textSecondary} />
              </View>
            </Pressable>
            <Pressable onPress={() => router.push('/grade')}>
              <View style={[sealedStyles.box, { backgroundColor: t.card, borderColor: t.border }]}>
                <MaterialCommunityIcons name="magnify-scan" size={28} color={t.highlight} />
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: '800' }}>Avaliar para graduar</Txt>
                  <Txt variant="small">Fotos da frente e do verso: centralização, cantos e bordas, e se vale a pena</Txt>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={22} color={t.textSecondary} />
              </View>
            </Pressable>

            {/* ---------------------------------------------------- mais valiosas */}
            {dash.top.length ? (
              <Panel style={{ gap: 4 }}>
                <SectionTitle icon="diamond-stone" title="Mais valiosas da sua coleção" />
                <Txt variant="small">Preços do mercado brasileiro (Liga e MYP).</Txt>
                {dash.top.slice(0, 10).map((h) => (
                  <CardRow
                    key={h.cardId}
                    image={h.item.card.image}
                    title={h.item.card.name_pt}
                    subtitle={`${h.item.card.set_name} · ${h.item.card.local_id}${h.item.card.set_official_count ? '/' + h.item.card.set_official_count : ''}${h.qty > 1 ? ` · x${h.qty}` : ''}`}
                    right={brl(h.price)}
                    onPress={() => router.push({ pathname: '/card/[id]', params: { id: h.cardId } })}
                  />
                ))}
              </Panel>
            ) : null}

            {/* ---------------------------------------------------- evolução */}
            <Panel style={{ gap: 10 }}>
              <SectionTitle icon="chart-areaspline" title="Evolução do valor" />
              <Txt variant="small">As cartas que você tem hoje, nos preços de cada dia.</Txt>
              <View style={styles.wrap}>
                {RANGES.map((r) => <Chip key={String(r.key)} label={r.label} active={range === r.key} onPress={() => setRange(r.key)} />)}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                <Chip label="Todas" active={!setFilter} onPress={() => setSetFilter(null)} />
                {dash.sets.map((s) => <Chip key={s.setId} label={s.name} active={setFilter === s.setId} onPress={() => setSetFilter(s.setId)} />)}
              </ScrollView>
              {series.length >= 2 ? (
                <Txt variant="small">
                  {dateBR(series[0].date).slice(0, 5)} a {dateBR(series[series.length - 1].date).slice(0, 5)} ·{' '}
                  <Txt variant="small" style={{ color: (seriesDelta ?? 0) < 0 ? t.down : t.up, fontWeight: '700' }}>
                    {(seriesDelta ?? 0) < 0 ? '−' : '+'}{brl(Math.abs(seriesDelta ?? 0))} ({pctLabel(seriesPct === null ? null : Math.round(seriesPct * 10) / 10)})
                  </Txt>
                </Txt>
              ) : null}
              <PriceChart points={series} />
              {since && series.length && series[0].date < since ? (
                <Txt variant="small">Antes de {dateBR(since)} (início da sua coleta) o valor é estimado pela tendência do TCGplayer.</Txt>
              ) : null}
            </Panel>

            {/* ---------------------------------------------------- movimentações */}
            <Panel style={{ gap: 8 }}>
              <SectionTitle icon="swap-vertical-bold" title="Movimentações" />
              <Txt variant="small">O que mais mexeu no valor da sua coleção nos últimos 30 dias.</Txt>
              <View style={[styles.toggle, { backgroundColor: t.backgroundElement }]}>
                {(['down', 'up'] as const).map((k) => (
                  <Pressable key={k} onPress={() => setMoverTab(k)} style={[styles.toggleBtn, moverTab === k && { backgroundColor: t.accent }]}>
                    <Txt style={{ fontWeight: '700', color: moverTab === k ? t.accentText : t.text }}>{k === 'down' ? '▼ Caíram' : '▲ Subiram'}</Txt>
                  </Pressable>
                ))}
              </View>
              {moveList.length ? moveList.slice(0, 10).map((m) => (
                <CardRow
                  key={m.holding.cardId}
                  image={m.holding.item.card.image}
                  title={m.holding.item.card.name_pt}
                  badge={<Txt variant="small"><ChangePill pct={m.pct} />{m.estimated ? '*' : ''}</Txt>}
                  subtitle={`${m.holding.item.card.set_name} · ${m.holding.item.card.local_id}`}
                  right={brl(m.now)}
                  rightSub={`${m.delta < 0 ? '−' : '+'}${brl(Math.abs(m.delta))}`}
                  rightSubColor={m.delta < 0 ? t.down : t.up}
                  onPress={() => router.push({ pathname: '/card/[id]', params: { id: m.holding.cardId } })}
                />
              )) : (
                <Txt variant="small">Sem movimentações ainda: precisa de preço antigo (coleta ou histórico do TCGplayer).</Txt>
              )}
              {moveList.some((m) => m.estimated) ? <Txt variant="small">* estimado pela tendência do TCGplayer.</Txt> : null}
            </Panel>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ n, label, color }: { n: string; label: string; w?: number; color?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.tile, { borderColor: '#FFFFFF22', backgroundColor: '#FFFFFF12' }]}>
      <Txt style={{ fontSize: 24, fontWeight: '800', color: color ?? t.text }}>{n}</Txt>
      <Txt variant="small">{label}</Txt>
    </View>
  );
}

function CardRow({
  image, title, subtitle, right, rightSub, rightSubColor, badge, onPress,
}: {
  image: string | null | undefined; title: string; subtitle: string; right: string;
  rightSub?: string; rightSubColor?: string; badge?: React.ReactNode; onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress}>
      <View style={[styles.cardRow, { borderTopColor: t.border }]}>
        {image ? <Image source={{ uri: imgUrl(image, 'low') }} style={styles.thumb} contentFit="contain" /> : <View style={[styles.thumb, { backgroundColor: t.backgroundElement }]} />}
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Txt numberOfLines={1} style={{ fontWeight: '700', flexShrink: 1 }}>{title}</Txt>
            {badge}
          </View>
          <Txt variant="small" numberOfLines={2}>{subtitle}</Txt>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Txt style={{ fontWeight: '800' }}>{right}</Txt>
          {rightSub ? <Txt variant="small" style={{ color: rightSubColor, fontWeight: '700' }}>{rightSub}</Txt> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  scanFab: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  seg: { fontSize: 16, fontWeight: '700', paddingBottom: 6, borderBottomWidth: 2.5, borderBottomColor: 'transparent' },
  search: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  hero: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  tile: { flexGrow: 1, flexBasis: '45%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, gap: 2 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  setCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 10, gap: 8, overflow: 'hidden' },
  cover: { width: '100%', height: 96, borderRadius: 10 },
  bar: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toggle: { flexDirection: 'row', borderRadius: 12, padding: 4 },
  toggleBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  thumb: { width: 40, height: 56, borderRadius: 4 },
  dexCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 10, gap: 2 },
  dexImg: { width: '100%', height: 90, borderRadius: 8, marginBottom: 6 },
});

/** Atalho para "Meus lacrados" (ETB, booster, box…), com quantidade e valor estimado. */
function SealedSummary() {
  const t = useTheme();
  const [info, setInfo] = useState<{ n: number; value: number } | null>(null);
  const load = useCallback(() => {
    Promise.all([listSealed(), getFx()]).then(([items, fx]) => {
      const n = items.reduce((a, i) => a + i.quantity, 0);
      const value = items.reduce((a, i) => a + (sealedBRL(i.usd, fx?.USD ?? null) ?? 0) * i.quantity, 0);
      setInfo({ n, value });
    }).catch(() => {});
  }, []);
  useFocusEffect(load);
  useEffect(() => onDataChanged(load), [load]);
  return (
    <Pressable onPress={() => router.push('/sealed')}>
      <View style={[sealedStyles.box, { backgroundColor: t.card, borderColor: t.border }]}>
        <MaterialCommunityIcons name="package-variant-closed" size={28} color={t.highlight} />
        <View style={{ flex: 1 }}>
          <Txt style={{ fontWeight: '800' }}>Meus lacrados</Txt>
          <Txt variant="small">
            {info?.n ? `${info.n} ${info.n === 1 ? 'produto' : 'produtos'} · ≈ ${brl(info.value)}` : 'ETB, booster, box, blister… escaneie em “Lacrados”'}
          </Txt>
        </View>
        <MaterialCommunityIcons name="chevron-right" size={22} color={t.textSecondary} />
      </View>
    </Pressable>
  );
}

const sealedStyles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
});
