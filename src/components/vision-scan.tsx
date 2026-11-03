// Scanner por imagem (estilo Deck Certo): câmera em tela cheia, contorno da carta ao vivo
// (amarelo procurando → verde reconhecida), reconhecimento pela arte em menos de 1 s,
// adiciona sozinho à coleção e segue para a próxima ("fila").
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, AppState, LayoutAnimation, Modal, Platform, Pressable, ScrollView, StyleSheet,
  UIManager, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardScannerView, recognizeImageAsync, type CardEvent, type TrackState } from '../../modules/card-vision';
import { Button, Chip, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { catalogByIds, ensureCatalog, normName, setsWithAbbr, type CatalogRow, type SetMeta } from '@/lib/catalog';
import { VARIANT_LABEL, addToCollection, defaultVariant, ensureCard, getItem, setQuantity, type Variant } from '@/lib/collection';
import { brl } from '@/lib/format';
import { quickPrice } from '@/lib/quickprice';
import { useSettings } from '@/lib/settings';
import { setIdOf, tryCard } from '@/lib/tcgdex';
import { ensureVisionIndex, onVisionStatus, visionStatus, type VisionStatus } from '@/lib/vision';

if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);

type Mode = 'auto' | 'consulta';
type VariantPref = 'auto' | 'normal' | 'holo' | 'reverse';
const VARIANT_PREFS: VariantPref[] = ['auto', 'normal', 'holo', 'reverse'];
const PREF_LABEL: Record<VariantPref, string> = { auto: 'Versão auto', normal: 'Normal', holo: 'Holo', reverse: 'Reverse' };

interface Row {
  key: string;
  itemId: number | null; // null = só consulta
  cardId: string;
  name: string;
  label: string;
  image?: string | null;
  variant: Variant;
  added: number;
  price: number | null | undefined; // undefined = buscando
  priceLabel?: string;
  score: number;
  alts: Alt[];
}
interface Alt {
  row: CatalogRow;
  score: number;
  label: string;
}

/** Dados das cartas pelo id: catálogo local (PT); as que não estão nele vêm da API (PT ou inglês). */
async function rowsFor(ids: string[]): Promise<Map<string, CatalogRow>> {
  const by = new Map((await catalogByIds(ids)).map((c) => [c.id, c] as const));
  const missing = ids.filter((i) => !by.has(i)).slice(0, 4);
  await Promise.all(missing.map(async (id) => {
    const c = (await tryCard(id, 'pt')) ?? (await tryCard(id, 'en'));
    if (c) by.set(id, { id, set_id: c.set?.id ?? setIdOf(id), local_id: c.localId, name: c.name, image: c.image ?? null });
  }));
  return by;
}

function labelOf(r: CatalogRow, sets: Map<string, SetMeta> | null) {
  const s = sets?.get(r.set_id);
  const abbr = s?.abbr ?? r.set_id.toUpperCase();
  const tot = s?.cardCount?.official || s?.cardCount?.total;
  return `${abbr} ${r.local_id}${tot ? `/${tot}` : ''}`;
}

