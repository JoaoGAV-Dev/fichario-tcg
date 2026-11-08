// Coleção guardada no SQLite do celular.
import { getCardAny } from './cardinfo';
import { emitDataChanged, getDb } from './db';
import type { CardRow } from './sources/collector';
import { getCard, getSet, tryCard } from './tcgdex';

export type Variant = 'normal' | 'holo' | 'reverse' | 'firstEdition' | 'promo';
/** Estado da carta; graduada usa a nota do slab ("PSA 10", "CGC 9,5"). */
export type Condition = 'M' | 'NM' | 'SP' | 'MP' | 'HP' | 'D' | (string & {});

export const VARIANT_LABEL: Record<Variant, string> = {
  normal: 'Normal', holo: 'Holo', reverse: 'Reverse', firstEdition: '1ª edição', promo: 'Promo',
};
export const CONDITIONS: Condition[] = ['M', 'NM', 'SP', 'MP', 'HP', 'D'];

export interface DbCard extends CardRow {
  set_id: string;
  set_name: string;
  rarity: string | null;
  image: string | null;
  liga_url: string | null;
  set_total?: number | null;
  dex_id?: number | null;
  variants?: string | null; // JSON das variantes da TCGdex
  set_logo?: string | null;
  tcgplayer_id?: number | null;
}

export interface Item {
  id: number;
  card_id: string;
  variant: Variant;
  language: string;
  condition: Condition;
  quantity: number;
  purchase_price: number | null;
  created_at: string;
  card: DbCard;
}

/** Garante que a carta está salva localmente (nome PT e EN, sigla e total da coleção). */
export async function ensureCard(cardId: string): Promise<DbCard> {
  const db = await getDb();
  const existing = await db.getFirstAsync<DbCard>('SELECT * FROM cards WHERE id = ?', [cardId]);
  if (existing && existing.set_total != null) return existing;

  // Cartas que o TCGdex ainda não tem em PT (promos, energias, coleções novas) vêm do catálogo em inglês
  const ptCard = await tryCard(cardId, 'pt');
  const pt = ptCard ?? (await getCardAny(cardId));
  const fallbackSet = { abbreviation: undefined, ...pt.set } as Awaited<ReturnType<typeof getSet>>;
  const [set, en] = await Promise.all([
    (ptCard ? getSet(pt.set.id, 'pt').catch(() => getSet(pt.set.id, 'en')) : getSet(pt.set.id, 'en')).catch(() => fallbackSet),
    ptCard ? tryCard(cardId, 'en') : Promise.resolve(pt),
  ]);
  const row: DbCard = {
    id: pt.id,
    set_id: set.id,
    set_name: set.name,
    set_abbr: set.abbreviation?.official ?? null,
    set_official_count: set.cardCount?.official || null,
    local_id: pt.localId,
    name_pt: pt.name,
    name_en: en?.name ?? null,
    rarity: pt.rarity ?? null,
    image: pt.image ?? en?.image ?? null,
    myp_path: existing?.myp_path ?? null,
    liga_url: existing?.liga_url ?? null,
    set_total: set.cardCount?.total ?? null,
    dex_id: Array.isArray((pt as { dexId?: number[] }).dexId) ? (pt as { dexId?: number[] }).dexId![0] : null,
    variants: pt.variants ? JSON.stringify(pt.variants) : null,
    set_logo: set.logo ?? set.symbol ?? null,
  };
  await db.runAsync(
    `INSERT INTO cards (id, set_id, set_name, set_abbr, set_official_count, local_id, name_pt, name_en, rarity, image,
                        set_total, dex_id, variants, set_logo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET set_total = excluded.set_total, dex_id = excluded.dex_id,
       variants = excluded.variants, set_logo = excluded.set_logo, set_abbr = excluded.set_abbr,
       name_en = COALESCE(cards.name_en, excluded.name_en)`,
    [row.id, row.set_id, row.set_name, row.set_abbr, row.set_official_count, row.local_id, row.name_pt, row.name_en,
      row.rarity, row.image, row.set_total ?? null, row.dex_id ?? null, row.variants ?? null, row.set_logo ?? null],
  );
  return row;
}

/** Variante mais comum da carta (para a adição automática do scanner). */
export function defaultVariant(card: Pick<DbCard, 'variants'>): Variant {
  try {
    const v = card.variants ? JSON.parse(card.variants) : null;
    if (!v || v.normal) return 'normal';
    if (v.holo) return 'holo';
    if (v.reverse) return 'reverse';
  } catch {}
  return 'normal';
}

/** Completa dados de cartas salvas pela versão anterior do app. */
export async function backfillCards(): Promise<void> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM cards WHERE set_total IS NULL LIMIT 200');
  for (const r of rows) {
    try {
      await ensureCard(r.id);
    } catch {}
  }
}

