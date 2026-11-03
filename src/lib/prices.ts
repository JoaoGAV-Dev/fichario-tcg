// Preços: snapshots diários no SQLite, cálculo das variações e coleta feita pelo celular.
import { emitDataChanged, getDb, setMeta } from './db';
import { collectMyp, collectTcgdex, type CardRow, type SnapshotRow } from './sources/collector';

export type Source = 'liga' | 'myp' | 'cardmarket' | 'tcgplayer';
export type RefMode = 'media' | 'liga' | 'myp';

export interface Snapshot {
  card_id: string;
  source: Source;
  captured_on: string; // YYYY-MM-DD
  currency: string;
  price_min: number | null;
  price_avg: number | null;
  price_max: number | null;
  price_last: number | null;
  offers: number | null;
  url: string | null;
  raw?: Record<string, any> | null;
}

export const PERIODS = [
  { key: '1m', label: '1 mês', days: 30 },
  { key: '3m', label: '3 meses', days: 90 },
  { key: '6m', label: '6 meses', days: 180 },
  { key: '12m', label: '1 ano', days: 365 },
] as const;

// ---------------------------------------------------------------- datas (Brasil, UTC-3)
export function todayBR(now = Date.now()): string {
  return new Date(now - 3 * 3600_000).toISOString().slice(0, 10);
}
export function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- funções puras
/** Valor "representativo" de um snapshot. MYP: médio, ou menor se não houver médio. */
export function snapValue(s: Snapshot): number | null {
  if (s.source === 'myp') return s.price_avg ?? s.price_min;
  return s.price_avg;
}

/** Quanto um preço "de antes" pode ser mais velho que a data-alvo (mesma regra do SQL). */
export const MAX_AGE_DAYS = 45;

/** Último valor da fonte em ou antes da data (opcionalmente, no máximo `maxAge` dias antes). */
export function priceOn(snaps: Snapshot[], source: Source, date: string, maxAge?: number): number | null {
  const floor = maxAge === undefined ? '' : minusDays(date, maxAge);
  let best: Snapshot | null = null;
  for (const s of snaps) {
    if (s.source !== source || s.captured_on > date || s.captured_on < floor || snapValue(s) === null) continue;
    if (!best || s.captured_on > best.captured_on) best = s;
  }
  return best ? snapValue(best) : null;
}

/** Mesma regra da função SQL card_ref_price. */
export function refPrice(snaps: Snapshot[], date: string, mode: RefMode, maxAge?: number): number | null {
  const l = priceOn(snaps, 'liga', date, maxAge);
  const m = priceOn(snaps, 'myp', date, maxAge);
  if (mode === 'liga') return l ?? m;
  if (mode === 'myp') return m ?? l;
  const vals = [l, m].filter((v): v is number => v !== null);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
}

export interface Change {
  key: string;
  label: string;
  days: number;
  now: number | null;
  then: number | null;
  pct: number | null; // null = ainda sem histórico suficiente
}

export function pct(now: number | null, then: number | null): number | null {
  if (now === null || then === null || then === 0) return null;
  return Math.round(((now - then) / then) * 1000) / 10;
}

/** Variação de uma fonte (ou da referência) para 1/3/6/12 meses. */
export function changesFor(
  snaps: Snapshot[],
  pick: Source | { ref: RefMode },
  today = todayBR(),
): Change[] {
  const at = (d: string, maxAge?: number) =>
    typeof pick === 'string' ? priceOn(snaps, pick, d, maxAge) : refPrice(snaps, d, pick.ref, maxAge);
  const now = at(today);
  return PERIODS.map((p) => {
    const then = at(minusDays(today, p.days), MAX_AGE_DAYS);
    return { key: p.key, label: p.label, days: p.days, now, then, pct: pct(now, then) };
  });
}

