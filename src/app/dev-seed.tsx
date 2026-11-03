// Rota de teste usada só pelo diagnóstico automático no emulador (fichariotcg://dev-seed).
// Adiciona algumas cartas para as telas terem dados. Não aparece em nenhum menu do app.
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Txt } from '@/components/ui';
import { addToCollection, ensureCard } from '@/lib/collection';
import { refreshCards } from '@/lib/prices';

const SAMPLE = ['sv03-125', 'me01-086', 'sv03-124', 'swsh12-186'];

export default function DevSeed() {
  const [msg, setMsg] = useState('Adicionando cartas de teste…');
  useEffect(() => {
    (async () => {
      const rows = [];
      for (const id of SAMPLE) {
        try {
          await addToCollection(id, { variant: 'normal', condition: 'NM', quantity: 1 });
          rows.push(await ensureCard(id));
        } catch (e) {
          setMsg(`Erro em ${id}: ${e}`);
        }
      }
      await refreshCards(rows, (d, n) => setMsg(`Preços ${d}/${n}`), 300);
      router.replace('/');
    })();
  }, []);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Stack.Screen options={{ title: 'Teste' }} />
      <Txt>{msg}</Txt>
    </View>
  );
}
