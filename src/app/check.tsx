// Conferir preço: a pessoa anexa um print/foto de um anúncio (carta, carta graduada ou lacrado),
// o app reconhece o item, lê o preço pedido e a nota do slab, e diz se o preço está dentro do esperado.
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Asset } from 'expo-asset';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { analyzeImageAsync, type AnalyzeResult } from '../../modules/card-vision';
import { Button, Chip, Txt } from '@/components/ui';
import { choose, infosFor, prepInfos, type Info } from '@/components/vision-scan';
import { useTheme } from '@/hooks/use-theme';
import { addToCollection, defaultVariant, ensureCard } from '@/lib/collection';
import { brl } from '@/lib/format';
import { parseAskPrice, parseGrading, parseTypedPrice, verdict, type Grader } from '@/lib/grading';
import { quickPrice } from '@/lib/quickprice';
import { LANG_LABEL, addSealed, ensureSealedIndex, sealedBRL, sealedProduct, type SealedLang, type SealedProduct } from '@/lib/sealed';
import { useSettings } from '@/lib/settings';
import { getFx } from '@/lib/sources/fast';
import { imgUrl } from '@/lib/tcgdex';
import { ensureVisionIndex } from '@/lib/vision';

type Kind = 'card' | 'sealed';
const GRADERS: Grader[] = ['PSA', 'CGC', 'BGS'];
const GRADES = [10, 9.5, 9, 8, 7];

interface CardRes { pick: Info; alts: Info[] }
interface SealedRes { pick: SealedProduct; alts: SealedProduct[]; lang: SealedLang }

