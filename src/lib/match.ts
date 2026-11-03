// Liga o que o OCR leu (rodapé e/ou nome) a uma carta real do catálogo.
import { catalogByName, catalogByNumber, normName, setsWithAbbr, type CatalogRow, type SetMeta } from './catalog';
import { localIdVariants, type FooterInfo } from './footer';
import { getSet, type CardBrief, type SetDetail } from './tcgdex';

export interface Candidate {
  set: { id: string; name: string; abbreviation?: { official?: string }; cardCount: { official: number; total: number } };
  card: CardBrief;
  abbrMatch: boolean;
  score: number;
  /** true = dá para adicionar sem perguntar (sigla bateu, ou número+total/nome únicos) */
  sure: boolean;
}

const levenshtein1 = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
};

/** Siglas lidas que existem (exatas ou com 1 letra errada, se só houver uma parecida). */
export function resolveCodes(codes: string[], known: Set<string>): string[] {
  const out = new Set<string>();
  for (const c of codes) {
    if (known.has(c)) {
      out.add(c);
      continue;
    }
    const near = [...known].filter((k) => levenshtein1(c, k));
    if (near.length === 1) out.add(near[0]);
  }
  return [...out];
}

/**
 * Parte pura: pontua as cartas candidatas.
 * rows = cartas do catálogo com aquele número (ou com aquele nome, se não leu número).
 */
export function rankCandidates(
  info: FooterInfo | null,
  name: string | null,
  rows: CatalogRow[],
  sets: Map<string, SetMeta>,
): Candidate[] {
  const known = new Set([...sets.values()].map((s) => s.abbr).filter((a): a is string => !!a));
  const codes = resolveCodes((info?.setCodes ?? []).map((c) => c.toUpperCase()), known);
  const nName = name ? normName(name) : '';

  const scored = rows
    .filter((r) => sets.has(r.set_id)) // tira cartas digitais (TCG Pocket)
    .map((r) => {
      const set = sets.get(r.set_id)!;
      const abbrMatch = !!set.abbr && codes.includes(set.abbr);
      const totalMatch = !!info?.total && (set.cardCount.official === info.total || set.cardCount.total === info.total);
      const rn = normName(r.name);
      const nameExact = !!nName && rn === nName;
      const namePartial = !!nName && !nameExact && nName.length >= 4 && (rn.startsWith(nName) || nName.startsWith(rn));
      const score = (abbrMatch ? 100 : 0) + (totalMatch ? 50 : 0) + (nameExact ? 30 : namePartial ? 15 : 0) - set.order * 0.01;
      return { r, set, abbrMatch, totalMatch, nameOk: nameExact || namePartial, score };
    });

  let keep = scored;
  if (info?.number) {
    if (scored.some((s) => s.abbrMatch)) keep = scored.filter((s) => s.abbrMatch);
    else if (info.total) keep = scored.filter((s) => s.totalMatch);
    else if (nName) keep = scored.filter((s) => s.nameOk); // só número: precisa do nome para não chutar
    else keep = scored.length === 1 ? scored : [];
    // Nome ajuda a desempatar entre as que sobraram
    if (keep.length > 1 && keep.some((s) => s.nameOk)) keep = keep.filter((s) => s.nameOk);
  }

  keep.sort((a, b) => b.score - a.score);
  const sureOne = keep.length === 1 && (keep[0].abbrMatch || keep[0].totalMatch || keep[0].nameOk);
  return keep.slice(0, 12).map((s) => ({
    set: {
      id: s.set.id, name: s.set.name, abbreviation: s.set.abbr ? { official: s.set.abbr } : undefined,
      cardCount: s.set.cardCount,
    },
    card: { id: s.r.id, localId: s.r.local_id, name: s.r.name, image: s.r.image ?? undefined },
    abbrMatch: s.abbrMatch,
    score: s.score,
    sure: sureOne || (s.abbrMatch && keep.filter((k) => k.abbrMatch).length === 1),
  }));
}

/** Busca as candidatas: pelo número (rodapé) e, se não houver número, pelo nome. */
export async function findCandidates(info: FooterInfo | null, name: string | null = null): Promise<Candidate[]> {
  const sets = await setsWithAbbr();
  let rows: CatalogRow[] = [];
  if (info?.number) rows = await catalogByNumber(localIdVariants(info.number));
  else if (name) rows = await catalogByName(name);

  if (!rows.length && info?.number) {
    // Catálogo local ainda não baixado: plano B online (coleções com aquele total)
    const cands = [...sets.values()].filter((s) => info.total && (s.cardCount.official === info.total || s.cardCount.total === info.total));
    const details = await Promise.all(cands.slice(0, 10).map((s) => getSet(s.id).catch(() => null)));
    const ids = localIdVariants(info.number).map((v) => v.toUpperCase());
    rows = details
      .filter((d): d is SetDetail => !!d)
      .flatMap((d) => d.cards.filter((c) => ids.includes(c.localId.toUpperCase()))
        .map((c) => ({ id: c.id, set_id: d.id, local_id: c.localId, name: c.name, image: c.image ?? null })));
  }
  return rankCandidates(info, name, rows, sets);
}
