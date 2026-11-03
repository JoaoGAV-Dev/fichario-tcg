// Preço rápido e histórico longo.
//  • MYP por coleção: 1 página = 30 cartas com menor preço; a coleção inteira em ~1 s, em paralelo.
//  • TCGplayer: histórico semanal de 1 ano (referência internacional e base da estimativa).
//  • Cotação USD/EUR → BRL para mostrar preço internacional em reais na hora.
import type { DbCard } from '../collection';
import { emitDataChanged, getDb, getMeta, setMeta } from '../db';
import { todayBR, upsertSnapshots } from '../prices';
import { getCardAny } from '../cardinfo';
import { getCard, getSeries } from '../tcgdex';
import { mypSku, parseMypEditionPath, parseMypListing, parseMypSearch, parseTcgHistory, pickMypHit, slugify, type MypListing } from './parsers';

const MYP = 'https://mypcards.com';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 FicharioTCG/1.0';
const html = async (url: string) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

// ------------------------------------------------------------------ cotação
export interface Fx { USD: number; EUR: number; at: string }
let fxMem: Fx | null = null;

export async function getFx(): Promise<Fx | null> {
  if (fxMem && Date.now() - Date.parse(fxMem.at) < 12 * 3600_000) return fxMem;
  try {
    const cached = await getMeta('fx');
    if (cached) {
      const v = JSON.parse(cached) as Fx;
      if (Date.now() - Date.parse(v.at) < 12 * 3600_000) return (fxMem = v);
    }
  } catch {}
  try {
    const j = await (await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL')).json();
    const v: Fx = { USD: Number(j.USDBRL.bid), EUR: Number(j.EURBRL.bid), at: new Date().toISOString() };
    if (v.USD > 0 && v.EUR > 0) {
      await setMeta('fx', JSON.stringify(v));
      return (fxMem = v);
    }
  } catch {}
  try {
    const [u, e] = await Promise.all([
      fetch('https://api.frankfurter.app/latest?from=USD&to=BRL').then((r) => r.json()),
      fetch('https://api.frankfurter.app/latest?from=EUR&to=BRL').then((r) => r.json()),
    ]);
    const v: Fx = { USD: Number(u.rates.BRL), EUR: Number(e.rates.BRL), at: new Date().toISOString() };
    await setMeta('fx', JSON.stringify(v));
    return (fxMem = v);
  } catch {}
  if (fxMem) return fxMem;
  const old = await getMeta('fx').catch(() => null);
  return old ? JSON.parse(old) : null;
}

/** Preço internacional da carta em R$ (Cardmarket ou TCGplayer, o que houver), sem esperar a MYP. */
export async function intlPriceBRL(cardId: string): Promise<{ value: number; label: string } | null> {
  const [card, fx] = await Promise.all([getCardAny(cardId).catch(() => null), getFx()]);
  if (!card?.pricing || !fx) return null;
  const tp = card.pricing.tcgplayer as Record<string, { marketPrice?: number }> | undefined;
  const tpv = tp ? ['normal', 'holofoil', 'reverseHolofoil'].map((k) => tp[k]?.marketPrice).find((v) => v && v > 0) : undefined;
  if (tpv) return { value: Math.round(tpv * fx.USD * 100) / 100, label: 'TCGplayer (EUA)' };
  const cm = card.pricing.cardmarket?.avg ?? card.pricing.cardmarket?.trend;
  if (cm && cm > 0) return { value: Math.round(cm * fx.EUR * 100) / 100, label: 'Cardmarket (Europa)' };
  return null;
}

// ------------------------------------------------------------------ MYP por coleção
const inflight = new Map<string, Promise<number>>();

async function serieNameOf(setId: string): Promise<string | null> {
  const series = await getSeries().catch(() => []);
  return series.find((s) => s.sets.some((x) => x.id === setId))?.name ?? null;
}

/** Descobre o endereço da coleção na MYP (com cache). */
async function mypSlug(card: DbCard): Promise<string | null> {
  const key = `myp_slug:${card.set_id}`;
  const cached = await getMeta(key);
  if (cached) return cached === '-' ? null : cached;
  if (!card.set_abbr) return null;
  const prefix = `pokemon_${card.set_abbr.toLowerCase()}_`;

  const serie = await serieNameOf(card.set_id);
  const guesses = [serie ? slugify(`${serie}: ${card.set_name}`) : null, slugify(card.set_name)].filter(Boolean) as string[];
  for (const g of guesses) {
    try {
      if ((await html(`${MYP}/pokemon/${g}`)).includes(`data-ga-item-id="${prefix}`)) {
        await setMeta(key, g);
        return g;
      }
    } catch {}
  }
  // Plano B: acha um produto da coleção pela busca e lê o "breadcrumb"
  try {
    let path = card.myp_path;
    if (!path && card.set_official_count) {
      const q = `${card.local_id.padStart(3, '0')}/${String(card.set_official_count).padStart(3, '0')}`;
      path = pickMypHit(parseMypSearch(await html(`${MYP}/pokemon?ProdutoSearch%5Bquery%5D=${encodeURIComponent(q)}`)),
        card.set_abbr, card.local_id, card.set_official_count)?.path ?? null;
    }
    if (path) {
      const edition = parseMypEditionPath(await html(`${MYP}${path}`));
      if (edition) {
        const slug = edition.replace('/pokemon/', '');
        await setMeta(key, slug);
        return slug;
      }
    }
  } catch {}
  return null;
}

/**
 * Baixa o menor preço de TODAS as cartas da coleção (uma vez por dia) e grava:
 *  - na tabela myp_set (consulta instantânea no scanner);
 *  - como preço do dia das cartas da coleção que você tem.
 * Devolve quantas cartas leu.
 */
export function refreshMypSet(card: DbCard): Promise<number> {
  const k = card.set_id;
  const running = inflight.get(k);
  if (running) return running;
  const job = (async () => {
    const db = await getDb();
    const today = todayBR();
    const slug = await mypSlug(card);
    if (!slug) return 0;
    const fresh = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM myp_set WHERE slug = ? AND fetched_on = ?', [slug, today]);
    if (fresh && fresh.n > 0) return fresh.n;

    const all: MypListing[] = [];
    for (let page = 1; page <= 40; page += 8) {
      const batch = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => page + i).map((p) =>
        html(`${MYP}/pokemon/${slug}?page=${p}`).then(parseMypListing).catch(() => [])));
      for (const b of batch) all.push(...b);
      if (batch.some((b) => b.length < 30)) break; // última página
    }
    if (!all.length) return 0;

    await db.withTransactionAsync(async () => {
      for (const l of all) {
        await db.runAsync(
          `INSERT INTO myp_set (sku, slug, path, price_min, qty, fetched_on) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (sku) DO UPDATE SET slug = excluded.slug, path = excluded.path, price_min = excluded.price_min,
             qty = excluded.qty, fetched_on = excluded.fetched_on`,
          [l.sku, slug, l.path, l.min, l.qty, today],
        );
      }
    });

    // Preço do dia (menor preço) das cartas desta coleção que você tem, sem sobrescrever o preço completo
    const owned = await db.getAllAsync<DbCard>(
      'SELECT * FROM cards WHERE set_id = ? AND id IN (SELECT DISTINCT card_id FROM items)', [card.set_id]);
    const bySku = new Map(all.map((l) => [l.sku, l]));
    const rows = [];
    for (const c of owned) {
      if (!c.set_abbr) continue;
      const l = bySku.get(mypSku(c.set_abbr, c.local_id, c.set_official_count));
      if (!l || l.min === null) continue;
      if (!c.myp_path) await db.runAsync('UPDATE cards SET myp_path = ? WHERE id = ?', [l.path, c.id]);
      const has = await db.getFirstAsync(
        "SELECT 1 FROM snapshots WHERE card_id = ? AND source = 'myp' AND captured_on = ?", [c.id, today]);
      if (!has) {
        rows.push({
          card_id: c.id, source: 'myp' as const, currency: 'BRL', price_min: l.min, price_avg: null, price_max: null,
          price_last: null, offers: l.qty, url: `${MYP}${l.path}`, raw: { from: 'set' },
        });
      }
    }
    await upsertSnapshots(rows);
    if (rows.length) emitDataChanged();
    return all.length;
  })().finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}