/** Pontos para o gráfico: um por dia em que houve coleta, dentro da janela. */
export function chartSeries(snaps: Snapshot[], mode: RefMode, days: number, today = todayBR()) {
  const from = minusDays(today, days);
  const dates = Array.from(new Set(snaps.filter((s) => s.captured_on >= from).map((s) => s.captured_on))).sort();
  return dates
    .map((d) => ({ date: d, value: refPrice(snaps, d, mode) }))
    .filter((p): p is { date: string; value: number } => p.value !== null);
}

/** Referência internacional imediata: média Cardmarket de hoje vs. média dos últimos 30 dias. */
export function cardmarketMonthTrend(snaps: Snapshot[]): number | null {
  const last = [...snaps].filter((s) => s.source === 'cardmarket').sort((a, b) => (a.captured_on < b.captured_on ? 1 : -1))[0];
  if (!last?.raw) return null;
  return pct(last.price_avg ?? null, typeof last.raw.avg30 === 'number' ? last.raw.avg30 : null);
}

// ---------------------------------------------------------------- variação da coleção inteira
export interface PortfolioChange {
  key: string;
  label: string;
  days: number;
  valueNow: number;
  valueThen: number;
  compared: number; // cartas com preço nas duas pontas
  total: number;
  pct: number | null;
}

/**
 * Mesma regra que a tela de carta: só entram na comparação as cartas que têm preço hoje E
 * na data antiga (com tolerância de 45 dias), para a variação não ficar inflada.
 */
export function portfolioChanges(
  items: { card_id: string; quantity: number }[],
  snapsByCard: Map<string, Snapshot[]>,
  mode: RefMode,
  today = todayBR(),
): PortfolioChange[] {
  const qty = new Map<string, number>();
  for (const it of items) qty.set(it.card_id, (qty.get(it.card_id) ?? 0) + it.quantity);
  return PERIODS.map((p) => {
    const then = minusDays(today, p.days);
    let valueNow = 0;
    let valueThen = 0;
    let compared = 0;
    for (const [card, q] of qty) {
      const snaps = snapsByCard.get(card) ?? [];
      const n = refPrice(snaps, today, mode);
      const t = refPrice(snaps, then, mode, MAX_AGE_DAYS);
      if (n === null || t === null) continue;
      valueNow += n * q;
      valueThen += t * q;
      compared++;
    }
    return {
      key: p.key, label: p.label, days: p.days, compared, total: qty.size,
      valueNow: Math.round(valueNow * 100) / 100, valueThen: Math.round(valueThen * 100) / 100,
      pct: compared ? pct(valueNow, valueThen) : null,
    };
  });
}

// ---------------------------------------------------------------- acesso a dados (SQLite)
type RawRow = Omit<Snapshot, 'raw'> & { raw: string | null };
const parse = (r: RawRow): Snapshot => ({ ...r, raw: r.raw ? JSON.parse(r.raw) : null });

export async function getCardSnapshots(cardId: string, days = 400): Promise<Snapshot[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<RawRow>(
    'SELECT * FROM snapshots WHERE card_id = ? AND captured_on >= ? ORDER BY captured_on',
    [cardId, minusDays(todayBR(), days)],
  );
  return rows.map(parse);
}

/** Snapshots Liga/MYP de todas as cartas da coleção, agrupados por carta. */
export async function getCollectionSnapshots(days = 400): Promise<Map<string, Snapshot[]>> {
  const db = await getDb();
  const rows = await db.getAllAsync<RawRow>(
    `SELECT * FROM snapshots
      WHERE source IN ('liga','myp') AND captured_on >= ?
        AND card_id IN (SELECT DISTINCT card_id FROM items)`,
    [minusDays(todayBR(), days)],
  );
  const map = new Map<string, Snapshot[]>();
  for (const r of rows) {
    const list = map.get(r.card_id) ?? [];
    list.push(parse(r));
    map.set(r.card_id, list);
  }
  return map;
}

