// Atualização dos preços da Liga Pokémon.
// A Liga bloqueia robôs (Cloudflare), então a leitura acontece num navegador (WebView) dentro do
// app: ele roda escondido ao abrir o app e só aparece se a Liga pedir "Confirme que é humano".
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useTheme } from '@/hooks/use-theme';
import { updateCardCache } from './collection';
import { emitDataChanged, getMeta, setMeta } from './db';
import { cardsMissingToday, saveLigaSnapshot, todayBR } from './prices';
import { ligaUrlFor, type CardRow } from './sources/collector';
import { parseLigaText } from './sources/parsers';

type Job = CardRow & { liga_url?: string | null };

interface LigaState {
  running: boolean;
  done: number;
  total: number;
  challenge: boolean;
  visible: boolean;
  lastSummary: string | null;
  start: (cards?: Job[], opts?: { visible?: boolean }) => Promise<void>;
  show: () => void;
}

const Ctx = createContext<LigaState>({
  running: false, done: 0, total: 0, challenge: false, visible: false, lastSummary: null,
  start: async () => {}, show: () => {},
});
export const useLiga = () => useContext(Ctx);

const PAGE_TIMEOUT_MS = 25_000;

// Roda dentro da página: espera o conteúdo e manda o texto visível para o app.
const PROBE = `
(function () {
  var tries = 0;
  function send(type, extra) {
    window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type, url: location.href }, extra || {})));
  }
  function tick() {
    tries++;
    var title = document.title || '';
    if (/um momento|just a moment|verifica/i.test(title) || document.querySelector('#challenge-form, .cf-turnstile, iframe[src*="challenges"]')) {
      send('challenge');
      return setTimeout(tick, 1500);
    }
    var text = (document.body && document.body.innerText) || '';
    var bits = Array.prototype.slice.call(document.querySelectorAll('[class*="prec"],[class*="price"],[class*="prc"]'))
      .slice(0, 80).map(function (e) { return (e.innerText || '').replace(/\\s+/g, ' '); }).join('\\n');
    if (/R\\$\\s*\\d/.test(text) || tries > 12) send('page', { text: text.slice(0, 20000), bits: bits.slice(0, 8000) });
    else setTimeout(tick, 800);
  }
  setTimeout(tick, 600);
})();
true;
`;

