import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, ChangePill, Chip, Loading, Panel, PriceChart, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import {
  CONDITIONS, VARIANT_LABEL, addToCollection, ensureCard, itemsForCard, setQuantity,
  type Condition, type Item, type Variant,
} from '@/lib/collection';
import { onDataChanged } from '@/lib/db';
import { brl, dateBR, money } from '@/lib/format';
import { useLiga } from '@/lib/liga';
import {
  PERIODS, cardmarketMonthTrend, changesFor, chartSeries, getCardSnapshots, refreshCards,
  type Snapshot, type Source,
} from '@/lib/prices';
import { REF_LABEL, useSettings } from '@/lib/settings';
import { getCard, type CardDetail } from '@/lib/tcgdex';

export default function CardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { refMode } = useSettings();
  const ligaRunner = useLiga();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [chartDays, setChartDays] = useState(90);
  const [variant, setVariant] = useState<Variant>('normal');
  const [condition, setCondition] = useState<Condition>('NM');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [its, s] = await Promise.all([itemsForCard(id), getCardSnapshots(id)]);
    setItems(its);
    setSnaps(s);
  }, [id]);

  useEffect(() => {
    getCard(id).then((c) => {
      setCard(c);
      const v = c.variants;
      setVariant(v?.normal ? 'normal' : v?.holo ? 'holo' : v?.reverse ? 'reverse' : 'normal');
    }).catch((e) => Alert.alert('Erro', String(e)));
    reload().catch(() => {});
  }, [id, reload]);
  useEffect(() => onDataChanged(() => { reload().catch(() => {}); }), [reload]);

  const variants = useMemo<Variant[]>(() => {
    const v = card?.variants;
    const list: Variant[] = [];
    if (!v || v.normal) list.push('normal');
    if (v?.holo) list.push('holo');
    if (v?.reverse) list.push('reverse');
    if (v?.firstEdition) list.push('firstEdition');
    if (v?.wPromo) list.push('promo');
    return list.length ? list : ['normal'];
  }, [card]);

  const latest = (src: Source) =>
    [...snaps].filter((s) => s.source === src).sort((a, b) => (a.captured_on < b.captured_on ? 1 : -1))[0];

  async function updatePrices() {
    setBusy('precos');
    try {
      const row = await ensureCard(id);
      const r = await refreshCards([row]);
      if (r.failed.length) Alert.alert('MYP', `Não achei preço na MYP: ${r.failed[0].reason}`);
    } catch (e) {
      Alert.alert('Erro', String(e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy('add');
    try {
      await addToCollection(id, { variant, condition, quantity: qty });
      await reload();
      setQty(1);
      if (!snaps.some((s) => s.source === 'myp')) updatePrices(); // primeira vez: já busca preço
      if (!snaps.some((s) => s.source === 'liga')) ligaRunner.start([await ensureCard(id)]); // e a Liga, escondido
    } catch (e) {
      Alert.alert('Erro ao adicionar', String(e));
    } finally {
      setBusy((b) => (b === 'add' ? null : b));
    }
  }

  if (!card) return <Loading label="Abrindo carta…" />;

  const liga = latest('liga');
  const myp = latest('myp');
  const cm = latest('cardmarket');
  const tp = latest('tcgplayer');
  const refChanges = changesFor(snaps, { ref: refMode });
  const ligaChanges = changesFor(snaps, 'liga');
  const mypChanges = changesFor(snaps, 'myp');
  const cmTrend = cardmarketMonthTrend(snaps);
  const points = chartSeries(snaps, refMode, chartDays);
  const owned = items.reduce((a, i) => a + i.quantity, 0);

  return (
    <>
      <Stack.Screen options={{ title: card.name }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 60 }}>
        <View style={{ flexDirection: 'row', gap: 14 }}>
          {card.image ? (
            <Image source={{ uri: `${card.image}/high.webp` }} style={styles.art} contentFit="contain" transition={150} />
          ) : <View style={[styles.art, { backgroundColor: t.backgroundElement }]} />}
          <View style={{ flex: 1, gap: 4 }}>
            <Txt variant="h2">{card.name}</Txt>
            <Txt variant="small">{card.set.name}</Txt>
            <Txt variant="small">Nº {card.localId}{card.set.cardCount?.official ? `/${card.set.cardCount.official}` : ''}</Txt>
            {card.rarity ? <Txt variant="small">{card.rarity}</Txt> : null}
            {card.illustrator ? <Txt variant="small">Ilustr.: {card.illustrator}</Txt> : null}
            <View style={{ marginTop: 8 }}>
              <Txt variant="label">Referência</Txt>
              <Txt style={{ fontSize: 22, fontWeight: '800' }}>{brl(refChanges[0].now)}</Txt>
              <Txt variant="small">{REF_LABEL[refMode]}</Txt>
            </View>
          </View>
        </View>

        {/* ------------------------------------------------ minha coleção */}
        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">{owned ? `Você tem ${owned}` : 'Adicionar à coleção'}</Txt>
          {items.map((it) => (
            <View key={it.id} style={styles.rowBetween}>
              <Txt>{VARIANT_LABEL[it.variant]} · {it.condition} · {it.language.toUpperCase()}</Txt>
              <View style={styles.stepper}>
                <Chip label="−" onPress={async () => { await setQuantity(it.id, it.quantity - 1); reload(); }} />
                <Txt style={{ minWidth: 26, textAlign: 'center', fontWeight: '700' }}>{it.quantity}</Txt>
                <Chip label="+" onPress={async () => { await setQuantity(it.id, it.quantity + 1); reload(); }} />
              </View>
            </View>
          ))}
          <View style={styles.wrap}>
            {variants.map((v) => <Chip key={v} label={VARIANT_LABEL[v]} active={variant === v} onPress={() => setVariant(v)} />)}
          </View>
          <View style={styles.wrap}>
            {CONDITIONS.map((c) => <Chip key={c} label={c} active={condition === c} onPress={() => setCondition(c)} />)}
          </View>
          <View style={styles.rowBetween}>
            <View style={styles.stepper}>
              <Chip label="−" onPress={() => setQty((q) => Math.max(1, q - 1))} />
              <Txt style={{ minWidth: 26, textAlign: 'center', fontWeight: '700' }}>{qty}</Txt>
              <Chip label="+" onPress={() => setQty((q) => q + 1)} />
            </View>
            <Button title="Adicionar" onPress={add} loading={busy === 'add'} />
          </View>
        </Panel>

        {/* ------------------------------------------------ preços atuais */}
        <Panel style={{ gap: 12 }}>
          <View style={styles.rowBetween}>
            <Txt variant="h2">Preços</Txt>
            <Pressable onPress={updatePrices} disabled={!!busy}>
              <Txt style={{ color: t.text, fontWeight: '700' }}>{busy === 'precos' ? 'Atualizando…' : 'Atualizar'}</Txt>
            </Pressable>
          </View>
          <SourceRow
            title="Liga Pokémon" date={liga?.captured_on} url={liga?.url}
            lines={[['Menor', brl(liga?.price_min)], ['Médio', brl(liga?.price_avg)], ['Maior', brl(liga?.price_max)]]}
            action={{ label: 'Ler na Liga agora', onPress: async () => ligaRunner.start([await ensureCard(id)], { visible: true }) }}
          />
          <SourceRow
            title="MYP Cards" date={myp?.captured_on} url={myp?.url}
            note={myp?.raw?.error ? String(myp.raw.error) : myp?.offers ? `${myp.offers} ofertas` : undefined}
            lines={[['Menor', brl(myp?.price_min)], ['Médio', brl(myp?.price_avg)], ['Último vendido', brl(myp?.price_last)]]}
          />
          <SourceRow
            title="Cardmarket (Europa)" date={cm?.captured_on} url={cm?.url}
            note={cmTrend !== null ? `Hoje vs. média de 30 dias: ${cmTrend > 0 ? '+' : ''}${cmTrend.toFixed(1).replace('.', ',')}%` : undefined}
            lines={[['Mínimo', money(cm?.price_min, cm?.currency ?? 'EUR')], ['Média', money(cm?.price_avg, cm?.currency ?? 'EUR')]]}
          />
          <SourceRow
            title="TCGplayer (EUA)" date={tp?.captured_on} url={tp?.url}
            lines={[['Mercado', money(tp?.price_avg, tp?.currency ?? 'USD')], ['Mínimo', money(tp?.price_min, tp?.currency ?? 'USD')]]}
          />
        </Panel>

        {/* ------------------------------------------------ variação */}
        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">Variação</Txt>
          <View style={styles.tableRow}>
            <Txt variant="label" style={styles.tableHead}> </Txt>
            {PERIODS.map((p) => <Txt key={p.key} variant="label" style={styles.tableCell}>{p.label}</Txt>)}
          </View>
          {([['Referência', refChanges], ['Liga', ligaChanges], ['MYP', mypChanges]] as const).map(([label, ch]) => (
            <View key={label} style={styles.tableRow}>
              <Txt style={[styles.tableHead, { fontWeight: '700' }]}>{label}</Txt>
              {ch.map((c) => <ChangePill key={c.key} pct={c.pct} style={styles.tableCell} />)}
            </View>
          ))}
          <Txt variant="small">
            A variação compara o preço de hoje com o último preço coletado antes de cada data.
            Enquanto não houver coleta tão antiga, aparece "sem histórico".
          </Txt>
        </Panel>

        <Panel style={{ gap: 10 }}>
          <View style={styles.rowBetween}>
            <Txt variant="h2">Histórico</Txt>
            <View style={styles.wrap}>
              {PERIODS.map((p) => (
                <Chip key={p.key} label={p.key} active={chartDays === p.days} onPress={() => setChartDays(p.days)} />
              ))}
            </View>
          </View>
          <PriceChart points={points} />
        </Panel>
      </ScrollView>
    </>
  );
}

function SourceRow({
  title, date, url, lines, note, action,
}: {
  title: string; date?: string; url?: string | null; lines: [string, string][]; note?: string;
  action?: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  return (
    <View style={[styles.source, { borderColor: t.border }]}>
      <View style={styles.rowBetween}>
        <Txt style={{ fontWeight: '700' }}>{title}</Txt>
        <Txt variant="small">{date ? dateBR(date) : 'sem coleta'}</Txt>
      </View>
      <View style={[styles.wrap, { gap: 16 }]}>
        {lines.map(([k, v]) => (
          <View key={k}>
            <Txt variant="small">{k}</Txt>
            <Txt style={{ fontWeight: '700' }}>{v}</Txt>
          </View>
        ))}
      </View>
      {note ? <Txt variant="small">{note}</Txt> : null}
      <View style={[styles.wrap, { gap: 16 }]}>
        {url ? (
          <Pressable onPress={() => Linking.openURL(url)}>
            <Txt variant="small" style={{ textDecorationLine: 'underline' }}>Abrir no site</Txt>
          </Pressable>
        ) : null}
        {action ? (
          <Pressable onPress={action.onPress}>
            <Txt variant="small" style={{ textDecorationLine: 'underline' }}>{action.label}</Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  art: { width: 150, height: 210, borderRadius: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  source: { gap: 6, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tableRow: { flexDirection: 'row', alignItems: 'center' },
  tableHead: { width: 88 },
  tableCell: { flex: 1, textAlign: 'center' },
});