/** Adiciona (ou soma) e devolve o id do item e a quantidade resultante. */
export async function addToCollection(
  cardId: string,
  opts: { variant: Variant; condition: Condition; quantity: number; language?: string },
): Promise<{ itemId: number; quantity: number }> {
  await ensureCard(cardId);
  const db = await getDb();
  const lang = opts.language ?? 'pt';
  await db.runAsync(
    `INSERT INTO items (card_id, variant, language, condition, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (card_id, variant, language, condition) DO UPDATE SET quantity = quantity + excluded.quantity`,
    [cardId, opts.variant, lang, opts.condition, opts.quantity],
  );
  const row = await db.getFirstAsync<{ id: number; quantity: number }>(
    'SELECT id, quantity FROM items WHERE card_id = ? AND variant = ? AND language = ? AND condition = ?',
    [cardId, opts.variant, lang, opts.condition],
  );
  emitDataChanged();
  return { itemId: row!.id, quantity: row!.quantity };
}

export async function getItem(itemId: number): Promise<{ id: number; quantity: number } | null> {
  const db = await getDb();
  return db.getFirstAsync('SELECT id, quantity FROM items WHERE id = ?', [itemId]);
}

type Joined = Omit<Item, 'card'> & { c_json: string };

function hydrate(rows: Joined[]): Item[] {
  return rows.map(({ c_json, ...it }) => ({ ...it, card: JSON.parse(c_json) as DbCard }));
}

const SELECT_ITEMS = `
  SELECT i.id, i.card_id, i.variant, i.language, i.condition, i.quantity, i.purchase_price, i.created_at,
         json_object('id', c.id, 'set_id', c.set_id, 'set_name', c.set_name, 'set_abbr', c.set_abbr,
                     'set_official_count', c.set_official_count, 'local_id', c.local_id, 'name_pt', c.name_pt,
                     'name_en', c.name_en, 'rarity', c.rarity, 'image', c.image, 'myp_path', c.myp_path,
                     'liga_url', c.liga_url, 'set_total', c.set_total, 'dex_id', c.dex_id,
                     'variants', c.variants, 'set_logo', c.set_logo) AS c_json
    FROM items i JOIN cards c ON c.id = i.card_id`;

export async function listCollection(): Promise<Item[]> {
  const db = await getDb();
  return hydrate(await db.getAllAsync<Joined>(`${SELECT_ITEMS} ORDER BY i.created_at DESC`));
}

export async function itemsForCard(cardId: string): Promise<Item[]> {
  const db = await getDb();
  return hydrate(await db.getAllAsync<Joined>(`${SELECT_ITEMS} WHERE i.card_id = ?`, [cardId]));
}

/** Cartas distintas da coleção (para coletar preço). */
export async function ownedCards(): Promise<DbCard[]> {
  const db = await getDb();
  return db.getAllAsync<DbCard>('SELECT * FROM cards WHERE id IN (SELECT DISTINCT card_id FROM items)');
}

export async function setQuantity(itemId: number, quantity: number) {
  const db = await getDb();
  if (quantity <= 0) await db.runAsync('DELETE FROM items WHERE id = ?', [itemId]);
  else await db.runAsync('UPDATE items SET quantity = ? WHERE id = ?', [quantity, itemId]);
  emitDataChanged();
}

/** Ids das cartas que o usuário tem, por coleção (para o progresso X/Y). */
export async function ownedBySet(): Promise<Record<string, Set<string>>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ set_id: string; id: string }>(
    'SELECT DISTINCT c.set_id, c.id FROM items i JOIN cards c ON c.id = i.card_id',
  );
  const map: Record<string, Set<string>> = {};
  for (const r of rows) (map[r.set_id] ??= new Set()).add(r.id);
  return map;
}

export async function updateCardCache(cardId: string, patch: { myp_path?: string; liga_url?: string }) {
  const db = await getDb();
  if (patch.myp_path) await db.runAsync('UPDATE cards SET myp_path = ? WHERE id = ?', [patch.myp_path, cardId]);
  if (patch.liga_url) await db.runAsync('UPDATE cards SET liga_url = ? WHERE id = ?', [patch.liga_url, cardId]);
}

/** Quantas cópias você tem de cada carta da coleção (todas as versões somadas). */
export async function ownedQtyForSet(setId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; qty: number }>(
    'SELECT c.id, SUM(i.quantity) AS qty FROM items i JOIN cards c ON c.id = i.card_id WHERE c.set_id = ? GROUP BY c.id', [setId]);
  return new Map(rows.filter((r) => r.qty > 0).map((r) => [r.id, r.qty]));
}