export function LigaProvider({ children }: { children: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState<Job[]>([]);
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [challenge, setChallenge] = useState(false);
  const [visible, setVisible] = useState(false);
  const [autoShown, setAutoShown] = useState(false);
  const [lastSummary, setLastSummary] = useState<string | null>(null);
  const okCount = useRef(0);
  const handled = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indexRef = useRef(0);
  const queueRef = useRef<Job[]>([]);

  const job = running ? queue[index] : undefined;

  const finish = useCallback((total: number) => {
    setRunning(false);
    setVisible(false);
    setChallenge(false);
    setLastSummary(`Liga: ${okCount.current} de ${total} cartas com preço hoje`);
    emitDataChanged();
  }, []);

  const advance = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setChallenge(false);
    const n = indexRef.current + 1;
    indexRef.current = n;
    if (n >= queueRef.current.length) finish(queueRef.current.length);
    else setIndex(n);
  }, [finish]);

  const start = useCallback(async (cards?: Job[], opts?: { visible?: boolean }) => {
    if (running) {
      if (opts?.visible) setVisible(true);
      return;
    }
    const list = cards ?? (await cardsMissingToday('liga'));
    if (!list.length) {
      setLastSummary('Liga: tudo atualizado hoje');
      return;
    }
    okCount.current = 0;
    handled.current = null;
    queueRef.current = list;
    indexRef.current = 0;
    setQueue(list);
    setIndex(0);
    setVisible(!!opts?.visible);
    setAutoShown(false);
    setRunning(true);
  }, [running]);

  // Automático: ao abrir o app (e ao voltar para ele), uma rodada por dia
  useEffect(() => {
    const maybeAuto = async () => {
      const day = todayBR();
      if ((await getMeta('liga_auto_day')) === day) return;
      await setMeta('liga_auto_day', day);
      start();
    };
    const t0 = setTimeout(maybeAuto, 4000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && maybeAuto());
    return () => {
      clearTimeout(t0);
      sub.remove();
    };
  }, [start]);

  // Tempo limite por página (exceto quando está esperando você passar pela verificação)
  useEffect(() => {
    if (!job || challenge) return;
    timer.current = setTimeout(advance, PAGE_TIMEOUT_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [job, challenge, advance]);

  async function onMessage(e: WebViewMessageEvent) {
    if (!job) return;
    const msg = JSON.parse(e.nativeEvent.data);
    if (msg.type === 'challenge') {
      if (!challenge) {
        setChallenge(true);
        if (!visible) {
          setVisible(true);
          setAutoShown(true);
        }
      }
      return;
    }
    const key = `${job.id}@${index}`;
    if (msg.type !== 'page' || handled.current === key) return;
    handled.current = key;
    if (challenge && autoShown) {
      setVisible(false); // passou pela verificação: volta a rodar escondido
      setAutoShown(false);
    }
    const prices = parseLigaText(`${msg.bits}\n${msg.text}`);
    await saveLigaSnapshot(job.id, prices, msg.url);
    if (prices.avg !== null || prices.min !== null) {
      okCount.current++;
      if (!job.liga_url && msg.url) updateCardCache(job.id, { liga_url: msg.url }).catch(() => {});
    }
    advance();
  }

  const url = job ? job.liga_url ?? ligaUrlFor(job) : null;

  return (
    <Ctx.Provider
      value={{
        running, done: Math.min(index, queue.length), total: queue.length, challenge, visible, lastSummary,
        start, show: () => setVisible(true),
      }}>
      {children}

      {job && url ? (
        <View
          pointerEvents={visible ? 'auto' : 'none'}
          style={visible ? [styles.full, { backgroundColor: t.background, paddingTop: insets.top }] : styles.hidden}>
          {visible ? (
            <View style={styles.bar}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.title, { color: t.text }]} numberOfLines={1}>
                  Liga {index + 1}/{queue.length} · {job.name_pt} {job.local_id}
                </Text>
                <Text style={{ color: t.textSecondary, fontSize: 13 }}>
                  {challenge ? 'Toque em "Confirme que é humano" abaixo.' : 'Lendo preço…'}
                </Text>
              </View>
              <BarButton label="Pular" onPress={advance} />
              <BarButton label="Ocultar" onPress={() => { setVisible(false); setAutoShown(false); }} />
              <BarButton label="Parar" onPress={() => finish(index)} />
            </View>
          ) : null}
          <WebView
            key={`${job.id}-${index}`}
            source={{ uri: url }}
            injectedJavaScript={PROBE}
            onMessage={onMessage}
            onError={advance}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

function BarButton({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.btn, { backgroundColor: t.backgroundElement }]}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Aviso pequeno para mostrar o andamento da Liga dentro das telas. */
export function LigaStatus() {
  const t = useTheme();
  const liga = useLiga();
  if (!liga.running && !liga.lastSummary) return null;
  const label = liga.running
    ? liga.challenge
      ? 'Liga pede verificação — toque aqui'
      : `Atualizando Liga… ${liga.done}/${liga.total}`
    : liga.lastSummary;
  return (
    <Pressable onPress={liga.running ? liga.show : undefined}>
      <View style={[styles.status, { backgroundColor: liga.challenge ? t.accent : t.backgroundElement }]}>
        <Text style={{ color: liga.challenge ? t.accentText : t.textSecondary, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  full: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 100, elevation: 100 },
  hidden: { position: 'absolute', left: 0, top: 0, width: 360, height: 640, opacity: 0.01, zIndex: -1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10 },
  title: { fontSize: 15, fontWeight: '700' },
  btn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10 },
  status: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
});
