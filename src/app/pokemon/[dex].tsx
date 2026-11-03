import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { CardGrid } from '@/components/card-grid';
import { Loading, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { cardsByDex, type CardBrief } from '@/lib/tcgdex';

export default function PokemonScreen() {
  const t = useTheme();
  const { dex, name } = useLocalSearchParams<{ dex: string; name?: string }>();
  const [cards, setCards] = useState<CardBrief[] | null>(null);

  useEffect(() => {
    cardsByDex(Number(dex)).then(setCards).catch(() => setCards([]));
  }, [dex]);

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <Stack.Screen options={{ title: name ? `${name} · #${String(dex).padStart(4, '0')}` : `#${dex}` }} />
      {cards === null ? <Loading label="Buscando todas as cartas deste Pokémon…" /> : (
        <CardGrid cards={cards} header={<Txt variant="small">Todas as cartas deste Pokémon em português, das mais novas para as mais antigas.</Txt>} />
      )}
    </View>
  );
}
