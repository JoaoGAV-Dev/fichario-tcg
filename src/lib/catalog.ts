// Catálogo local: todas as cartas em PT (≈14 mil, 1,4 MB) + índice de siglas das coleções.
// Baixado uma vez por semana; deixa o scanner instantâneo e funcionando sem internet.
import { getDb, getMeta, setMeta } from './db';
import { getSeries, getSet, setIdOf, type CardBrief, type SetBrief } from './tcgdex';

const WEEK = 7 * 86_400_000;
const API = 'https://api.tcgdex.net/v2/pt';

/** Normaliza nome para comparar: sem acento, minúsculo, só letras/números. */
export function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface CatalogRow {
  id: string;
  set_id: string;
  local_id: string;
  name: string;
  image: string | null;
}

let catalogJob: Promise<void> | null = null;

export function ensureCatalog(force = false): Promise<void> {
  catalogJob ??= (async () => {
    const at = Number((await getMeta('catalog_at')) ?? 0);
    const db = await getDb();
    const n = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM catalog'))?.n ?? 0;
    if (!force && n > 1000 && Date.now() - at < WEEK) return;
    const res = await fetch(`${API}/cards`);
    if (!res.ok) throw new Error(`catálogo ${res.status}`);
    const list = (await res.json()) as CardBrief[];
    await db.withTransactionAsync(async () => {
      for (const c of list) {
        await db.runAsync(
          `INSERT INTO catalog (id, set_id, local_id, name, name_norm, image) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_norm = excluded.name_norm, image = excluded.image`,
          [c.id, setIdOf(c.id), c.localId, c.name, normName(c.name), c.image ?? null],
        );
      }
    });
    await setMeta('catalog_at', String(Date.now()));
  })().finally(() => {
    catalogJob = null;
  });
  return catalogJob;
}

export interface SetMeta extends SetBrief {
  abbr: string | null;
  order: number; // 0 = mais nova
  serie: string;
}

let setsMem: Map<string, SetMeta> | null = null;
let setsJob: Promise<Map<string, SetMeta>> | null = null;

/** Todas as coleções físicas com a sigla oficial (OBF, POR, MEE…). */
export function setsWithAbbr(): Promise<Map<string, SetMeta>> {
  if (setsMem) return Promise.resolve(setsMem);
  setsJob ??= (async () => {
    try {
      const cached = await getMeta('sets_abbr');
      if (cached) {
        const { at, list } = JSON.parse(cached) as { at: number; list: SetMeta[] };
        if (Date.now() - at < WEEK && list.length) return (setsMem = new Map(list.map((s) => [s.id, s])));
      }
    } catch {}
    const series = await getSeries();
    const flat: SetMeta[] = [];
    let order = 0;
    for (const s of series) for (const set of s.sets) flat.push({ ...set, abbr: null, order: order++, serie: s.name });
    // Detalhes em lotes de 8 (só para pegar a sigla)
    for (let i = 0; i < flat.length; i += 8) {
      await Promise.all(flat.slice(i, i + 8).map(async (s) => {
        try {
          s.abbr = (await getSet(s.id)).abbreviation?.official?.toUpperCase() ?? null;
        } catch {}
      }));
    }
    await setMeta('sets_abbr', JSON.stringify({ at: Date.now(), list: flat }));
    return (setsMem = new Map(flat.map((s) => [s.id, s])));
  })().finally(() => {
    setsJob = null;
  });
  return setsJob;
}

/** Cartas do catálogo por número (aceita "072", "72", "TG05"). */
export async function catalogByNumber(variants: string[]): Promise<CatalogRow[]> {
  const db = await getDb();
  const qs = variants.map(() => '?').join(',');
  return db.getAllAsync<CatalogRow>(`SELECT id, set_id, local_id, name, image FROM catalog WHERE UPPER(local_id) IN (${qs})`,
    variants.map((v) => v.toUpperCase()));
}

/** Cartas do catálogo pelo nome (exato normalizado; se nada, começa-com). */
export async function catalogByName(name: string): Promise<CatalogRow[]> {
  const db = await getDb();
  const n = normName(name);
  if (n.length < 3) return [];
  let rows = await db.getAllAsync<CatalogRow>('SELECT id, set_id, local_id, name, image FROM catalog WHERE name_norm = ?', [n]);
  if (!rows.length) {
    rows = await db.getAllAsync<CatalogRow>('SELECT id, set_id, local_id, name, image FROM catalog WHERE name_norm LIKE ? LIMIT 60', [`${n}%`]);
  }
  return rows;
}

/** Cartas do catálogo pelos ids (na ordem pedida; ids desconhecidos ficam de fora). */
export async function catalogByIds(ids: string[]): Promise<CatalogRow[]> {
  if (!ids.length) return [];
  const db = await getDb();
  const rows = await db.getAllAsync<CatalogRow>(
    `SELECT id, set_id, local_id, name, image FROM catalog WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => by.get(i)).filter((r): r is CatalogRow => !!r);
}
