// Scanner por imagem: só o retângulo da câmera (contorno da carta ao vivo) e, logo abaixo, a carta
// reconhecida — imagem, nome e coleção bem grandes para conferir de primeira.
// Modo (adicionar/consultar) e versão ficam em Ajustes.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, AppState, Modal, Pressable, ScrollView, StyleSheet, View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardScannerView, recognizeImageAsync, type CardEvent, type TrackState } from '../../modules/card-vision';
import { Button, Chip, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { catalogByIds, ensureCatalog, setsWithAbbr, type SetMeta } from '@/lib/catalog';
import { VARIANT_LABEL, addToCollection, defaultVariant, ensureCard, getItem, setQuantity, type Variant } from '@/lib/collection';
import { brl } from '@/lib/format';
import { familyKey } from '@/lib/pick';
import { quickPrice } from '@/lib/quickprice';
import { scanPrefs, useScanPrefs } from '@/lib/scanprefs';
import { useSettings } from '@/lib/settings';
import { imgUrl, setIdOf, tryCard } from '@/lib/tcgdex';
import { ensureVisionIndex, onVisionStatus, visionCard, visionStatus, type VisionStatus } from '@/lib/vision';

/** Energia básica comum acima disso é quase certamente a impressão errada (antiga/rara). */
const ENERGY_MAX = 15;

/** Carta como o scanner mostra. */
interface Info {
  id: string;
  name: string;
  setId: string;
  setName: string;
  label: string; // "POR 072/088"
  image: string | null;
  release: string;
  secret: boolean;
}
interface Row {
  key: string;
  itemId: number | null; // null = só consulta
  info: Info;
  variant: Variant;
  added: number;
  price: number | null | undefined; // undefined = buscando
  priceLabel?: string;
  alts: { info: Info; score: number }[];
  score: number;
}

let setsMap: Map<string, SetMeta> | null = null;

/** Dados das cartas: banco do reconhecimento → catálogo PT → API. */
async function infosFor(ids: string[]): Promise<Map<string, Info>> {
  const out = new Map<string, Info>();
  const sets = setsMap;
  const make = (id: string, name: string, setId: string, setName: string | undefined, local: string, official: number,
    image: string | null, release = ''): Info => {
    const s = sets?.get(setId);
    const tot = s?.cardCount?.official || official;
    const num = Number(local);
    return {
      id, name, setId, setName: s?.name ?? setName ?? setId.toUpperCase(), image,
      label: `${s?.abbr ?? setId.toUpperCase()} ${local}${tot ? `/${tot}` : ''}`,
      release, secret: !!tot && Number.isFinite(num) && num > tot,
    };
  };
  const missing: string[] = [];
  for (const id of ids) {
    const m = visionCard(id);
    if (m) out.set(id, make(id, m.name, m.set, m.setName, m.local, m.official, m.image || null, m.release));
    else missing.push(id);
  }
  if (missing.length) {
    for (const r of await catalogByIds(missing)) out.set(r.id, make(r.id, r.name, r.set_id, undefined, r.local_id, 0, r.image));
    await Promise.all(missing.filter((i) => !out.has(i)).slice(0, 3).map(async (id) => {
      const c = (await tryCard(id, 'pt')) ?? (await tryCard(id, 'en'));
      if (c) out.set(id, make(id, c.name, c.set?.id ?? setIdOf(id), c.set?.name, c.localId, c.set?.cardCount?.official ?? 0, c.image ?? null));
    }));
  }
  return out;
}

/** Impressão preferida de cada energia básica (aprendida quando a pessoa corrige o scanner). */
let energyPrefs: Record<string, string> = {};
AsyncStorage.getItem('energyPrefs').then((v) => {
  if (v) energyPrefs = JSON.parse(v);
}).catch(() => {});
function rememberEnergy(info: Info) {
  const fam = familyKey(info.name);
  if (!fam.startsWith('energy:')) return;
  energyPrefs = { ...energyPrefs, [fam]: info.id };
  AsyncStorage.setItem('energyPrefs', JSON.stringify(energyPrefs)).catch(() => {});
}
export const isBasicEnergy = (i: Info) => familyKey(i.name).startsWith('energy:') && !i.secret;

/**
 * Escolha final: a mais parecida. Se outras da MESMA carta (mesmo nome / mesma energia básica) ficarem
 * praticamente empatadas, prefere a impressão comum (não secreta/dourada) e a mais recente.
 * Energias básicas são quase idênticas entre coleções: a janela é maior e, se a pessoa já corrigiu
 * uma vez, usa a impressão que ela escolheu.
 */
function choose(ev: CardEvent, infos: Map<string, Info>): { pick: Info; score: number; alts: { info: Info; score: number }[] } | null {
  const top = infos.get(ev.id);
  if (!top) return null;
  const fam = familyKey(top.name);
  const energy = fam.startsWith('energy:');
  const learned = energy ? energyPrefs[fam] : undefined;
  const learnedHit = learned ? ev.matches.find((m) => m.id === learned && m.score >= ev.score - 0.12) : undefined;
  const tied = ev.matches
    .filter((m) => infos.has(m.id) && m.score >= ev.score - (energy ? 0.08 : 0.03) && familyKey(infos.get(m.id)!.name) === fam)
    .map((m) => ({ info: infos.get(m.id)!, score: m.score }));
  tied.sort((a, b) => Number(a.info.secret) - Number(b.info.secret) || b.info.release.localeCompare(a.info.release) || b.score - a.score);
  const pick = (learnedHit && infos.get(learnedHit.id)) || tied[0]?.info || top;
  const alts = ev.matches
    .filter((m) => m.id !== pick.id && infos.has(m.id) && m.score >= ev.score - 0.1)
    .map((m) => ({ info: infos.get(m.id)!, score: m.score }));
  return { pick, score: ev.score, alts };
}

export default function VisionScan({ onUseOcr }: { onUseOcr: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { refMode } = useSettings();
  const prefs = useScanPrefs();
  const [permission, requestPermission] = useCameraPermissions();
  const [appActive, setAppActive] = useState(true);
  const [vs, setVs] = useState<VisionStatus>(visionStatus());
  const [track, setTrack] = useState<TrackState>('searching');
  const [torch, setTorch] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [showList, setShowList] = useState(false);
  const [showAlts, setShowAlts] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const lastAccept = useRef({ id: '', at: 0 });
  const pop = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    const off = onVisionStatus(setVs);
    ensureVisionIndex();
    ensureCatalog().catch(() => {});
    setsWithAbbr().then((m) => (setsMap = m)).catch(() => {});
    return () => {
      sub.remove();
      off();
    };
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((x) => (x === msg ? null : x)), 2600);
  }, []);

  const loadPrice = useCallback((key: string, cardId: string, variant: Variant) => {
    quickPrice(cardId, variant, refMode, (price, priceLabel) =>
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, price, priceLabel: priceLabel ?? r.priceLabel } : r))));
  }, [refMode]);

  /** Mostra a carta e (no modo Adicionar) já salva na coleção. */
  const accept = useCallback(async (info: Info, score: number, alts: Row['alts'], replaceKey?: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    pop.setValue(0.92);
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 5 }).start();
    const tmpKey = `t-${info.id}-${Date.now()}`;
    const consulta = scanPrefs().mode === 'consulta';
    setRows((rs) => [{
      key: tmpKey, itemId: null, info, variant: 'normal' as Variant, added: consulta ? 0 : 1, price: undefined, alts, score,
    }, ...rs.filter((r) => r.key !== replaceKey)].slice(0, 80));
    if (consulta) {
      loadPrice(tmpKey, info.id, 'normal');
      return;
    }
    try {
      const full = await ensureCard(info.id);
      const pref = scanPrefs().variant;
      const variant: Variant = pref === 'auto' ? defaultVariant(full) : pref;
      const { itemId } = await addToCollection(info.id, { variant, condition: 'NM', quantity: 1 });
      const key = `item-${itemId}`;
      const existing = rowsRef.current.find((r) => r.key === key);
      setRows((rs) => {
        const base = rs.find((r) => r.key === tmpKey);
        if (!base) return rs;
        const without = rs.filter((r) => r.key !== tmpKey && r.key !== key);
        return [{ ...base, ...(existing ? { price: existing.price, priceLabel: existing.priceLabel } : {}), key, itemId, variant,
          added: (existing?.added ?? 0) + 1 }, ...without];
      });
      if (!existing) loadPrice(key, info.id, variant);
    } catch (e) {
      setRows((rs) => rs.filter((r) => r.key !== tmpKey));
      flash(`Não consegui salvar (${String((e as Error)?.message ?? e).slice(0, 50)}). Sem internet?`);
    }
  }, [flash, loadPrice, pop]);

  const handleMatch = useCallback(async (ev: CardEvent) => {
    const infos = await infosFor([ev.id, ...ev.matches.map((m) => m.id).filter((i) => i !== ev.id)]);
    const c = choose(ev, infos);
    if (!c) {
      flash('Reconheci a carta, mas preciso de internet para buscar os dados dela.');
      return;
    }
    // proteção extra contra a mesma carta duas vezes seguidas
    const now = Date.now();
    if (lastAccept.current.id === c.pick.id && now - lastAccept.current.at < 2000) return;
    lastAccept.current = { id: c.pick.id, at: now };
    await accept(c.pick, c.score, c.alts);
  }, [accept, flash]);

  const onCard = useCallback((e: { nativeEvent: CardEvent }) => {
    handleMatch(e.nativeEvent).catch(() => {});
  }, [handleMatch]);

  async function changeQty(r: Row, delta: number) {
    if (r.itemId === null) {
      if (delta < 0) setRows((rs) => rs.filter((x) => x.key !== r.key));
      return;
    }
    const cur = await getItem(r.itemId);
    const q = (cur?.quantity ?? 0) + delta;
    await setQuantity(r.itemId, q);
    setRows((rs) => rs
      .map((x) => (x.key === r.key ? { ...x, added: x.added + delta } : x))
      .filter((x) => x.itemId === null || x.added > 0));
    if (delta < 0) flash(q <= 0 ? `${r.info.name} removida da coleção` : `${r.info.name}: −1`);
  }

  /** Trocar pela carta certa (desfaz a atual e adiciona a escolhida). */
  async function switchTo(r: Row, alt: { info: Info; score: number }) {
    setShowAlts(false);
    rememberEnergy(alt.info);
    if (r.itemId !== null) {
      const cur = await getItem(r.itemId);
      await setQuantity(r.itemId, Math.max(0, (cur?.quantity ?? 1) - 1));
      if (r.added > 1) setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, added: x.added - 1 } : x)));
    }
    const others = [{ info: r.info, score: r.score }, ...r.alts.filter((a) => a.info.id !== alt.info.id)];
    lastAccept.current = { id: alt.info.id, at: Date.now() };
    await accept(alt.info, alt.score, others, r.itemId === null || r.added <= 1 ? r.key : undefined);
  }

  async function fromGallery() {
    if (galleryBusy) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    setGalleryBusy(true);
    try {
      const r = await recognizeImageAsync(res.assets[0].uri);
      if (r.id && (r.score ?? 0) >= vs.thresholds.min - 0.05) {
        lastAccept.current = { id: '', at: 0 };
        await handleMatch({ id: r.id, score: r.score ?? 0, guide: !!r.guide, matches: r.matches });
      } else {
        flash('Não reconheci uma carta nessa foto. Tente uma foto mais de frente.');
      }
    } catch (e) {
      flash(String((e as Error)?.message ?? e).slice(0, 80));
    } finally {
      setGalleryBusy(false);
    }
  }

  const last = rows[0];
  const total = rows.reduce((a, r) => a + (r.price ?? 0) * (r.itemId === null ? 1 : r.added), 0);
  const count = rows.reduce((a, r) => a + (r.itemId === null ? 1 : r.added), 0);
  const ready = vs.state === 'ready';
  const camOn = !!permission?.granted && focused && appActive && !!CardScannerView;
  const status = camError ?? toast ?? (
    vs.state === 'downloading' ? `Baixando o banco de cartas (só na 1ª vez)… ${Math.round((vs.progress ?? 0) * 100)}%`
      : vs.state === 'checking' || vs.state === 'loading' || vs.state === 'idle' ? 'Preparando o reconhecimento…'
        : null);

  if (!permission) return <View style={{ flex: 1, backgroundColor: t.background }} />;
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: t.background, paddingTop: insets.top }]}>
        <MaterialCommunityIcons name="cards-outline" size={64} color={t.accent} />
        <Txt variant="h2" style={{ textAlign: 'center' }}>Para ler a carta, preciso da câmera</Txt>
        <Txt variant="small" style={{ textAlign: 'center' }}>
          Aponte para a carta e ela é reconhecida sozinha pela imagem. Nada é enviado para a internet.
        </Txt>
        <Button title="Permitir câmera" icon="camera" onPress={requestPermission} />
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      {/* Retângulo do scanner */}
      <View style={[styles.camera, { borderColor: track === 'recognized' ? t.up : t.border }]}>
        {camOn && CardScannerView ? (
          <CardScannerView
            style={StyleSheet.absoluteFill}
            active
            paused={!ready || showList || showAlts}
            torch={torch}
            minScore={vs.thresholds.min}
            strongScore={vs.thresholds.strong}
            onCard={onCard}
            onTrack={(e) => setTrack(e.nativeEvent.state)}
            onCameraReady={() => setCamError(null)}
            onCameraError={(e) => setCamError(e.nativeEvent.message)}
          />
        ) : null}
        <Pressable onPress={() => setTorch((v) => !v)} style={[styles.icon, { right: 10, backgroundColor: torch ? t.highlight : 'rgba(0,0,0,0.45)' }]}>
          <MaterialCommunityIcons name={torch ? 'flashlight' : 'flashlight-off'} size={20} color={torch ? t.highlightText : '#fff'} />
        </Pressable>
        <Pressable onPress={fromGallery} style={[styles.icon, { left: 10, backgroundColor: 'rgba(0,0,0,0.45)' }]}>
          {galleryBusy ? <ActivityIndicator color="#fff" size="small" /> : <MaterialCommunityIcons name="image-outline" size={20} color="#fff" />}
        </Pressable>
        {status ? (
          <View style={styles.status} pointerEvents="none">
            {vs.state === 'downloading' || vs.state === 'checking' || vs.state === 'loading'
              ? <ActivityIndicator size="small" color="#fff" /> : null}
            <Txt variant="small" color="#fff" style={{ fontWeight: '700', textAlign: 'center', flexShrink: 1 }}>{status}</Txt>
          </View>
        ) : null}
      </View>

      {/* Resultado */}
      <View style={styles.resultWrap}>
        {vs.state === 'error' ? (
          <View style={[styles.result, { backgroundColor: t.card, borderColor: t.border, flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}>
            <Txt style={{ fontWeight: '800' }}>Não consegui preparar o reconhecimento</Txt>
            <Txt variant="small">{vs.error}</Txt>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Button title="Tentar de novo" icon="refresh" onPress={() => ensureVisionIndex(true)} />
              <Button title="Ler pelo texto" kind="secondary" onPress={onUseOcr} />
            </View>
          </View>
        ) : last ? (
          <Animated.View style={{ transform: [{ scale: pop }] }}>
            <Pressable
              onPress={() => router.push({ pathname: '/card/[id]', params: { id: last.info.id } })}
              style={[styles.result, { backgroundColor: t.card, borderColor: t.border }]}>
              {last.info.image ? (
                <Image source={{ uri: imgUrl(last.info.image) }} style={styles.art} contentFit="contain" transition={120} />
              ) : <View style={[styles.art, { backgroundColor: t.backgroundElement }]} />}
              <View style={{ flex: 1, gap: 3 }}>
                <Txt numberOfLines={2} style={{ fontWeight: '900', fontSize: 21, lineHeight: 25 }}>{last.info.name}</Txt>
                <Txt numberOfLines={2} style={{ fontWeight: '700', fontSize: 16, color: t.highlight }}>{last.info.setName}</Txt>
                <Txt variant="small">
                  {last.info.label}{last.itemId !== null ? ` · ${VARIANT_LABEL[last.variant]}` : ''}
                </Txt>
                <Txt style={{ fontWeight: '900', fontSize: 20, color: t.up, marginTop: 2 }}>
                  {last.price === undefined ? '…' : last.price === null ? 'sem preço' : brl(last.price)}
                  {last.price != null && last.price > ENERGY_MAX && isBasicEnergy(last.info)
                    ? <Txt variant="small" style={{ color: t.highlight }}>  confira a coleção</Txt> : null}
                </Txt>
                {last.priceLabel && last.price != null ? <Txt variant="small" numberOfLines={1}>{last.priceLabel}</Txt> : null}
                <View style={styles.links}>
                  {last.itemId !== null ? (
                    <Pressable hitSlop={8} onPress={() => changeQty(last, -1)}>
                      <Txt variant="small" style={{ color: t.textSecondary, fontWeight: '700' }}>Desfazer</Txt>
                    </Pressable>
                  ) : last.key.startsWith('t-') && prefs.mode === 'auto' ? (
                    <Txt variant="small">Adicionando…</Txt>
                  ) : (
                    <Txt variant="small">Não adicionada (só consulta)</Txt>
                  )}
                  {last.alts.length ? (
                    <Pressable hitSlop={8} onPress={() => setShowAlts(true)}>
                      <Txt variant="small" style={{ color: t.textSecondary, fontWeight: '700' }}>Não é essa?</Txt>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </Pressable>
          </Animated.View>
        ) : (
          <View style={[styles.result, styles.empty, { borderColor: t.border }]}>
            <MaterialCommunityIcons name="cards-outline" size={30} color={t.muted} />
            <Txt variant="small" style={{ flex: 1 }}>Aponte a câmera para uma carta. Ela aparece aqui assim que for reconhecida.</Txt>
          </View>
        )}
        {rows.length ? (
          <Pressable onPress={() => setShowList(true)} hitSlop={6} style={styles.session}>
            <Txt variant="small">
              {count} {count === 1 ? 'carta' : 'cartas'} {prefs.mode === 'auto' ? 'adicionadas' : 'consultadas'} agora · {brl(total)}
            </Txt>
            <MaterialCommunityIcons name="chevron-right" size={16} color={t.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {/* Outras possibilidades (só se a pessoa pedir) */}
      <Modal visible={showAlts && !!last} animationType="slide" transparent onRequestClose={() => setShowAlts(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAlts(false)} />
        <View style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 12 }]}>
          <Txt variant="h2">Qual é a carta certa?</Txt>
          <ScrollView contentContainerStyle={{ gap: 8 }}>
            {last?.alts.map((a) => (
              <Pressable key={a.info.id} onPress={() => switchTo(last, a)} style={[styles.altRow, { borderColor: t.border }]}>
                {a.info.image ? <Image source={{ uri: imgUrl(a.info.image) }} style={styles.thumb} contentFit="contain" /> : null}
                <View style={{ flex: 1 }}>
                  <Txt style={{ fontWeight: '800' }} numberOfLines={1}>{a.info.name}</Txt>
                  <Txt variant="small" style={{ color: t.highlight }} numberOfLines={1}>{a.info.setName}</Txt>
                  <Txt variant="small">{a.info.label}</Txt>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <Button title="Era essa mesmo" kind="secondary" onPress={() => setShowAlts(false)} />
        </View>
      </Modal>

      {/* Lista desta sessão */}
      <Modal visible={showList} animationType="slide" transparent onRequestClose={() => setShowList(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowList(false)} />
        <View style={[styles.sheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.listHead}>
            <Txt variant="h2">{prefs.mode === 'auto' ? 'Adicionadas agora' : 'Consultadas agora'}</Txt>
            <Txt style={{ fontWeight: '800', color: t.highlight }}>{brl(total)}</Txt>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
            {rows.map((r) => (
              <View key={r.key} style={[styles.listRow, { borderColor: t.border }]}>
                <Pressable
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  onPress={() => {
                    setShowList(false);
                    router.push({ pathname: '/card/[id]', params: { id: r.info.id } });
                  }}>
                  {r.info.image ? <Image source={{ uri: imgUrl(r.info.image) }} style={styles.thumb} contentFit="contain" /> : null}
                  <View style={{ flex: 1 }}>
                    <Txt numberOfLines={1} style={{ fontWeight: '700' }}>{r.info.name}</Txt>
                    <Txt variant="small" numberOfLines={1}>{r.info.setName} · {r.info.label}</Txt>
                    <Txt variant="small" style={{ color: t.text, fontWeight: '800' }}>
                      {r.price === undefined ? 'buscando preço…' : r.price === null ? 'sem preço' : brl(r.price)}
                    </Txt>
                  </View>
                </Pressable>
                {r.itemId !== null ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Chip label="−" onPress={() => changeQty(r, -1)} />
                    <Txt style={{ minWidth: 20, textAlign: 'center', fontWeight: '700' }}>{r.added}</Txt>
                    <Chip label="+" onPress={() => changeQty(r, +1)} />
                  </View>
                ) : (
                  <Chip label="✕" onPress={() => changeQty(r, -1)} />
                )}
              </View>
            ))}
          </ScrollView>
          <Button title="Continuar escaneando" icon="camera" onPress={() => setShowList(false)} />
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 },
  camera: {
    flex: 1, marginHorizontal: 16, marginTop: 10, borderRadius: 24, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 2,
  },
  icon: { position: 'absolute', top: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  status: {
    position: 'absolute', left: 12, right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12,
  },
  resultWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 6 },
  result: {
    flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    padding: 12, minHeight: 150,
  },
  empty: { borderStyle: 'dashed', borderWidth: 1.5 },
  art: { width: 96, height: 134, borderRadius: 6 },
  links: { flexDirection: 'row', gap: 18, marginTop: 4 },
  session: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { maxHeight: '75%', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, gap: 10 },
  altRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 8 },
  thumb: { width: 40, height: 56, borderRadius: 4 },
  listHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
});
