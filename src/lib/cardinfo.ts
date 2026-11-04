// Dados de uma carta de qualquer fonte: TCGdex em PT, em inglês, ou o banco do reconhecimento
// (cartas que o TCGdex não tem, como as energias básicas de Escarlate e Violeta).
import { getCard, type CardDetail } from './tcgdex';
import type { SetDetail } from './tcgdex';
import { visionCard, visionSetCards } from './vision';

/** Coleção montada pelo banco do reconhecimento (lançamento que o TCGdex ainda não tem). */
export function metaSet(setId: string): SetDetail | null {
  const cards = visionSetCards(setId);
  if (!cards.length) return null;
  const c0 = cards[0];
  return {
    id: setId, name: c0.setName, releaseDate: c0.release,
    serie: { id: 'novidades', name: 'Lançamento' },
    abbreviation: c0.abbr ? { official: c0.abbr } : undefined,
    cardCount: { official: c0.official || cards.length, total: cards.length },
    cards: cards.map((c) => ({ id: c.id, localId: c.local, name: c.name, image: c.image })),
  };
}

export function metaCard(id: string): CardDetail | null {
  const m = visionCard(id);
  if (!m) return null;
  return {
    id: m.id,
    localId: m.local,
    name: m.name,
    image: m.image,
    category: /energia|energy/i.test(m.name) ? 'Energia' : undefined,
    set: {
      id: m.set, name: m.setName, cardCount: { official: m.official, total: m.official },
      ...(m.abbr ? { abbreviation: { official: m.abbr } } : {}),
    } as CardDetail['set'],
    variants: { normal: true },
    pricing: m.usd ? { tcgplayer: { normal: { marketPrice: m.usd } } } : undefined,
  };
}

/** PT → inglês → banco do reconhecimento. */
export async function getCardAny(id: string): Promise<CardDetail> {
  try {
    return await getCard(id, 'pt');
  } catch {}
  try {
    return await getCard(id, 'en');
  } catch (e) {
    const m = metaCard(id);
    if (m) return m;
    throw e;
  }
}
