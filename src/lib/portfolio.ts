// Cálculos do painel da coleção (funções puras, testadas em tests/).
import type { Item } from './collection';
import { MAX_AGE_DAYS, brPriceAt, minusDays, pct, priceOn, refPrice, todayBR, type RefMode, type Snapshot } from './prices';

export interface CardHolding {
  cardId: string;
  qty: number;
  item: Item; // um item representativo (para nome, imagem, coleção)
  price: number | null; // preço de referência hoje (unitário)
}

export interface SetSummary {
  setId: string;
  name: string;
  owned: number; // cartas distintas
  total: number | null; // total da coleção (com secretas)
  value: number;
  cover: string | null; // imagem da carta mais valiosa
}

export interface Mover {
  holding: CardHolding;
  then: number;
  now: number;
  pct: number;
  delta: number; // em R$, já multiplicado pela quantidade
  estimated: boolean;
}

export interface Dashboard {
  value: number;
  copies: number;
  distinct: number;
  priced: number;
  activeSets: number;
  change30: { delta: number; pct: number | null; compared: number; estimated: number };
  entries30: { distinct: number; copies: number; value: number };
  sets: SetSummary[];
  top: CardHolding[];
}

/**
 * Preço de referência num dia: real, ou estimado pela tendência do TCGplayer, ou (sem nada disso)
 * o primeiro preço brasileiro conhecido.
 */
export function priceForChart(snaps: Snapshot[], date: string, mode: RefMode, today = todayBR()): number | null {
  const p = brPriceAt(snaps, date, mode, today);
  if (p !== null) return p.value;
  const first = [...snaps]
    .filter((s) => (s.source === 'liga' || s.source === 'myp') && (s.price_avg ?? s.price_min) !== null)
    .sort((a, b) => (a.captured_on < b.captured_on ? -1 : 1))[0];
  return first ? refPrice(snaps, first.captured_on, mode) : null;
}

export function holdingsOf(items: Item[], snapsByCard: Map<string, Snapshot[]>, mode: RefMode, today = todayBR()): CardHolding[] {
  const map = new Map<string, CardHolding>();
  for (const it of items) {
    const h = map.get(it.card_id);
    if (h) h.qty += it.quantity;
    else map.set(it.card_id, { cardId: it.card_id, qty: it.quantity, item: it, price: null });
  }
  for (const h of map.values()) h.price = refPrice(snapsByCard.get(h.cardId) ?? [], today, mode);
  return [...map.values()];
}

export function buildDashboard(items: Item[], snapsByCard: Map<string, Snapshot[]>, mode: RefMode, today = todayBR()): Dashboard {
  const holdings = holdingsOf(items, snapsByCard, mode, today);
  const value = holdings.reduce((a, h) => a + (h.price ?? 0) * h.qty, 0);

  // Variação de preço em 30 dias (cartas com preço nas duas pontas)
  let now30 = 0;
  let then30 = 0;
  let compared = 0;
  let estimated = 0;
  const thenDate = minusDays(today, 30);
  for (const h of holdings) {
    const snaps = snapsByCard.get(h.cardId) ?? [];
    const t = brPriceAt(snaps, thenDate, mode, today, MAX_AGE_DAYS);
    if (h.price === null || t === null) continue;
    now30 += h.price * h.qty;
    then30 += t.value * h.qty;
    compared++;
    if (t.estimated) estimated++;
  }

  // Cartas que entraram nos últimos 30 dias
  const since = `${thenDate} 00:00:00`;
  const recent = items.filter((i) => i.created_at >= since);
  const recentCards = new Set(recent.map((i) => i.card_id));
  const priceOf = new Map(holdings.map((h) => [h.cardId, h.price ?? 0]));
  const entries30 = {
    distinct: recentCards.size,
    copies: recent.reduce((a, i) => a + i.quantity, 0),
    value: recent.reduce((a, i) => a + (priceOf.get(i.card_id) ?? 0) * i.quantity, 0),
  };

  // Por coleção
  const sets = new Map<string, SetSummary & { best: number }>();
  for (const h of holdings) {
    const c = h.item.card;
    const s = sets.get(c.set_id) ?? {
      setId: c.set_id, name: c.set_name, owned: 0, total: c.set_total ?? c.set_official_count ?? null,
      value: 0, cover: null, best: -1,
    };
    s.owned++;
    s.value += (h.price ?? 0) * h.qty;
    const v = h.price ?? 0;
    if (v > s.best && c.image) {
      s.best = v;
      s.cover = c.image;
    }
    sets.set(c.set_id, s);
  }

  return {
    value: round2(value),
    copies: holdings.reduce((a, h) => a + h.qty, 0),
    distinct: holdings.length,
    priced: holdings.filter((h) => h.price !== null).length,
    activeSets: sets.size,
    change30: { delta: round2(now30 - then30), pct: compared ? pct(now30, then30) : null, compared, estimated },
    entries30: { ...entries30, value: round2(entries30.value) },
    sets: [...sets.values()].map(({ best: _b, ...s }) => ({ ...s, value: round2(s.value) })).sort((a, b) => b.value - a.value),
    top: holdings.filter((h) => h.price !== null).sort((a, b) => (b.price ?? 0) * b.qty - (a.price ?? 0) * a.qty),
  };
}

