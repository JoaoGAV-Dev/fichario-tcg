// Rota de teste usada só pelo diagnóstico automático no emulador (fichariotcg://dev-seed).
// Adiciona algumas cartas e mostra o resultado de cada etapa de coleta de preço.
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { Txt } from '@/components/ui';
import { addToCollection, ensureCard } from '@/lib/collection';
import { cardsMissingToday, getCardSnapshots, refreshCards } from '@/lib/prices';
import { cachedMypPrice, getFx, intlPriceBRL, refreshMypSet, refreshTcgHistory } from '@/lib/sources/fast';

const SAMPLE = ['sv03-125', 'me01-086', 'sv03-124', 'swsh12-186'];

export default function DevSeed() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => setLog((l) => [...l, m]);
  useEffect(() => {
    (async () => {
      for (const id of SAMPLE) {
        const t0 = Date.now();
        try {
          await addToCollection(id, { variant: 'normal', condition: 'NM', quantity: 1 });
          const c = await ensureCard(id);
          const intl = await intlPriceBRL(id);
          say(`${id}: add ${Date.now() - t0}ms · intl ${intl ? intl.value + ' ' + intl.label : '—'}`);
          const t1 = Date.now();
          const n = await refreshMypSet(c);
          say(`  MYP coleção: ${n} cartas em ${Date.now() - t1}ms · cache ${await cachedMypPrice(c)}`);
          const t2 = Date.now();
          const w = await refreshTcgHistory(c);
          say(`  TCGplayer: ${w} semanas em ${Date.now() - t2}ms`);
        } catch (e) {
          say(`${id}: ERRO ${String(e).slice(0, 120)}`);
        }
      }
      const fx = await getFx();
      say(`Cotação: USD ${fx?.USD} · EUR ${fx?.EUR}`);
      const due = await cardsMissingToday('myp');
      const r = await refreshCards(due, undefined, 200);
      say(`MYP carta a carta: ${r.ok} ok, ${r.failed.length} falhas`);
      const s = await getCardSnapshots('sv03-125', 400);
      say(`sv03-125 snapshots: ${s.length} (${[...new Set(s.map((x) => x.source))].join(', ')})`);
      say('FIM');
    })();
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 24, gap: 4 }}>
      <Stack.Screen options={{ title: 'Teste' }} />
      {log.map((l, i) => <Txt key={i} variant="small">{l}</Txt>)}
    </ScrollView>
  );
}
