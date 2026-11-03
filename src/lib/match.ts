// Liga o texto do rodapé (OCR) a uma carta real do catálogo.
import { localIdVariants, type FooterInfo } from './footer';
import { getSeries, getSet, type CardBrief, type SetBrief, type SetDetail } from './tcgdex';

export interface Candidate {
  set: SetDetail;
  card: CardBrief;
  abbrMatch: boolean; // a sigla lida bate com a sigla oficial da coleção
}

/** Parte pura: dado o rodapé e as coleções candidatas (com detalhes), devolve as cartas possíveis. */
export function pickCandidates(info: FooterInfo, sets: SetDetail[]): Candidate[] {
  if (!info.number) return [];
  const ids = localIdVariants(info.number).map((s) => s.toUpperCase());
  const codes = info.setCodes.map((c) => c.toUpperCase());
  const out: Candidate[] = [];
  for (const set of sets) {
    const card = set.cards.find((c) => ids.includes(c.localId.toUpperCase()));
    if (!card) continue;
    const abbr = set.abbreviation?.official?.toUpperCase();
    out.push({ set, card, abbrMatch: !!abbr && codes.includes(abbr) });
  }
  // Se alguma bate pela sigla, só ela(s) interessam
  const strong = out.filter((c) => c.abbrMatch);
  return strong.length ? strong : out;
}

/** Quais coleções vale a pena baixar para conferir (filtra pelo total impresso na carta). */
export function candidateSets(info: FooterInfo, all: SetBrief[]): SetBrief[] {
  if (info.total) {
    const byOfficial = all.filter((s) => s.cardCount.official === info.total);
    if (byOfficial.length) return byOfficial;
    return all.filter((s) => s.cardCount.total === info.total);
  }
  // Promos (sem total): coleções de promo
  return all.filter((s) => s.cardCount.official === 0 || /promo/i.test(s.name) || /p$/.test(s.id));
}

export async function findCandidates(info: FooterInfo): Promise<Candidate[]> {
  if (!info.number) return [];
  const series = await getSeries();
  const all = series.flatMap((s) => s.sets);
  const sets = await Promise.all(candidateSets(info, all).slice(0, 12).map((s) => getSet(s.id)));
  return pickCandidates(info, sets);
}