/** Evolução do valor: as cartas que você tem hoje, nos preços de cada dia. */
export function valueSeries(
  holdings: CardHolding[],
  snapsByCard: Map<string, Snapshot[]>,
  mode: RefMode,
  days: number | 'all',
  setId?: string | null,
  today = todayBR(),
): { date: string; value: number }[] {
  const hs = setId ? holdings.filter((h) => h.item.card.set_id === setId) : holdings;
  if (!hs.length) return [];
  let start: string;
  if (days === 'all') {
    const dates = hs.flatMap((h) => (snapsByCard.get(h.cardId) ?? []).map((s) => s.captured_on)).sort();
    start = dates[0] ?? today;
  } else {
    start = minusDays(today, days);
  }
  const out: { date: string; value: number }[] = [];
  // Sem nenhum preço antigo (real ou estimado), mostra só o valor de hoje em vez de uma linha reta inventada
  const hasPast = hs.some((h) => brPriceAt(snapsByCard.get(h.cardId) ?? [], minusDays(today, 1), mode, today) !== null
    && (snapsByCard.get(h.cardId) ?? []).some((s) => s.captured_on < today));
  if (!hasPast) start = today;
  for (let d = start; d <= today; d = minusDays(d, -1)) {
    let v = 0;
    let any = false;
    for (const h of hs) {
      const p = priceForChart(snapsByCard.get(h.cardId) ?? [], d, mode, today);
      if (p !== null) {
        v += p * h.qty;
        any = true;
      }
    }
    if (any) out.push({ date: d, value: round2(v) });
  }
  return out;
}

/** Cartas que mais subiram / caíram no período (em %, com o impacto em R$). */
export function movers(
  holdings: CardHolding[],
  snapsByCard: Map<string, Snapshot[]>,
  mode: RefMode,
  days = 30,
  today = todayBR(),
): { up: Mover[]; down: Mover[] } {
  const list: Mover[] = [];
  const thenDate = minusDays(today, days);
  for (const h of holdings) {
    const snaps = snapsByCard.get(h.cardId) ?? [];
    const now = h.price;
    const then = brPriceAt(snaps, thenDate, mode, today, MAX_AGE_DAYS);
    const p = pct(now, then?.value ?? null);
    if (now === null || then === null || p === null || p === 0) continue;
    list.push({ holding: h, then: then.value, now, pct: p, delta: round2((now - then.value) * h.qty), estimated: then.estimated });
  }
  return {
    up: list.filter((m) => m.pct > 0).sort((a, b) => b.pct - a.pct),
    down: list.filter((m) => m.pct < 0).sort((a, b) => a.pct - b.pct),
  };
}

/** Agrupa a coleção por Pokémon (nº da Pokédex) para a aba Pokédex. */
export function pokedexGroups(holdings: CardHolding[]) {
  const map = new Map<number, { dexId: number; name: string; cards: number; copies: number; image: string | null; value: number }>();
  for (const h of holdings) {
    const dex = h.item.card.dex_id;
    if (!dex) continue;
    const g = map.get(dex) ?? { dexId: dex, name: baseName(h.item.card.name_pt), cards: 0, copies: 0, image: null, value: 0 };
    g.cards++;
    g.copies += h.qty;
    g.value += (h.price ?? 0) * h.qty;
    if (!g.image && h.item.card.image) g.image = h.item.card.image;
    map.set(dex, g);
  }
  return [...map.values()].sort((a, b) => a.dexId - b.dexId);
}

/** "Charizard ex" -> "Charizard", "Pikachu V" -> "Pikachu" */
export function baseName(name: string): string {
  return name.replace(/\s+(ex|EX|GX|V|VMAX|VSTAR|V-ASTRO|LV\.X|δ|☆|BREAK|Prime)$/u, '').replace(/^(Mega |M |Dark |Light )/, '').trim();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export { priceOn };
