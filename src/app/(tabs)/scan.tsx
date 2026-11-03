// Scanner contínuo: a câmera lê sem parar (OCR no aparelho). Ao reconhecer o rodapé de uma carta,
// ela entra direto na coleção (modo "Adicionar") ou só mostra o preço (modo "Consultar"),
// e o scanner segue lendo a próxima — sem botão para iniciar e sem travar.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Chip, Panel, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import {
  VARIANT_LABEL, addToCollection, defaultVariant, ensureCard, getItem, setQuantity, type Variant,
} from '@/lib/collection';
import { parseCardFooter, type FooterInfo } from '@/lib/footer';
import { brl } from '@/lib/format';
import { useLiga } from '@/lib/liga';
import { findCandidates, type Candidate } from '@/lib/match';
import { isOcrAvailable, readCardFooter } from '@/lib/ocr';
import { getCardSnapshots, refPrice, refreshCards, todayBR } from '@/lib/prices';
import { cachedMypPrice, intlPriceBRL, warmCard } from '@/lib/sources/fast';
import { useSettings } from '@/lib/settings';

type Mode = 'auto' | 'consulta';
type Phase = 'scanning' | 'choose';

interface SessionRow {
  key: string;
  itemId: number | null; // null no modo consulta
  cardId: string;
  name: string;
  label: string; // "OBF 125/197"
  image?: string;
  variant: Variant;
  added: number; // quantas cópias esta sessão adicionou
  price: number | null | undefined; // undefined = buscando
  priceLabel?: string; // de onde veio o preço mostrado
}

const PAUSE_BETWEEN_FRAMES_MS = 250;
const SAME_CARD_COOLDOWN_MS = 6000; // a mesma carta parada na frente da câmera não é somada de novo

const keyOf = (i: FooterInfo) => `${i.setCodes[0] ?? ''}|${i.number}/${i.totalRaw ?? ''}`;