export default function CheckPrice() {
  const t = useTheme();
  const { refMode } = useSettings();
  const params = useLocalSearchParams<{ uri?: string; sample?: string }>();
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [card, setCard] = useState<CardRes | null>(null);
  const [sealed, setSealed] = useState<SealedRes | null>(null);
  const [company, setCompany] = useState<Grader | 'Graduada' | null>(null);
  const [grade, setGrade] = useState<number>(10);
  const [ref, setRef] = useState<{ value: number | null; label?: string } | undefined>(undefined);
  const [asked, setAsked] = useState('');
  const [askedFrom, setAskedFrom] = useState<'BRL' | 'USD' | null>(null);
  const [fx, setFx] = useState<number | null>(null);
  const [showAlts, setShowAlts] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    getFx().then((f) => setFx(f?.USD ?? null)).catch(() => {});
    ensureVisionIndex();
    ensureSealedIndex();
    prepInfos();
  }, []);

  const analyze = useCallback(async (u: string) => {
    setUri(u);
    setError(null);
    setCard(null);
    setSealed(null);
    setKind(null);
    setRef(undefined);
    setAdded(null);
    setShowAlts(false);
    setBusy('Preparando o reconhecimento…');
    try {
      const [vs, ss] = await Promise.all([ensureVisionIndex(), ensureSealedIndex().catch(() => null), prepInfos()]);
      if (vs.state !== 'ready' && ss?.state !== 'ready') throw new Error(vs.error ?? 'Sem internet para baixar o reconhecimento.');
      setBusy('Analisando a imagem…');
      const r: AnalyzeResult = await analyzeImageAsync(u, vs.thresholds.strong, ss?.thresholds.strong ?? 0.7);
      const fxNow = fx ?? (await getFx().catch(() => null))?.USD ?? null;
      // carta ou lacrado: o que passar mais folgado do próprio limiar
      const cm = r.card ? r.card.score - vs.thresholds.min : -1;
      const sm = r.sealed && ss ? r.sealed.score - ss.thresholds.min : -1;
      let c: CardRes | null = null;
      let s: SealedRes | null = null;
      if (r.card && cm > -0.05) {
        const ids = [r.card.id, ...r.card.matches.map((m) => m.id).filter((i) => i !== r.card!.id)];
        const infos = await infosFor(ids);
        const ch = choose({ id: r.card.id, score: r.card.score, matches: r.card.matches }, infos);
        if (ch) c = { pick: ch.pick, alts: ch.alts.map((a) => a.info).slice(0, 6) };
      }
      if (r.sealed && sm > -0.05) {
        const p = sealedProduct(r.sealed.id);
        if (p) {
          const alts = r.sealed.matches.filter((m) => m.id !== p.id && m.score >= r.sealed!.score - 0.12)
            .map((m) => sealedProduct(m.id)).filter((x): x is SealedProduct => !!x).slice(0, 6);
          s = { pick: p, alts, lang: p.lang === 'JP' ? 'JP' : r.sealed.lang === 'EN' ? 'EN' : 'PT' };
        }
      }
      setCard(c);
      setSealed(s);
      const k: Kind | null = c && (!s || cm >= sm) ? 'card' : s ? 'sealed' : null;
      setKind(k);
      if (!k) setError('Não reconheci carta nem produto nessa imagem. Tente um print em que o item apareça grande e de frente.');
      // nota do slab: primeiro a etiqueta acima da carta, depois o texto todo (título do anúncio)
      const g = parseGrading(r.card?.label) ?? parseGrading(r.text);
      setCompany(g ? g.company ?? 'Graduada' : null);
      setGrade(g?.grade ?? 10);
      const a = parseAskPrice(r.text, fxNow);
      setAsked(a ? a.value.toFixed(2).replace('.', ',') : '');
      setAskedFrom(a?.from ?? null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).slice(0, 140));
    } finally {
      setBusy(null);
    }
  }, [fx]);

  useEffect(() => {
    if (params.uri) analyze(params.uri);
    else if (params.sample) {
      // exemplo embutido (teste automático no emulador)
      const a = Asset.fromModule(require('../../assets/test/check-sample.jpg'));
      a.downloadAsync().then(() => analyze(a.localUri ?? a.uri)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.uri, params.sample]);

  // preço de referência do item escolhido
  useEffect(() => {
    let alive = true;
    setRef(undefined);
    if (kind === 'card' && card) {
      quickPrice(card.pick.id, 'normal', refMode, (value, label) => {
        if (alive) setRef({ value, label });
      });
    } else if (kind === 'sealed' && sealed) {
      setRef({ value: sealedBRL(sealed.pick.usd, fx), label: 'mercado nos EUA (TCGplayer), convertido' });
    }
    return () => {
      alive = false;
    };
  }, [kind, card, sealed, fx, refMode]);

  async function pick(camera: boolean) {
    const res = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    analyze(res.assets[0].uri);
  }

  const gradeLabel = company ? `${company} ${String(grade).replace('.', ',')}` : null;
  const askedN = parseTypedPrice(asked);
  const v = askedN !== null && ref?.value ? verdict(askedN, ref.value) : null;
  const graded = kind === 'card' && !!gradeLabel;
  const vColor = !v ? t.text : v.level === 'barato' ? t.up : v.level === 'justo' ? t.text : v.level === 'caro' ? t.highlight : t.down;

  async function addIt() {
    try {
      if (kind === 'card' && card) {
        const full = await ensureCard(card.pick.id);
        await addToCollection(card.pick.id, { variant: defaultVariant(full), condition: gradeLabel ?? 'NM', quantity: 1 });
        setAdded(`${card.pick.name}${gradeLabel ? ` (${gradeLabel})` : ''} adicionada à coleção`);
      } else if (kind === 'sealed' && sealed) {
        await addSealed(sealed.pick, sealed.lang);
        setAdded(`${sealed.pick.name} adicionado aos lacrados`);
      }
    } catch (e) {
      setAdded(`Não consegui adicionar: ${String((e as Error)?.message ?? e).slice(0, 60)}`);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.background }} behavior="padding">
      <Stack.Screen options={{ title: 'Conferir preço' }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        {!uri ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, alignItems: 'center', gap: 10 }]}>
            <MaterialCommunityIcons name="tag-search-outline" size={44} color={t.highlight} />
            <Txt style={{ fontWeight: '800', fontSize: 18, textAlign: 'center' }}>Viu um anúncio? Confira se o preço está ok</Txt>
            <Txt variant="small" style={{ textAlign: 'center' }}>
              Mande um print ou foto da carta, da carta graduada (PSA, CGC, BGS) ou do lacrado (ETB, booster, box…).
              Eu reconheço o item, leio o preço do anúncio e comparo com o mercado.
            </Txt>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Image source={{ uri }} style={[styles.thumb, { backgroundColor: t.backgroundElement }]} contentFit="cover" />
            <View style={{ flex: 1 }}>
              {busy ? (
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <ActivityIndicator color={t.accent} />
                  <Txt variant="small">{busy}</Txt>
                </View>
              ) : error ? <Txt variant="small" style={{ color: t.down }}>{error}</Txt> : <Txt variant="small">Imagem analisada</Txt>}
            </View>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title={uri ? 'Outra imagem' : 'Escolher print/foto'} icon="image-outline" onPress={() => pick(false)} style={{ flex: 1 }} />
          <Button title="Câmera" icon="camera-outline" kind="secondary" onPress={() => pick(true)} />
        </View>

        {card && sealed && !busy ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="É uma carta" active={kind === 'card'} onPress={() => setKind('card')} />
            <Chip label="É um lacrado" active={kind === 'sealed'} onPress={() => setKind('sealed')} />
          </View>
        ) : null}

        {kind === 'card' && card && !busy ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 12 }]}>
            <Pressable style={{ flexDirection: 'row', gap: 12 }} onPress={() => router.push({ pathname: '/card/[id]', params: { id: card.pick.id } })}>
              {card.pick.image ? <Image source={{ uri: imgUrl(card.pick.image) }} style={styles.art} contentFit="contain" />
                : <View style={[styles.art, { backgroundColor: t.backgroundElement }]} />}
              <View style={{ flex: 1, gap: 3 }}>
                <Txt style={{ fontWeight: '900', fontSize: 20 }} numberOfLines={2}>{card.pick.name}</Txt>
                <Txt style={{ fontWeight: '700', color: t.highlight }} numberOfLines={2}>{card.pick.setName}</Txt>
                <Txt variant="small">{card.pick.label}{gradeLabel ? ` · ${gradeLabel}` : ''}</Txt>
                {card.alts.length ? (
                  <Pressable hitSlop={8} onPress={() => setShowAlts((x) => !x)}>
                    <Txt variant="small" style={{ fontWeight: '700', color: t.textSecondary }}>Não é essa?</Txt>
                  </Pressable>
                ) : null}
              </View>
            </Pressable>
            {showAlts ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {card.alts.map((a) => (
                  <Chip key={a.id} label={`${a.name} · ${a.label}`} onPress={() => {
                    setCard({ pick: a, alts: [card.pick, ...card.alts.filter((x) => x.id !== a.id)] });
                    setShowAlts(false);
                  }} />
                ))}
              </View>
            ) : null}
            <View style={{ gap: 6 }}>
              <Txt variant="small" style={{ fontWeight: '700' }}>Carta graduada?</Txt>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Chip label="Não (crua)" active={!company} onPress={() => setCompany(null)} />
                {GRADERS.map((g) => <Chip key={g} label={g} active={company === g} onPress={() => setCompany(g)} />)}
                {company === 'Graduada' || (company && !GRADERS.includes(company as Grader))
                  ? <Chip label={company} active onPress={() => {}} /> : null}
              </View>
              {company ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[...new Set([...GRADES, grade])].sort((a, b) => b - a).map((g) => (
                    <Chip key={g} label={`Nota ${String(g).replace('.', ',')}`} active={grade === g} onPress={() => setGrade(g)} />
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {kind === 'sealed' && sealed && !busy ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 12 }]}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {sealed.pick.image ? <Image source={{ uri: sealed.pick.image }} style={styles.art} contentFit="contain" />
                : <View style={[styles.art, { backgroundColor: t.backgroundElement }]} />}
              <View style={{ flex: 1, gap: 3 }}>
                <Txt style={{ fontWeight: '900', fontSize: 19 }} numberOfLines={3}>{sealed.pick.name}</Txt>
                <Txt style={{ fontWeight: '700', color: t.highlight }}>{sealed.pick.type}</Txt>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {(sealed.pick.lang === 'JP' ? ['JP'] : ['PT', 'EN']).map((l) => (
                    <Chip key={l} label={LANG_LABEL[l as SealedLang]} active={sealed.lang === l}
                      onPress={() => setSealed({ ...sealed, lang: l as SealedLang })} />
                  ))}
                </View>
                {sealed.alts.length ? (
                  <Pressable hitSlop={8} onPress={() => setShowAlts((x) => !x)}>
                    <Txt variant="small" style={{ fontWeight: '700', color: t.textSecondary }}>Não é esse?</Txt>
                  </Pressable>
                ) : null}
              </View>
            </View>
            {showAlts ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {sealed.alts.map((a) => (
                  <Chip key={a.id} label={a.name} onPress={() => {
                    setSealed({ ...sealed, pick: a, alts: [sealed.pick, ...sealed.alts.filter((x) => x.id !== a.id)] });
                    setShowAlts(false);
                  }} />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {kind && !busy ? (
          <View style={[styles.box, { backgroundColor: t.card, borderColor: t.border, gap: 10 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Txt variant="small">{graded ? 'Carta crua vale' : 'Preço de mercado'}</Txt>
                <Txt style={{ fontWeight: '900', fontSize: 24, color: t.up }}>
                  {ref === undefined ? '…' : ref.value === null ? 'sem preço' : `${kind === 'sealed' ? '≈ ' : ''}${brl(ref.value)}`}
                </Txt>
                {ref?.label && ref.value !== null ? <Txt variant="small" numberOfLines={2}>{ref.label}</Txt> : null}
              </View>
              <View style={{ width: 150 }}>
                <Txt variant="small">Preço do anúncio</Txt>
                <TextInput
                  value={asked}
                  onChangeText={(x) => {
                    setAsked(x);
                    setAskedFrom(null);
                  }}
                  keyboardType="decimal-pad"
                  placeholder="R$ 0,00"
                  placeholderTextColor={t.muted}
                  style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.backgroundElement }]}
                />
              </View>
            </View>
            {askedFrom ? (
              <Txt variant="small">{askedFrom === 'USD' ? 'Preço lido no print (em dólar, convertido)' : 'Preço lido no print — confira'}</Txt>
            ) : null}
            {v ? (
              <View style={[styles.verdict, { borderColor: vColor }]}>
                <Txt style={{ fontWeight: '900', fontSize: 18, color: vColor }}>
                  {graded
                    ? `${Math.abs(Math.round(v.diff * 100))}% ${v.diff >= 0 ? 'acima' : 'abaixo'} do valor da carta crua`
                    : v.title}
                </Txt>
                {graded ? (
                  <Txt variant="small">
                    {v.diff < 0
                      ? `Uma ${gradeLabel} por menos que a carta crua é raro: confira se o slab é verdadeiro e o número do certificado.`
                      : `Carta graduada costuma valer mais que a crua, e a diferença depende muito da nota (uma 10 pode valer várias vezes a 9). Ainda não tenho preço de graduada; use a carta crua como piso.`}
                  </Txt>
                ) : v.level === 'barato' ? (
                  <Txt variant="small">Bom preço — se for muito abaixo, confira se o item é original e o estado.</Txt>
                ) : null}
              </View>
            ) : askedN === null ? (
              <Txt variant="small">Digite o preço do anúncio para comparar.</Txt>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <Button title={kind === 'card' ? 'Adicionar à coleção' : 'Adicionar aos lacrados'} icon="plus" kind="secondary" onPress={addIt} />
            </View>
            {added ? <Txt variant="small" style={{ color: t.up }}>{added}</Txt> : null}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  thumb: { width: 64, height: 88, borderRadius: 10 },
  art: { width: 110, height: 153, borderRadius: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 18, fontWeight: '800' },
  verdict: { borderWidth: 2, borderRadius: 14, padding: 12, gap: 4 },
});