/** Menor preço da MYP já em cache para a carta (até 2 dias), sem rede. */
export async function cachedMypPrice(card: Pick<DbCard, 'set_abbr' | 'local_id' | 'set_official_count'>): Promise<number | null> {
  if (!card.set_abbr) return null;
  const db = await getDb();
  const r = await db.getFirstAsync<{ price_min: number | null; fetched_on: string }>(
    'SELECT price_min, fetched_on FROM myp_set WHERE sku = ?',
    [mypSku(card.set_abbr, card.local_id, card.set_official_count)],
  );
  if (!r || r.price_min === null) return null;
  const age = (Date.parse(todayBR()) - Date.parse(r.fetched_on)) / 86_400_000;
  return age <= 2 ? r.price_min : null;
}

// ------------------------------------------------------------------ TCGplayer (histórico de 1 ano)
const TCG_VARIANT: Record<string, string> = { normal: 'Normal', holo: 'Holofoil', reverse: 'Reverse Holofoil' };

/** Última tentativa (para o diagnóstico). */
export const tcgDebug: { id?: number | null; status?: number | string; result?: number } = {};

async function tcgplayerId(card: DbCard): Promise<number | null> {
  if (card.tcgplayer_id) return card.tcgplayer_id;
  const en = await getCard(card.id, 'en').catch(() => null);
  const tp = en?.pricing?.tcgplayer as Record<string, { productId?: number }> | undefined;
  let id = tp ? ['normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil'].map((k) => tp[k]?.productId).find(Boolean) : undefined;
  if (!id) {
    const detailed = (en as unknown as { variants_detailed?: Array<{ thirdParty?: { tcgplayer?: number } }> })?.variants_detailed;
    id = detailed?.map((v) => v.thirdParty?.tcgplayer).find(Boolean);
  }
  if (!id) return null;
  const db = await getDb();
  await db.runAsync('UPDATE cards SET tcgplayer_id = ? WHERE id = ?', [id, card.id]);
  return id;
}

