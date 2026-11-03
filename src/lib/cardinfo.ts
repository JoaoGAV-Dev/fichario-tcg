// Dados de uma carta de qualquer fonte: TCGdex em PT, em inglês, ou o banco do reconhecimento
// (cartas que o TCGdex não tem, como as energias básicas de Escarlate e Violeta).
import { getCard, type CardDetail } from './tcgdex';
import { visionCard } from './vision';

export function metaCard(id: string): CardDetail | null {
  const m = visionCard(id);
  if (!m) return null;
  return {
    id: m.id,
    localId: m.local,
    name: m.name,
    image: m.image,
    category: /energia|energy/i.test(m.name) ? 'Energia' : undefined,
    set: { id: m.set, name: m.setName, cardCount: { official: m.official, total: m.official } },
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