export default function VisionScan({ onUseOcr }: { onUseOcr: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { refMode } = useSettings();
  const [permission, requestPermission] = useCameraPermissions();
  const [appActive, setAppActive] = useState(true);
  const [vs, setVs] = useState<VisionStatus>(visionStatus());
  const [track, setTrack] = useState<TrackState>('searching');
  const [mode, setModeState] = useState<Mode>('auto');
  const [pref, setPrefState] = useState<VariantPref>('auto');
  const [zoom, setZoom] = useState(1);
  const [torch, setTorch] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [showList, setShowList] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const sets = useRef<Map<string, SetMeta> | null>(null);
  const modeRef = useRef<Mode>('auto');
  const prefRef = useRef<VariantPref>('auto');
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;
  const pop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    AsyncStorage.multiGet(['scanMode', 'scanVariant']).then((kv) => {
      const m = kv[0][1];
      const v = kv[1][1];
      if (m === 'auto' || m === 'consulta') {
        setModeState(m);
        modeRef.current = m;
      }
      if (v && (VARIANT_PREFS as string[]).includes(v)) {
        setPrefState(v as VariantPref);
        prefRef.current = v as VariantPref;
      }
    });
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    const off = onVisionStatus(setVs);
    ensureVisionIndex();
    ensureCatalog().catch(() => {});
    setsWithAbbr().then((m) => (sets.current = m)).catch(() => {});
    return () => {
      sub.remove();
      off();
    };
  }, []);

  function setMode(m: Mode) {
    setModeState(m);
    modeRef.current = m;
    AsyncStorage.setItem('scanMode', m).catch(() => {});
  }
  function cyclePref() {
    const next = VARIANT_PREFS[(VARIANT_PREFS.indexOf(prefRef.current) + 1) % VARIANT_PREFS.length];
    setPrefState(next);
    prefRef.current = next;
    AsyncStorage.setItem('scanVariant', next).catch(() => {});
  }

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((x) => (x === msg ? null : x)), 2600);
  }, []);

  const loadPrice = useCallback((key: string, cardId: string, variant: Variant) => {
    quickPrice(cardId, variant, refMode, (price, priceLabel) =>
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, price, priceLabel: priceLabel ?? r.priceLabel } : r))));
  }, [refMode]);

  /** Coloca a carta na fila (e na coleção, no modo Adicionar). */
  const accept = useCallback(async (card: CatalogRow, score: number, alts: Alt[], replaceKey?: string) => {
    const label = labelOf(card, sets.current);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

    if (modeRef.current === 'consulta') {
      const key = `q-${card.id}-${Date.now()}`;
      setRows((rs) => [{
        key, itemId: null, cardId: card.id, name: card.name, label, image: card.image, variant: 'normal' as Variant,
        added: 0, price: undefined, score, alts,
      }, ...rs.filter((r) => r.key !== replaceKey)].slice(0, 40));
      loadPrice(key, card.id, 'normal');
      return;
    }
    // Mostra na hora com os dados do catálogo; grava na coleção em seguida
    const tmpKey = `t-${card.id}-${Date.now()}`;
    setRows((rs) => [{
      key: tmpKey, itemId: null, cardId: card.id, name: card.name, label, image: card.image, variant: 'normal' as Variant,
      added: 1, price: undefined, score, alts,
    }, ...rs.filter((r) => r.key !== replaceKey)]);
    try {
      const full = await ensureCard(card.id);
      const variant: Variant = prefRef.current === 'auto' ? defaultVariant(full) : prefRef.current;
      const { itemId } = await addToCollection(card.id, { variant, condition: 'NM', quantity: 1 });
      const key = `item-${itemId}`;
      const existing = rowsRef.current.find((r) => r.key === key);
      setRows((rs) => {
        const without = rs.filter((r) => r.key !== tmpKey && r.key !== key);
        const base = existing ?? rs.find((r) => r.key === tmpKey)!;
        return [{ ...base, key, itemId, variant, added: (existing?.added ?? 0) + 1, score, alts, label }, ...without];
      });
      if (!existing) loadPrice(key, card.id, variant);
    } catch (e) {
      setRows((rs) => rs.filter((r) => r.key !== tmpKey));
      flash(`Não consegui salvar (${String((e as Error)?.message ?? e).slice(0, 50)}). Sem internet?`);
    }
  }, [flash, loadPrice, pop]);

  const handleMatch = useCallback(async (ev: CardEvent) => {
    const byId = await rowsFor([ev.id, ...ev.matches.map((m) => m.id).filter((i) => i !== ev.id)]);
    const top = byId.get(ev.id);
    if (!top) {
      flash('Reconheci a carta, mas preciso de internet para buscar os dados dela.');
      return;
    }
    // Outras versões possíveis: mesma arte em outra coleção, ou quase empatadas
    const alts: Alt[] = ev.matches
      .filter((m) => m.id !== ev.id && byId.has(m.id))
      .filter((m) => m.score >= ev.score - 0.06 || normName(byId.get(m.id)!.name) === normName(top.name))
      .slice(0, 5)
      .map((m) => ({ row: byId.get(m.id)!, score: m.score, label: labelOf(byId.get(m.id)!, sets.current) }));
    await accept(top, ev.score, alts);
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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRows((rs) => rs
      .map((x) => (x.key === r.key ? { ...x, added: x.added + delta } : x))
      .filter((x) => x.itemId === null || x.added > 0));
    if (delta < 0) flash(q <= 0 ? `${r.name} removida da coleção` : `${r.name}: −1`);
  }

  /** Trocar pela outra versão sugerida (desfaz a atual e adiciona a escolhida). */
  async function switchTo(r: Row, alt: Alt) {
    if (r.itemId !== null) {
      const cur = await getItem(r.itemId);
      await setQuantity(r.itemId, Math.max(0, (cur?.quantity ?? 1) - 1));
      if (r.added > 1) setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, added: x.added - 1 } : x)));
    }
    const others: Alt[] = [{ row: { id: r.cardId, set_id: '', local_id: '', name: r.name, image: r.image ?? null }, score: r.score, label: r.label },
      ...r.alts.filter((a) => a.row.id !== alt.row.id)];
    await accept(alt.row, alt.score, others, r.added > 1 ? undefined : r.key);
  }

  async function fromGallery() {
    if (galleryBusy) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    setGalleryBusy(true);
    try {
      const r = await recognizeImageAsync(res.assets[0].uri);
      if (r.id && (r.score ?? 0) >= vs.thresholds.min - 0.05) {
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

  const hint = !ready
    ? vs.state === 'downloading'
      ? `Baixando o banco de cartas (só na 1ª vez)… ${Math.round((vs.progress ?? 0) * 100)}%`
      : vs.state === 'error'
        ? vs.error ?? 'Não consegui preparar o reconhecimento'
        : 'Preparando o reconhecimento…'
    : track === 'recognized'
      ? 'Na fila! Afaste e aponte para a próxima'
      : track === 'tracking'
        ? 'Segure firme…'
        : 'Aponte a câmera para a carta';

  if (!permission) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: t.background, paddingTop: insets.top }]}>
        <MaterialCommunityIcons name="cards-outline" size={64} color={t.accent} />
        <Txt variant="h2" style={{ textAlign: 'center' }}>Para ler a carta, preciso da câmera</Txt>
        <Txt variant="small" style={{ textAlign: 'center' }}>
          Aponte para a carta e ela é reconhecida sozinha pela imagem. Nada é enviado para a internet.
        </Txt>
        <Button title="Permitir câmera" icon="camera" onPress={requestPermission} />
        <Button title="Buscar uma foto da galeria" kind="secondary" icon="image-outline" onPress={fromGallery} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {camOn && CardScannerView ? (
        <CardScannerView
          style={StyleSheet.absoluteFill}
          active
          paused={!ready || showList}
          zoom={zoom}
          torch={torch}
          minScore={vs.thresholds.min}
          strongScore={vs.thresholds.strong}
          onCard={onCard}
          onTrack={(e) => setTrack(e.nativeEvent.state)}
          onCameraReady={() => setCamError(null)}
          onCameraError={(e) => setCamError(e.nativeEvent.message)}
        />
      ) : null}

      {/* Topo: modo + lanterna + galeria */}
      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.rowGap}>
          <Chip label="Adicionar" active={mode === 'auto'} onPress={() => setMode('auto')} />
          <Chip label="Só consultar" active={mode === 'consulta'} onPress={() => setMode('consulta')} />
        </View>
        <View style={styles.rowGap}>
          <RoundBtn icon={torch ? 'flashlight' : 'flashlight-off'} on={torch} onPress={() => setTorch((v) => !v)} />
          <RoundBtn icon="image-outline" busy={galleryBusy} onPress={fromGallery} />
        </View>
      </View>

      <View style={[styles.hint, { top: insets.top + 60 }]} pointerEvents="none">
        <View style={[styles.hintPill, track === 'recognized' && ready && { backgroundColor: 'rgba(22,163,74,0.9)' }]}>
          {vs.state === 'downloading' || vs.state === 'checking' || vs.state === 'loading'
            ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Txt variant="small" color="#fff" style={{ fontWeight: '700', textAlign: 'center' }}>{camError ?? toast ?? hint}</Txt>
        </View>
      </View>

      {/* Base: zoom, versão, última carta e fila */}
      <View style={[styles.bottom, { paddingBottom: 12 }]} pointerEvents="box-none">
        {vs.state === 'error' ? (
          <View style={[styles.sheet, { backgroundColor: t.card, borderColor: t.border, gap: 8 }]}>
            <Txt style={{ fontWeight: '700' }}>Reconhecimento por imagem indisponível</Txt>
            <Txt variant="small">{vs.error}</Txt>
            <View style={[styles.rowGap, { flexWrap: 'wrap' }]}>
              <Button title="Tentar de novo" icon="refresh" onPress={() => ensureVisionIndex(true)} />
              <Button title="Ler pelo texto" kind="secondary" onPress={onUseOcr} />
            </View>
          </View>
        ) : null}

        <View style={styles.controls} pointerEvents="box-none">
          <View style={styles.zoomBar}>
            {[1, 2, 3].map((z) => (
              <Pressable key={z} onPress={() => setZoom(z)} style={[styles.zoomBtn, zoom === z && { backgroundColor: t.highlight }]}>
                <Txt variant="small" color={zoom === z ? t.highlightText : '#fff'} style={{ fontWeight: '800' }}>{z}×</Txt>
              </Pressable>
            ))}
          </View>
          {mode === 'auto' ? (
            <Pressable onPress={cyclePref} style={styles.prefBtn}>
              <MaterialCommunityIcons name="cards-diamond-outline" size={16} color="#fff" />
              <Txt variant="small" color="#fff" style={{ fontWeight: '700' }}>{PREF_LABEL[pref]}</Txt>
            </Pressable>
          ) : null}
        </View>

        {last ? (
          <Animated.View style={[styles.sheet, { backgroundColor: t.card, borderColor: t.border },
            { transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
            <Pressable style={styles.lastRow} onPress={() => router.push({ pathname: '/card/[id]', params: { id: last.cardId } })}>
              {last.image ? (
                <Image source={{ uri: `${last.image}/low.webp` }} style={styles.thumb} contentFit="contain" />
              ) : <View style={[styles.thumb, { backgroundColor: t.backgroundElement }]} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt numberOfLines={1} style={{ fontWeight: '800', fontSize: 16 }}>{last.name}</Txt>
                <Txt variant="small" numberOfLines={1}>
                  {last.label}{last.itemId !== null ? ` · ${VARIANT_LABEL[last.variant]}` : ''}
                </Txt>
                <Txt style={{ fontWeight: '900', fontSize: 18, color: t.up }}>
                  {last.price === undefined ? '…' : last.price === null ? 'sem preço' : brl(last.price)}
                  {last.priceLabel && last.price ? <Txt variant="small">  {last.priceLabel}</Txt> : null}
                </Txt>
              </View>
              {mode === 'auto' && last.itemId !== null ? (
                <Pressable onPress={() => changeQty(last, -1)} style={[styles.undo, { borderColor: t.border }]}>
                  <MaterialCommunityIcons name="undo-variant" size={18} color={t.text} />
                  <Txt variant="small" style={{ fontWeight: '700', color: t.text }}>Desfazer</Txt>
                </Pressable>
              ) : null}
            </Pressable>
            {last.alts.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.alts}>
                <Txt variant="small" style={{ alignSelf: 'center' }}>Não é essa?</Txt>
                {last.alts.map((a) => (
                  <Pressable key={a.row.id} onPress={() => switchTo(last, a)} style={[styles.alt, { borderColor: t.border, backgroundColor: t.backgroundElement }]}>
                    {a.row.image ? <Image source={{ uri: `${a.row.image}/low.webp` }} style={styles.altImg} contentFit="contain" /> : null}
                    <View>
                      <Txt variant="small" numberOfLines={1} style={{ color: t.text, fontWeight: '700', maxWidth: 120 }}>{a.row.name}</Txt>
                      <Txt variant="small">{a.label}</Txt>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </Animated.View>
        ) : null}

        {rows.length ? (
          <Pressable onPress={() => setShowList(true)} style={[styles.queue, { backgroundColor: t.accent }]}>
            <MaterialCommunityIcons name={mode === 'auto' ? 'check-decagram' : 'magnify'} size={18} color="#fff" />
            <Txt color="#fff" style={{ fontWeight: '800', flex: 1 }}>
              {count} {count === 1 ? 'carta' : 'cartas'} · {brl(total)}
            </Txt>
            <Txt color="#fff" style={{ fontWeight: '800' }}>{mode === 'auto' ? 'salvas · ver' : 'ver'}</Txt>
            <MaterialCommunityIcons name="chevron-up" size={20} color="#fff" />
          </Pressable>
        ) : null}
      </View>

      <Modal visible={showList} animationType="slide" transparent onRequestClose={() => setShowList(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowList(false)} />
        <View style={[styles.listSheet, { backgroundColor: t.card, paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.listHead}>
            <Txt variant="h2">{mode === 'auto' ? 'Adicionadas agora' : 'Consultadas agora'}</Txt>
            <Txt style={{ fontWeight: '800', color: t.highlight }}>{brl(total)}</Txt>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 12 }}>
            {rows.map((r) => (
              <View key={r.key} style={[styles.listRow, { borderColor: t.border }]}>
                <Pressable
                  style={[styles.lastRow, { flex: 1 }]}
                  onPress={() => {
                    setShowList(false);
                    router.push({ pathname: '/card/[id]', params: { id: r.cardId } });
                  }}>
                  {r.image ? <Image source={{ uri: `${r.image}/low.webp` }} style={styles.thumbSm} contentFit="contain" /> : null}
                  <View style={{ flex: 1 }}>
                    <Txt numberOfLines={1} style={{ fontWeight: '700' }}>{r.name}</Txt>
                    <Txt variant="small">{r.label}{r.itemId !== null ? ` · ${VARIANT_LABEL[r.variant]}` : ''}</Txt>
                    <Txt variant="small" style={{ color: t.text, fontWeight: '800' }}>
                      {r.price === undefined ? 'buscando preço…' : r.price === null ? 'sem preço' : brl(r.price)}
                    </Txt>
                  </View>
                </Pressable>
                {r.itemId !== null ? (
                  <View style={styles.rowGap}>
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
          <Txt variant="small">
            {mode === 'auto'
              ? 'As cartas já estão na sua coleção. Toque numa carta para mudar a versão (normal, holo, reverse) ou o estado.'
              : 'Modo consulta: nada foi salvo na coleção.'}
          </Txt>
          <Button title="Continuar escaneando" icon="camera" onPress={() => setShowList(false)} />
        </View>
      </Modal>
    </View>
  );
}

function RoundBtn({ icon, on, busy, onPress }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; on?: boolean; busy?: boolean; onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.round, { backgroundColor: on ? t.highlight : 'rgba(0,0,0,0.55)' }]}>
      {busy ? <ActivityIndicator color="#fff" /> : <MaterialCommunityIcons name={icon} size={22} color={on ? t.highlightText : '#fff'} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28 },
  top: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  hintPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 999,
    paddingVertical: 8, paddingHorizontal: 16, maxWidth: '100%',
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, gap: 10 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  zoomBar: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 4, gap: 4 },
  zoomBtn: { minWidth: 40, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  prefBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 14, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { width: 54, height: 75, borderRadius: 5 },
  thumbSm: { width: 40, height: 56, borderRadius: 4 },
  undo: { alignItems: 'center', gap: 2, borderWidth: 1, borderRadius: 12, paddingVertical: 6, paddingHorizontal: 10 },
  alts: { gap: 8, paddingRight: 8 },
  alt: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 10, padding: 5 },
  altImg: { width: 26, height: 36, borderRadius: 3 },
  queue: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  listSheet: { maxHeight: '75%', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, gap: 10 },
  listHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
});