/** Baixa o histórico semanal de 1 ano (se o que temos tem mais de 6 dias). */
export async function refreshTcgHistory(card: DbCard, variant = 'normal'): Promise<number> {
  const db = await getDb();
  const last = await db.getFirstAsync<{ d: string | null }>(
    `SELECT MAX(captured_on) AS d FROM snapshots WHERE card_id = ? AND source = 'tcgplayer' AND raw LIKE '%"weekly":true%'`, [card.id]);
  if (last?.d && (Date.parse(todayBR()) - Date.parse(last.d)) / 86_400_000 < 6) return 0;
  const id = await tcgplayerId(card);
  tcgDebug.id = id;
  if (!id) return 0;
  const r = await fetch(`https://infinite-api.tcgplayer.com/price/history/${id}/detailed?range=annual`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': UA,
      Origin: 'https://www.tcgplayer.com',
      Referer: `https://www.tcgplayer.com/product/${id}`,
    },
  });
  tcgDebug.status = r.status;
  if (!r.ok) return 0;
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    tcgDebug.status = `${r.status} não-JSON: ${text.slice(0, 60)}`;
    return 0;
  }
  const buckets = parseTcgHistory(json, TCG_VARIANT[variant]);
  tcgDebug.result = buckets.length;
  await upsertSnapshots(buckets.map((b) => ({
    card_id: card.id, source: 'tcgplayer' as const, captured_on: b.date, currency: 'USD',
    price_min: null, price_avg: b.market, price_max: null, price_last: null, offers: null,
    url: `https://www.tcgplayer.com/product/${id}`, raw: { weekly: true },
  })));
  if (buckets.length) emitDataChanged();
  return buckets.length;
}

/** Tudo o que deixa a carta "pronta" logo após ser escaneada (em segundo plano, sem travar a tela). */
export async function warmCard(card: DbCard, variant = 'normal'): Promise<void> {
  await Promise.allSettled([refreshMypSet(card), refreshTcgHistory(card, variant), getFx()]);
}

/**
 * Menor preço da MYP de todas as cartas de uma coleção (baixa a coleção se precisar; 1x por dia).
 * Devolve número da carta → preço. Sem sigla ou sem MYP: mapa vazio.
 */
export async function setPriceMap(
  set: { id: string; name: string; abbr: string | null; official: number },
  localIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!set.abbr || !localIds.length) return out;
  const fake = {
    id: `${set.id}-${localIds[0]}`, set_id: set.id, set_name: set.name, set_abbr: set.abbr,
    set_official_count: set.official || null, local_id: localIds[0], myp_path: null,
  } as unknown as DbCard;
  await refreshMypSet(fake).catch(() => 0);
  const db = await getDb();
  const prefix = `pokemon_${set.abbr.toLowerCase()}_`;
  const rows = await db.getAllAsync<{ sku: string; price_min: number | null; fetched_on: string }>(
    'SELECT sku, price_min, fetched_on FROM myp_set WHERE sku LIKE ?', [`${prefix}%`]);
  const bySku = new Map(rows.filter((r) => r.price_min !== null).map((r) => [r.sku, r.price_min as number]));
  for (const l of localIds) {
    const p = bySku.get(mypSku(set.abbr, l, set.official || null));
    if (p !== undefined) out.set(l, p);
  }
  return out;
}