export async function getHistorySince(): Promise<string | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ d: string | null }>(
    "SELECT MIN(captured_on) AS d FROM snapshots WHERE source IN ('liga','myp') AND (price_avg IS NOT NULL OR price_min IS NOT NULL)",
  );
  return r?.d ?? null;
}

export async function upsertSnapshots(rows: SnapshotRow[]) {
  if (!rows.length) return;
  const db = await getDb();
  const today = todayBR();
  for (const r of rows) {
    await db.runAsync(
      `INSERT INTO snapshots (card_id, source, captured_on, currency, price_min, price_avg, price_max, price_last, offers, url, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (card_id, source, captured_on) DO UPDATE SET
         currency = excluded.currency, price_min = excluded.price_min, price_avg = excluded.price_avg,
         price_max = excluded.price_max, price_last = excluded.price_last, offers = excluded.offers,
         url = excluded.url, raw = excluded.raw, captured_at = datetime('now')`,
      [r.card_id, r.source, r.captured_on ?? today, r.currency, r.price_min, r.price_avg, r.price_max,
        r.price_last, r.offers, r.url, r.raw ? JSON.stringify(r.raw) : null],
    );
  }
}

/** Cartas da coleção que ainda não têm preço da fonte hoje. */
export async function cardsMissingToday(source: Source): Promise<(CardRow & { liga_url: string | null })[]> {
  const db = await getDb();
  return db.getAllAsync<CardRow & { liga_url: string | null }>(
    `SELECT c.* FROM cards c
      WHERE c.id IN (SELECT DISTINCT card_id FROM items)
        AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.card_id = c.id AND s.source = ? AND s.captured_on = ?)
      ORDER BY c.updated_at`,
    [source, todayBR()],
  );
}

/** Atualiza MYP + Cardmarket/TCGplayer das cartas indicadas. */
export async function refreshCards(
  cards: CardRow[],
  onProgress?: (done: number, total: number) => void,
  delayMs = 800,
): Promise<{ ok: number; failed: { id: string; reason: string }[] }> {
  const db = await getDb();
  const failed: { id: string; reason: string }[] = [];
  let ok = 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    onProgress?.(i, cards.length);
    const rows: SnapshotRow[] = [];
    try {
      rows.push(...(await collectTcgdex(card)));
    } catch {}
    const myp = await collectMyp(card);
    rows.push(myp.snapshot);
    if (myp.path && myp.path !== card.myp_path) {
      await db.runAsync('UPDATE cards SET myp_path = ? WHERE id = ?', [myp.path, card.id]);
    }
    await upsertSnapshots(rows);
    if (myp.snapshot.raw?.error) failed.push({ id: card.id, reason: String(myp.snapshot.raw.error) });
    else ok++;
    if (i < cards.length - 1) await new Promise((r) => setTimeout(r, delayMs)); // não martelar a MYP
  }
  onProgress?.(cards.length, cards.length);
  if (cards.length) emitDataChanged();
  return { ok, failed };
}

let autoRunning: Promise<unknown> | null = null;

/** Coleta automática do dia (abrir o app e tarefa em segundo plano chamam isto). */
export function refreshDueToday(onProgress?: (done: number, total: number) => void) {
  autoRunning ??= (async () => {
    try {
      const due = await cardsMissingToday('myp');
      const res = await refreshCards(due, onProgress);
      await setMeta('last_auto_refresh', new Date().toISOString());
      return res;
    } finally {
      autoRunning = null;
    }
  })();
  return autoRunning as Promise<{ ok: number; failed: { id: string; reason: string }[] }>;
}

export async function saveLigaSnapshot(
  cardId: string,
  p: { min: number | null; avg: number | null; max: number | null },
  url: string,
) {
  await upsertSnapshots([
    {
      card_id: cardId, source: 'liga', currency: 'BRL',
      price_min: p.min, price_avg: p.avg, price_max: p.max, price_last: null, offers: null, url,
      raw: p.min === null && p.avg === null && p.max === null ? { error: 'sem preço na Liga' } : null,
    },
  ]);
}
