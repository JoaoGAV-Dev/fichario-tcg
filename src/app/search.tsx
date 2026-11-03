import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import { CardGrid } from '@/components/card-grid';
import { Loading } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { searchCards, type CardBrief } from '@/lib/tcgdex';

export default function Search() {
  const t = useTheme();
  const params = useLocalSearchParams<{ q?: string }>();
  const [q, setQ] = useState(params.q ?? '');
  const [term, setTerm] = useState(params.q ?? '');
  const [cards, setCards] = useState<CardBrief[] | null>(null);

  useEffect(() => {
    setCards(null);
    searchCards(term).then(setCards).catch(() => setCards([]));
  }, [term]);

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <Stack.Screen options={{ title: 'Buscar carta' }} />
      {cards === null ? <Loading label="Buscando…" /> : (
        <CardGrid
          cards={cards}
          header={
            <TextInput
              value={q}
              onChangeText={setQ}
              onSubmitEditing={() => setTerm(q.trim())}
              returnKeyType="search"
              placeholder="Nome da carta (ex.: Charizard, Pikachu ex)"
              placeholderTextColor={t.muted}
              style={{ borderWidth: 1, borderColor: t.border, backgroundColor: t.card, color: t.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 }}
            />
          }
        />
      )}
    </View>
  );
}
