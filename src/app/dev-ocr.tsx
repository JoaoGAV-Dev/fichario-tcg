// Rota de teste do diagnóstico automático (fichariotcg://dev-ocr): roda o leitor de cartas em imagens
// reais das cartas (TCGdex), em tamanho normal e reduzido, e mostra o que leu e qual carta achou.
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import { Txt } from '@/components/ui';
import { ensureCatalog, setsWithAbbr } from '@/lib/catalog';
import { findCandidates } from '@/lib/match';
import { readCard } from '@/lib/ocr';

const TESTS = [
  { id: 'me03-072', url: 'https://assets.tcgdex.net/pt/me/me03/072/high.png' }, // Busca de Energia (POR 072/088)
  { id: 'mee-007', url: 'https://assets.tcgdex.net/pt/me/mee/007/high.png' }, // Energia Básica
  { id: 'me03-038', url: 'https://assets.tcgdex.net/pt/me/me03/038/high.png' }, // Probopass
  { id: 'sv03-125', url: 'https://assets.tcgdex.net/pt/sv/sv03/125/high.png' }, // Charizard ex
];

export default function DevOcr() {
  const [log, setLog] = useState<string[]>([]);
  const say = (m: string) => setLog((l) => [...l, m]);
  useEffect(() => {
    (async () => {
      const t0 = Date.now();
      await Promise.all([ensureCatalog(), setsWithAbbr()]);
      say(`Catálogo pronto em ${Date.now() - t0}ms`);
      for (const tst of TESTS) {
        try {
          const f = new File(Paths.cache, `${tst.id}.png`);
          if (!f.exists) await File.downloadFileAsync(tst.url, f);
          for (const w of [734, 420]) {
            const img = await (await ImageManipulator.manipulate(f.uri).resize({ width: w }).renderAsync())
              .saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
            const t1 = Date.now();
            const r = await readCard(img.uri, { originX: 0, originY: 0, width: img.width, height: img.height }, img.height);
            const c = await findCandidates(r.info, r.name);
            const ok = c[0]?.card.id === tst.id;
            say(`${ok ? 'OK ' : 'XX '}${tst.id} @${w}px ${Date.now() - t1}ms · nome="${r.name}" · rodapé="${r.footer}" → ${c.slice(0, 3).map((x) => `${x.card.id}${x.sure ? '✓' : '?'}`).join(', ') || 'nada'}`);
          }
        } catch (e) {
          say(`ERRO ${tst.id}: ${String(e).slice(0, 140)}`);
        }
      }
      say('FIM');
    })();
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 24, gap: 6 }}>
      <Stack.Screen options={{ title: 'Teste OCR' }} />
      {log.map((l, i) => <Txt key={i} variant="small">{l}</Txt>)}
    </ScrollView>
  );
}
