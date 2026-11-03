// Rota de teste do diagnóstico automático (fichariotcg://dev-vision): baixa o banco de cartas,
// roda o reconhecimento por imagem em fotos reais (do vídeo e prints) e mostra o resultado e o tempo.
import { Asset } from 'expo-asset';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { recognizeImageAsync } from '../../modules/card-vision';
import { Txt } from '@/components/ui';
import { catalogByIds, ensureCatalog } from '@/lib/catalog';
import { ensureVisionIndex } from '@/lib/vision';

const TESTS: { label: string; mod: number }[] = [
  { label: 'Meowth de Alola', mod: require('../../vision/real/meowth-alola__v098.jpg') },
  { label: 'Meowth de Alola', mod: require('../../vision/real/meowth-alola__v093.jpg') },
  { label: 'Energia Escuridão', mod: require('../../vision/real/energia-escuridao__v128.jpg') },
  { label: 'Energia Escuridão', mod: require('../../vision/real/energia-escuridao__u2.jpg') },
  { label: 'Busca de Energia', mod: require('../../vision/real/busca-de-energia__u1.jpg') },
  { label: '(nenhuma)', mod: require('../../vision/real/none__v080.jpg') },
];

export default function DevVision() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => {
    console.log(`[dev-vision] ${m}`);
    setLog((l) => [...l, m]);
  };
  useEffect(() => {
    (async () => {
      const t0 = Date.now();
      ensureCatalog().catch(() => {});
      const st = await ensureVisionIndex(true);
      say(`Banco: ${st.state} ${st.count ?? ''} cartas v${st.version ?? '?'} em ${Date.now() - t0}ms ${st.error ?? ''}`);
      await ensureCatalog().catch(() => {});
      for (const tst of TESTS) {
        try {
          const a = Asset.fromModule(tst.mod);
          await a.downloadAsync();
          const r = await recognizeImageAsync(a.localUri ?? a.uri);
          const names = await catalogByIds(r.matches.slice(0, 3).map((m) => m.id));
          say(`${tst.label}: ${r.ms}ms cand=${r.candidates} guia=${r.guide} → ${r.matches.slice(0, 3)
            .map((m) => `${m.id} ${names.find((n) => n.id === m.id)?.name ?? '?'} ${m.score.toFixed(3)}`).join(' | ')}`);
        } catch (e) {
          say(`${tst.label}: ERRO ${String(e)}`);
        }
      }
      say('FIM');
    })();
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 48, gap: 8 }}>
      <Stack.Screen options={{ title: 'Teste de reconhecimento' }} />
      {log.map((l, i) => <Txt key={i} variant="small" style={{ color: '#fff' }}>{l}</Txt>)}
    </ScrollView>
  );
}
