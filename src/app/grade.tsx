// Avaliar para graduar: fotos da frente e do verso (fora do sleeve) → centralização, cantos/bordas e
// riscos → teto de nota estimado (régua PSA) e se vale a pena pagar a graduação.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { assessCardAsync, recognizeImageAsync, type AssessResult } from '../../modules/card-vision';
import { Button, Txt } from '@/components/ui';
import { choose, infosFor, prepInfos, type Info } from '@/components/vision-scan';
import { useTheme } from '@/hooks/use-theme';
import { brl } from '@/lib/format';
import { parseTypedPrice } from '@/lib/grading';
import { fmtRatio, preGrade, worthGrading, type Factor } from '@/lib/pregrade';
import { quickPrice } from '@/lib/quickprice';
import { useSettings } from '@/lib/settings';
import { imgUrl } from '@/lib/tcgdex';
import { ensureVisionIndex } from '@/lib/vision';

type Side = 'front' | 'back';
const SIDE_LABEL: Record<Side, string> = { front: 'Frente', back: 'Verso' };
const fmtMoney = (v: number) => v.toFixed(2).replace('.', ',');

export default function GradeScreen() {
  const t = useTheme();
  const { refMode } = useSettings();
  const params = useLocalSearchParams<{ id?: string; sample?: string }>();
  const [res, setRes] = useState<Record<Side, AssessResult | null>>({ front: null, back: null });
  const [busy, setBusy] = useState<Side | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [card, setCard] = useState<Info | null>(null);
  const [raw, setRaw] = useState('');
  const [rawLabel, setRawLabel] = useState<string | null>(null);
  const [graded, setGraded] = useState('');
  const [cost, setCost] = useState('');
  const [tips, setTips] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem('gradeCost').then((v) => v && setCost(v)).catch(() => {});
    prepInfos();
  }, []);

  // carta (vinda da página da carta ou reconhecida pela foto da frente) e o preço dela crua
  useEffect(() => {
    if (!params.id) return;
    infosFor([params.id]).then((m) => setCard(m.get(params.id!) ?? null)).catch(() => {});
  }, [params.id]);
  useEffect(() => {
    if (!card) return;
    let alive = true;
    quickPrice(card.id, 'normal', refMode, (v, label) => {
      if (!alive || v == null) return;
      setRaw(fmtMoney(v));
      setRawLabel(label ?? null);
    });
    return () => {
      alive = false;
    };
  }, [card, refMode]);

  async function run(side: Side, uri: string) {
    setBusy(side);
    setErr(null);
    try {
      const r = await assessCardAsync(uri, side);
      setRes((x) => ({ ...x, [side]: r }));
      if (side === 'front' && !card && r.ok) {
        // descobre qual é a carta pela frente (para puxar o preço)
        const vs = await ensureVisionIndex();
        if (vs.state === 'ready') {
          const m = await recognizeImageAsync(uri, 'cards');
          if (m.matches[0] && m.matches[0].score >= vs.thresholds.min) {
            await prepInfos();
            const infos = await infosFor(m.matches.map((x) => x.id));
            const ch = choose({ id: m.matches[0].id, score: m.matches[0].score, matches: m.matches }, infos);
            if (ch) setCard(ch.pick);
          }
        }
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 140));
    } finally {
      setBusy(null);
    }
  }

  async function pick(side: Side, camera: boolean) {
    const r = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (!r.canceled && r.assets?.[0]) run(side, r.assets[0].uri);
  }

  // exemplo embutido (teste automático no emulador)
  useEffect(() => {
    if (!params.sample) return;
    (async () => {
      for (const [side, mod] of [['front', require('../../assets/test/grade-front.jpg')], ['back', require('../../assets/test/grade-back.jpg')]] as const) {
        const a = Asset.fromModule(mod);
        await a.downloadAsync();
        await run(side, a.localUri ?? a.uri);
      }
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.sample]);

  const g = res.front || res.back ? preGrade(res.front, res.back) : null;
  const rawN = parseTypedPrice(raw);
  const gradedN = parseTypedPrice(graded);
  const costN = parseTypedPrice(cost) ?? (cost.trim() === '0' ? 0 : null);
  const worth = rawN != null && gradedN != null && costN != null ? worthGrading(rawN, gradedN, costN) : null;
  const capColor = (c: number | null) => (c == null ? t.textSecondary : c >= 10 ? t.up : c >= 9 ? t.highlight : t.down);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.background }} behavior="padding">
      <Stack.Screen options={{ title: 'Avaliar para graduar' }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        {card ? (
          <Pressable onPress={() => router.push({ pathname: '/card/[id]', params: { id: card.id } })}
            style={[styles.box, { backgroundColor: t.card, borderColor: t.border, flexDirection: 'row', gap: 12, alignItems: 'center' }]}>
            {card.image ? <Image source={{ uri: imgUrl(card.image) }} style={styles.mini} contentFit="contain" /> : null}
            <View style={{ flex: 1 }}>
              <Txt style={{ fontWeight: '900', fontSize: 17 }} numberOfLines={1}>{card.name}</Txt>
              <Txt variant="small" numberOfLines={1}>{card.setName} · {card.label}</Txt>
            </View>
          </Pressable>
        ) : null}

        <Pressable onPress={() => setTips((x) => !x)} style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 6 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Txt style={{ fontWeight: '800' }}>Como fotografar</Txt>
            <MaterialCommunityIcons name={tips ? 'chevron-up' : 'chevron-down'} size={20} color={t.textSecondary} />
          </View>
          {tips ? (
            <>
              <Txt variant="small">1. Tire do sleeve/toploader (o plástico esconde os defeitos).</Txt>
              <Txt variant="small">2. Fundo liso que contraste: escuro para a frente, claro (folha branca) para o verso.</Txt>
              <Txt variant="small">3. Luz difusa, sem flash e sem reflexo na borda.</Txt>
              <Txt variant="small">4. Celular paralelo à carta, bem de cima; a carta ocupando quase toda a altura, com um pouco de fundo em volta.</Txt>
            </>
          ) : null}
        </Pressable>

        {(['front', 'back'] as Side[]).map((side) => {
          const r = res[side];
          return (
            <View key={side} style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 10 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Txt style={{ fontWeight: '900', fontSize: 17 }}>{SIDE_LABEL[side]}</Txt>
                {busy === side ? <ActivityIndicator color={t.accent} /> : null}
              </View>
              {r?.ok ? (
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Image source={{ uri: r.image }} style={styles.shot} contentFit="contain" />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Txt variant="small">Centralização</Txt>
                    <Txt style={{ fontWeight: '800' }}>↔ {fmtRatio(r.lr)}   ↕ {fmtRatio(r.tb)}</Txt>
                    <Txt variant="small">
                      Moldura (mm): E {r.borders.left?.toFixed(2) ?? '—'} · D {r.borders.right?.toFixed(2) ?? '—'} · C {r.borders.top?.toFixed(2) ?? '—'} · B {r.borders.bottom?.toFixed(2) ?? '—'}
                    </Txt>
                    <Txt variant="small">
                      {r.regions.reduce((a, x) => a + x.count, 0)
                        ? `Pontos brancos na borda: ${r.regions.reduce((a, x) => a + x.count, 0)} (círculos vermelhos)`
                        : side === 'front' && !r.colored ? 'Borda prateada: desgaste avaliado só no verso' : 'Sem branco na borda'}
                    </Txt>
                    {side === 'back' ? <Txt variant="small">{r.scratches ? `${r.scratches} possível(is) risco(s) (amarelo)` : 'Sem riscos aparentes'}</Txt> : null}
                    <Txt variant="small" style={{ color: t.muted }}>Linhas verdes: onde medi a moldura</Txt>
                  </View>
                </View>
              ) : r && !r.ok ? (
                <Txt variant="small" style={{ color: t.down }}>Não achei a carta. Use fundo liso que contraste com a borda e deixe espaço em volta.</Txt>
              ) : (
                <Txt variant="small">Foto {side === 'front' ? 'da frente' : 'do verso'} da carta, fora do sleeve.</Txt>
              )}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button title={r ? 'Refazer' : 'Câmera'} icon="camera-outline" onPress={() => pick(side, true)} style={{ flex: 1 }} disabled={!!busy} />
                <Button title="Galeria" icon="image-outline" kind="secondary" onPress={() => pick(side, false)} disabled={!!busy} />
              </View>
            </View>
          );
        })}
        {err ? <Txt variant="small" style={{ color: t.down }}>{err}</Txt> : null}

        {g ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 10 }]}>
            <Txt variant="small">Nota máxima provável (régua PSA)</Txt>
            <Txt style={{ fontWeight: '900', fontSize: 30, color: capColor(g.cap) }}>
              {g.cap == null ? '—' : `PSA ${g.cap}`}
            </Txt>
            <Txt variant="small">
              Chance de 10: <Txt variant="small" style={{ fontWeight: '800', color: g.chance10 === 'boa' ? t.up : g.chance10 === 'possível' ? t.highlight : t.textSecondary }}>{g.chance10}</Txt>
            </Txt>
            {g.factors.map((f: Factor) => (
              <View key={f.key} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                <Txt style={{ width: 40, fontWeight: '900', color: capColor(f.cap) }}>{f.cap ?? '—'}</Txt>
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: '700' }}>{f.label}</Txt>
                  <Txt variant="small">{f.detail}</Txt>
                </View>
              </View>
            ))}
            {g.warnings.map((w) => (
              <Txt key={w} variant="small" style={{ color: t.highlight }}>⚠ {w}</Txt>
            ))}
            <Txt variant="small" style={{ color: t.muted }}>
              É uma estimativa pela foto: mede centralização e branco nas bordas, mas não vê amassados, marcas de impressão nem riscos finos na frente. A nota final é do avaliador.
            </Txt>
          </View>
        ) : null}

        {g?.cap != null ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 10 }]}>
            <Txt style={{ fontWeight: '900', fontSize: 17 }}>Vale a pena graduar?</Txt>
            <Field label={`Carta crua${rawLabel ? ` (${rawLabel})` : ''}`} value={raw} onChange={setRaw} />
            <Field label={`Preço da PSA ${g.cap} desta carta (veja anúncios/vendidos)`} value={graded} onChange={setGraded} />
            <Field label="Custo para graduar (taxa + envio + seguro)" value={cost} onChange={(v) => {
              setCost(v);
              AsyncStorage.setItem('gradeCost', v).catch(() => {});
            }} />
            {worth ? (
              <View style={[styles.verdict, { borderColor: worth.verdict === 'vale' ? t.up : worth.verdict === 'empate' ? t.highlight : t.down }]}>
                <Txt style={{ fontWeight: '900', fontSize: 18, color: worth.verdict === 'vale' ? t.up : worth.verdict === 'empate' ? t.highlight : t.down }}>
                  {worth.text}
                </Txt>
                <Txt variant="small">
                  {worth.profit >= 0 ? 'Ganho' : 'Perda'} estimado de {brl(Math.abs(worth.profit))} se vier PSA {g.cap}
                  {g.cap === 10 ? '' : ' (se vier nota menor, o resultado piora)'}.
                </Txt>
              </View>
            ) : (
              <Txt variant="small">Preencha o preço da graduada e o custo para eu fazer a conta.</Txt>
            )}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Txt variant="small">{label}</Txt>
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholder="R$ 0,00"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.backgroundElement }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  mini: { width: 44, height: 61, borderRadius: 5 },
  shot: { width: 120, height: 168, borderRadius: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 17, fontWeight: '800' },
  verdict: { borderWidth: 2, borderRadius: 14, padding: 12, gap: 4 },
});