export default function ScanScreen() {
  const t = useTheme();
  const focused = useIsFocused();
  const liga = useLiga();
  const { refMode } = useSettings();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [appActive, setAppActive] = useState(true);
  const [mode, setModeState] = useState<Mode>('auto');
  const [phase, setPhase] = useState<Phase>('scanning');
  const [hint, setHint] = useState('Aponte para a carta, com o rodapé visível');
  const [flash, setFlash] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [manual, setManual] = useState('');
  const rowsRef = useRef<SessionRow[]>([]);
  rowsRef.current = rows;

  const seen = useRef({ key: '', count: 0 });
  const last = useRef<{ cardId: string; at: number }>({ cardId: '', at: 0 });
  const busy = useRef(false);
  const modeRef = useRef<Mode>('auto');

  const ocr = isOcrAvailable();

  useEffect(() => {
    AsyncStorage.getItem('scanMode').then((v) => {
      if (v === 'auto' || v === 'consulta') {
        setModeState(v);
        modeRef.current = v;
      }
    });
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!focused) setReady(false);
  }, [focused]);

  function setMode(m: Mode) {
    setModeState(m);
    modeRef.current = m;
    AsyncStorage.setItem('scanMode', m).catch(() => {});
  }

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2500);
  }

  /**
   * Preço quase instantâneo: 1) preço brasileiro já salvo hoje, 2) menor preço da MYP em cache da coleção,
   * 3) preço internacional convertido (≈R$). Em paralelo, baixa a coleção inteira da MYP e o histórico.
   */
  const loadPrice = useCallback(async (cardId: string, key: string, variant: Variant) => {
    const put = (price: number | null, priceLabel?: string) =>
      setRows((rs) => rs.map((r) => (r.key === key ? { ...r, price, priceLabel } : r)));
    try {
      const card = await ensureCard(cardId);
      const today = todayBR();
      const local = refPrice(await getCardSnapshots(cardId, 3), today, refMode);
      if (local !== null) put(local, 'Liga/MYP hoje');
      else {
        const cached = await cachedMypPrice(card);
        if (cached !== null) put(cached, 'MYP · menor preço');
        else {
          const intl = await intlPriceBRL(cardId);
          if (intl) put(intl.value, `≈ ${intl.label}`);
        }
      }
      // Segundo plano: coleção inteira da MYP (deixa as próximas cartas instantâneas) + histórico
      await warmCard(card, variant);
      const after = refPrice(await getCardSnapshots(cardId, 3), today, refMode) ?? (await cachedMypPrice(card));
      if (after !== null) put(after, 'MYP · menor preço');
      else if (local === null) setRows((rs) => rs.map((r) => (r.key === key && r.price === undefined ? { ...r, price: null } : r)));
      refreshCards([card], undefined, 0).then(async () => {
        const full = refPrice(await getCardSnapshots(cardId, 3), todayBR(), refMode);
        if (full !== null) put(full, 'Liga/MYP · médio');
      }).catch(() => {});
      liga.start([card]);
    } catch {
      setRows((rs) => rs.map((r) => (r.key === key && r.price === undefined ? { ...r, price: null } : r)));
    }
  }, [refMode, liga]);

  /** Carta identificada: adiciona (ou só mostra) e segue escaneando. */
  const accept = useCallback(async (c: Candidate) => {
    const now = Date.now();
    if (last.current.cardId === c.card.id && now - last.current.at < SAME_CARD_COOLDOWN_MS) {
      last.current.at = now; // continua parada na frente: renova o "já vi"
      setHint('Já li esta. Mostre a próxima carta.');
      return;
    }
    last.current = { cardId: c.card.id, at: now };
    const label = `${c.set.abbreviation?.official ?? c.set.id.toUpperCase()} ${c.card.localId}/${c.set.cardCount.official || c.set.cardCount.total}`;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    if (modeRef.current === 'consulta') {
      const key = `${c.card.id}-${now}`;
      setRows((rs) => [{ key, itemId: null, cardId: c.card.id, name: c.card.name, label, image: c.card.image, variant: 'normal' as Variant, added: 0, price: undefined }, ...rs].slice(0, 30));
      showFlash(`${c.card.name} · ${label}`);
      loadPrice(c.card.id, key, 'normal');
      return;
    }

    try {
      const card = await ensureCard(c.card.id);
      const variant = defaultVariant(card);
      const { itemId } = await addToCollection(c.card.id, { variant, condition: 'NM', quantity: 1 });
      const key = `item-${itemId}`;
      const isNew = !rowsRef.current.some((r) => r.key === key);
      setRows((rs) => {
        const found = rs.find((r) => r.key === key);
        if (found) return [{ ...found, added: found.added + 1 }, ...rs.filter((r) => r.key !== key)];
        return [{ key, itemId, cardId: c.card.id, name: c.card.name, label, image: c.card.image, variant, added: 1, price: undefined }, ...rs];
      });
      showFlash(`✓ ${c.card.name} adicionada`);
      if (isNew) loadPrice(c.card.id, key, variant);
    } catch (e) {
      showFlash(`Erro ao adicionar: ${String(e).slice(0, 60)}`);
    }
  }, [loadPrice]);

  const resolve = useCallback(async (info: FooterInfo, source: 'camera' | 'manual') => {
    setHint(`Procurando ${info.setCodes[0] ?? ''} ${info.number}${info.totalRaw ? '/' + info.totalRaw : ''}…`);
    try {
      const found = await findCandidates(info);
      if (found.length === 1) {
        await accept(found[0]);
        setHint('Pronto. Mostre a próxima carta.');
      } else if (found.length > 1) {
        // Mesma carta já escolhida há pouco? Não pergunta de novo
        const recent = found.find((f) => f.card.id === last.current.cardId);
        if (recent && Date.now() - last.current.at < SAME_CARD_COOLDOWN_MS) {
          last.current.at = Date.now();
          return;
        }
        Haptics.selectionAsync().catch(() => {});
        setCandidates(found);
        setPhase('choose');
      } else {
        setHint(source === 'camera'
          ? `Li "${info.number}/${info.totalRaw ?? '?'}", mas não achei. Ajuste ângulo e luz…`
          : 'Não achei nenhuma carta com esse rodapé.');
      }
    } catch {
      setHint('Sem internet para consultar o catálogo? Tentando de novo…');
    }
  }, [accept]);

  const scanOnce = useCallback(async () => {
    if (!camera.current || busy.current) return;
    busy.current = true;
    let uri: string | null = null;
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.6, shutterSound: false });
      uri = photo.uri;
      const read = await readCardFooter(photo.uri);
      if (!read.info) {
        seen.current = { key: '', count: 0 };
        setHint(read.footer ? `Lendo… "${read.footer}"` : 'Aproxime a carta: preciso ver o número (ex.: 125/197)');
        return;
      }
      const info = read.info;
      const key = keyOf(info);
      seen.current = { key, count: seen.current.key === key ? seen.current.count + 1 : 1 };
      setHint(`Li ${read.footer}`);
      // Com sigla da coleção: confia na 1ª leitura. Sem sigla (cartas antigas): 2 leituras iguais.
      if (info.setCodes.length || seen.current.count >= 2) await resolve(info, 'camera');
    } finally {
      busy.current = false;
      if (uri) {
        try {
          new File(uri).delete();
        } catch {}
      }
    }
  }, [resolve]);

  // Loop do scanner
  useEffect(() => {
    if (!ocr || !focused || !appActive || !ready || phase !== 'scanning' || !permission?.granted) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        await scanOnce();
      } catch {}
      if (!stop) setTimeout(tick, PAUSE_BETWEEN_FRAMES_MS);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [ocr, focused, appActive, ready, phase, permission?.granted, scanOnce]);

  async function choose(c: Candidate | null) {
    setPhase('scanning');
    setCandidates([]);
    if (c) await accept(c);
  }

  async function changeQty(r: SessionRow, delta: number) {
    if (r.itemId === null) return;
    const cur = await getItem(r.itemId);
    const q = (cur?.quantity ?? 0) + delta;
    await setQuantity(r.itemId, q);
    setRows((rs) => rs
      .map((x) => (x.key === r.key ? { ...x, added: x.added + delta } : x))
      .filter((x) => x.itemId === null || x.added > 0));
    if (delta < 0) showFlash(q <= 0 ? `${r.name} removida da coleção` : `${r.name}: −1`);
  }

  const total = rows.reduce((a, r) => a + (r.price ?? 0) * Math.max(r.added, r.itemId === null ? 1 : 0), 0);
  const copies = rows.reduce((a, r) => a + r.added, 0);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <View style={styles.rowBetween}>
            <Txt variant="title">Escanear</Txt>
            <View style={styles.wrap}>
              <Chip label="Adicionar" active={mode === 'auto'} onPress={() => setMode('auto')} />
              <Chip label="Só consultar" active={mode === 'consulta'} onPress={() => setMode('consulta')} />
            </View>
          </View>

          {!ocr ? (
            <Panel>
              <Txt variant="small">O scanner automático só funciona no app instalado (APK). Aqui dá para buscar digitando o rodapé.</Txt>
            </Panel>
          ) : !permission?.granted ? (
            <Panel style={{ gap: 10 }}>
              <Txt>Preciso da câmera para ler o rodapé das cartas.</Txt>
              <Button title="Permitir câmera" onPress={requestPermission} />
            </Panel>
          ) : (
            <View style={styles.cameraWrap}>
              {focused ? (
                <CameraView
                  ref={camera}
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  autofocus="on"
                  animateShutter={false}
                  onCameraReady={() => setReady(true)}
                />
              ) : null}
              <View pointerEvents="none" style={[styles.guide, { borderColor: flash?.startsWith('✓') ? t.up : 'rgba(255,255,255,0.85)' }]} />
              <View pointerEvents="none" style={styles.band} />
              <View style={styles.hint}>
                <Txt variant="small" color="#fff" numberOfLines={2} style={{ textAlign: 'center', fontWeight: flash ? '700' : '400' }}>
                  {phase === 'choose' ? 'Qual destas? Escolha abaixo' : flash ?? hint}
                </Txt>
              </View>
            </View>
          )}

          {phase === 'choose' ? (
            <Panel style={{ gap: 8 }}>
              <Txt variant="h2">Qual destas?</Txt>
              <Txt variant="small">Esse número existe em mais de uma coleção.</Txt>
              {candidates.map((c) => (
                <Pressable key={c.card.id} onPress={() => choose(c)}>
                  <View style={[styles.row, { borderColor: t.border }]}>
                    {c.card.image ? (
                      <Image source={{ uri: `${c.card.image}/low.webp` }} style={styles.thumb} contentFit="contain" />
                    ) : <View style={[styles.thumb, { backgroundColor: t.backgroundElement }]} />}
                    <View style={{ flex: 1 }}>
                      <Txt style={{ fontWeight: '700' }}>{c.card.name}</Txt>
                      <Txt variant="small">{c.set.name} · {c.card.localId}/{c.set.cardCount.official}</Txt>
                    </View>
                  </View>
                </Pressable>
              ))}
              <Button title="Nenhuma, continuar escaneando" kind="secondary" onPress={() => choose(null)} />
            </Panel>
          ) : null}

          {rows.length ? (
            <Panel style={{ gap: 4 }}>
              <View style={styles.rowBetween}>
                <Txt variant="h2">{mode === 'auto' ? 'Adicionadas agora' : 'Consultadas agora'}</Txt>
                <Txt variant="small">{mode === 'auto' ? `${copies} cartas · ` : ''}{brl(total)}</Txt>
              </View>
              {rows.map((r) => (
                <View key={r.key} style={[styles.row, { borderColor: t.border }]}>
                  <Pressable onPress={() => router.push({ pathname: '/card/[id]', params: { id: r.cardId } })} style={styles.rowLink}>
                    {r.image ? (
                      <Image source={{ uri: `${r.image}/low.webp` }} style={styles.thumb} contentFit="contain" />
                    ) : <View style={[styles.thumb, { backgroundColor: t.backgroundElement }]} />}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt numberOfLines={1} style={{ fontWeight: '700' }}>{r.name}</Txt>
                      <Txt variant="small">{r.label}{r.itemId !== null ? ` · ${VARIANT_LABEL[r.variant]}` : ''}</Txt>
                      <Txt variant="small">
                        <Txt variant="small" style={{ fontWeight: '800', color: t.text }}>
                          {r.price === undefined ? 'buscando preço…' : r.price === null ? 'sem preço' : brl(r.price)}
                        </Txt>
                        {r.priceLabel && r.price ? `  ${r.priceLabel}` : ''}
                      </Txt>
                    </View>
                  </Pressable>
                  {r.itemId !== null ? (
                    <View style={styles.qty}>
                      <Chip label="−" onPress={() => changeQty(r, -1)} />
                      <Txt style={{ minWidth: 22, textAlign: 'center', fontWeight: '700' }}>{r.added}</Txt>
                      <Chip label="+" onPress={() => changeQty(r, +1)} />
                    </View>
                  ) : null}
                </View>
              ))}
              {mode === 'auto' ? (
                <Txt variant="small" style={{ marginTop: 6 }}>
                  Errou a carta? Toque em − para tirar. Toque na carta para trocar a versão (normal, holo, reverse).
                </Txt>
              ) : null}
            </Panel>
          ) : null}

          <Panel style={{ gap: 10 }}>
            <Txt variant="label">Ou digite o rodapé</Txt>
            <TextInput
              value={manual}
              onChangeText={setManual}
              placeholder="Ex.: OBF 125/197  ·  MEG 086/132  ·  025/202"
              placeholderTextColor={t.muted}
              autoCapitalize="characters"
              onSubmitEditing={() => manual.trim() && resolve(parseCardFooter(manual), 'manual')}
              style={[styles.input, { backgroundColor: t.background, borderColor: t.border, color: t.text }]}
            />
            <Button
              title="Buscar" kind="secondary" disabled={!manual.trim()}
              onPress={() => {
                const info = parseCardFooter(manual);
                if (!info.number) return Alert.alert('Rodapé incompleto', 'Preciso pelo menos do número, ex.: 125/197.');
                last.current = { cardId: '', at: 0 }; // digitado: sempre aceita
                resolve(info, 'manual');
              }}
            />
          </Panel>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cameraWrap: { height: 360, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  guide: { position: 'absolute', left: '17%', right: '17%', top: '6%', bottom: '6%', borderWidth: 2.5, borderRadius: 14 },
  band: {
    position: 'absolute', left: '17%', right: '17%', bottom: '6%', height: '14%',
    backgroundColor: 'rgba(247,201,52,0.22)', borderBottomLeftRadius: 14, borderBottomRightRadius: 14,
  },
  hint: {
    position: 'absolute', left: 12, right: 12, bottom: 10, backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  rowLink: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  qty: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  thumb: { width: 44, height: 61, borderRadius: 4 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, letterSpacing: 0.5 },
});
