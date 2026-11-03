// Scanner automático: lê a câmera continuamente (OCR no aparelho) e, quando enxerga o rodapé
// da carta (sigla + número), acha a carta sozinho. Sem botão para iniciar.
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
import { addToCollection, ensureCard, VARIANT_LABEL, type Variant } from '@/lib/collection';
import { parseCardFooter, type FooterInfo } from '@/lib/footer';
import { brl } from '@/lib/format';
import { useLiga } from '@/lib/liga';
import { findCandidates, type Candidate } from '@/lib/match';
import { isOcrAvailable, readCardFooter } from '@/lib/ocr';
import { getCardSnapshots, priceOn, refreshCards, todayBR, type Snapshot } from '@/lib/prices';

type Phase = 'scanning' | 'matching' | 'found' | 'choose' | 'notfound';

const CARD_RATIO = 88 / 63;
const PAUSE_BETWEEN_FRAMES_MS = 300;

const keyOf = (i: FooterInfo) => `${i.number}/${i.totalRaw ?? ''}`;

export default function ScanScreen() {
  const t = useTheme();
  const focused = useIsFocused();
  const liga = useLiga();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [appActive, setAppActive] = useState(true);
  const [phase, setPhase] = useState<Phase>('scanning');
  const [hint, setHint] = useState('Aponte para a carta, com o rodapé visível');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [variant, setVariant] = useState<Variant>('normal');
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // Memória entre quadros: mesma leitura repetida dá confiança; sem sigla, espera um pouco por ela
  const seen = useRef<{ key: string; count: number; withoutAbbr: number }>({ key: '', count: 0, withoutAbbr: 0 });

  const ocr = isOcrAvailable();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!focused) setReady(false);
  }, [focused]);

  const resolve = useCallback(async (info: FooterInfo, source: 'camera' | 'manual') => {
    setPhase('matching');
    setHint(`Procurando ${info.setCodes[0] ?? ''} ${info.number}${info.totalRaw ? '/' + info.totalRaw : ''}…`);
    try {
      const found = await findCandidates(info);
      if (found.length === 1) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        select(found[0]);
      } else if (found.length > 1) {
        Haptics.selectionAsync().catch(() => {});
        setCandidates(found);
        setPhase('choose');
      } else if (source === 'camera') {
        setHint(`Li "${info.number}/${info.totalRaw ?? '?'}", mas não achei. Ajuste o ângulo/luz…`);
        setPhase('scanning');
      } else {
        setPhase('notfound');
      }
    } catch (e) {
      setHint('Sem internet para consultar o catálogo? Tentando de novo…');
      setPhase(source === 'camera' ? 'scanning' : 'notfound');
    }
  }, []);

  const scanOnce = useCallback(async () => {
    if (!camera.current) return;
    const photo = await camera.current.takePictureAsync({ quality: 0.6, shutterSound: false });
    try {
      const read = await readCardFooter(photo.uri);
      if (!read.info) {
        seen.current = { key: '', count: 0, withoutAbbr: 0 };
        setHint(read.footer ? `Lendo… "${read.footer}"` : 'Aproxime a carta: preciso ver o número (ex.: 125/197)');
        return;
      }
      const info = read.info;
      const key = keyOf(info);
      const s = seen.current;
      s.count = s.key === key ? s.count + 1 : 1;
      s.key = key;
      s.withoutAbbr = info.setCodes.length ? 0 : s.withoutAbbr + 1;
      setHint(`Li ${read.footer}`);
      // Com sigla: confia na 1ª leitura. Sem sigla (cartas antigas): confirma em 2 quadros iguais.
      if (info.setCodes.length || s.count >= 2) await resolve(info, 'camera');
    } finally {
      try {
        new File(photo.uri).delete();
      } catch {}
    }
  }, [resolve]);

  // Loop do scanner: roda enquanto a aba está aberta, o app está na frente e não achou carta
  useEffect(() => {
    if (!ocr || !focused || !appActive || !ready || phase !== 'scanning' || !permission?.granted) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        await scanOnce();
      } catch {
        // foto/ocr falhou nesse quadro: segue para o próximo
      }
      if (!stop) setTimeout(tick, PAUSE_BETWEEN_FRAMES_MS);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [ocr, focused, appActive, ready, phase, permission?.granted, scanOnce]);

  async function select(c: Candidate) {
    setChosen(c);
    setPhase('found');
    setSnaps(null);
    setQty(1);
    try {
      const row = await ensureCard(c.card.id);
      let s = await getCardSnapshots(c.card.id);
      if (!s.some((x) => x.source === 'myp' && x.captured_on === todayBR())) {
        await refreshCards([row], undefined, 0);
        s = await getCardSnapshots(c.card.id);
      }
      setSnaps(s);
    } catch {
      setSnaps([]);
    }
  }

  function scanAgain() {
    seen.current = { key: '', count: 0, withoutAbbr: 0 };
    setChosen(null);
    setCandidates([]);
    setHint('Aponte para a carta, com o rodapé visível');
    setPhase('scanning');
  }

  async function add() {
    if (!chosen) return;
    setAdding(true);
    try {
      await addToCollection(chosen.card.id, { variant, condition: 'NM', quantity: qty });
      if (!snaps?.some((x) => x.source === 'liga')) liga.start([await ensureCard(chosen.card.id)]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setLastAdded(`${qty}x ${chosen.card.name} adicionada`);
      scanAgain(); // já volta a escanear a próxima
    } catch (e) {
      Alert.alert('Erro ao adicionar', String(e));
    } finally {
      setAdding(false);
    }
  }

  const guide = box
    ? (() => {
        const h = box.height * 0.86;
        const w = Math.min(h / CARD_RATIO, box.width * 0.82);
        const hh = w * CARD_RATIO;
        return { left: (box.width - w) / 2, top: (box.height - hh) / 2, width: w, height: hh };
      })()
    : null;

  const today = todayBR();
  const mypAvg = snaps ? priceOn(snaps, 'myp', today) : null;
  const ligaAvg = snaps ? priceOn(snaps, 'liga', today) : null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <Txt variant="title">Escanear</Txt>

          {!ocr ? (
            <Panel>
              <Txt variant="small">
                O scanner automático só funciona no app instalado (APK). Aqui dá para buscar digitando o rodapé.
              </Txt>
            </Panel>
          ) : !permission?.granted ? (
            <Panel style={{ gap: 10 }}>
              <Txt>Preciso da câmera para ler o rodapé das cartas.</Txt>
              <Button title="Permitir câmera" onPress={requestPermission} />
            </Panel>
          ) : (
            <View style={styles.cameraWrap} onLayout={(e) => setBox(e.nativeEvent.layout)}>
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
              {guide ? (
                <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                  <View
                    style={[styles.guide, guide, {
                      borderColor: phase === 'found' ? t.up : phase === 'scanning' ? 'rgba(255,255,255,0.85)' : t.accent,
                    }]}
                  />
                  <View
                    style={[styles.band, {
                      left: guide.left, width: guide.width, top: guide.top + guide.height * 0.84, height: guide.height * 0.16,
                    }]}
                  />
                </View>
              ) : null}
              <View style={styles.hint}>
                <Txt variant="small" color="#fff" numberOfLines={2} style={{ textAlign: 'center' }}>
                  {phase === 'found' ? 'Carta encontrada' : phase === 'choose' ? 'Escolha a carta abaixo' : hint}
                </Txt>
              </View>
            </View>
          )}

          {lastAdded && phase === 'scanning' ? <Txt variant="small" style={{ textAlign: 'center' }}>✓ {lastAdded}</Txt> : null}

          {phase === 'found' && chosen ? (
            <Panel style={{ gap: 12 }}>
              <Pressable onPress={() => router.push({ pathname: '/card/[id]', params: { id: chosen.card.id } })}>
                <View style={styles.result}>
                  {chosen.card.image ? (
                    <Image source={{ uri: `${chosen.card.image}/low.webp` }} style={styles.resultImg} contentFit="contain" />
                  ) : <View style={[styles.resultImg, { backgroundColor: t.backgroundElement }]} />}
                  <View style={{ flex: 1, gap: 3 }}>
                    <Txt variant="h2">{chosen.card.name}</Txt>
                    <Txt variant="small">
                      {chosen.set.name} · {chosen.set.abbreviation?.official ?? chosen.set.id.toUpperCase()} {chosen.card.localId}/{chosen.set.cardCount.official}
                    </Txt>
                    <Txt variant="small" style={{ marginTop: 6 }}>
                      {snaps === null ? 'Buscando preço…' : `MYP médio: ${brl(mypAvg)} · Liga médio: ${brl(ligaAvg)}`}
                    </Txt>
                    <Txt variant="small" style={{ textDecorationLine: 'underline' }}>Ver detalhes e histórico</Txt>
                  </View>
                </View>
              </Pressable>
              <View style={styles.wrap}>
                {(['normal', 'holo', 'reverse'] as Variant[]).map((v) => (
                  <Chip key={v} label={VARIANT_LABEL[v]} active={variant === v} onPress={() => setVariant(v)} />
                ))}
              </View>
              <View style={styles.rowBetween}>
                <View style={styles.wrap}>
                  <Chip label="−" onPress={() => setQty((q) => Math.max(1, q - 1))} />
                  <Txt style={{ minWidth: 24, textAlign: 'center', fontWeight: '700', alignSelf: 'center' }}>{qty}</Txt>
                  <Chip label="+" onPress={() => setQty((q) => q + 1)} />
                </View>
                <Button title="Adicionar" onPress={add} loading={adding} />
              </View>
              <Button title="Escanear de novo" kind="secondary" onPress={scanAgain} />
            </Panel>
          ) : null}

          {phase === 'choose' ? (
            <View style={{ gap: 8 }}>
              <Txt variant="h2">Qual destas?</Txt>
              <Txt variant="small">Esse número existe em mais de uma coleção. Toque na carta certa.</Txt>
              {candidates.map((c) => (
                <Pressable key={c.card.id} onPress={() => select(c)}>
                  <View style={[styles.cand, { backgroundColor: t.card, borderColor: t.border }]}>
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
              <Button title="Escanear de novo" kind="secondary" onPress={scanAgain} />
            </View>
          ) : null}

          {phase === 'notfound' ? (
            <Panel style={{ gap: 10 }}>
              <Txt>Não achei nenhuma carta com esse rodapé. Confira o número/total e a sigla da coleção.</Txt>
              <Button title="Escanear de novo" kind="secondary" onPress={scanAgain} />
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
  cameraWrap: { height: 470, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' },
  guide: { position: 'absolute', borderWidth: 2.5, borderRadius: 14 },
  band: { position: 'absolute', backgroundColor: 'rgba(247,201,52,0.22)', borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  hint: {
    position: 'absolute', left: 12, right: 12, bottom: 12, backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10,
  },
  result: { flexDirection: 'row', gap: 12 },
  resultImg: { width: 96, height: 134, borderRadius: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, letterSpacing: 0.5 },
  cand: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  thumb: { width: 48, height: 67, borderRadius: 4 },
});
