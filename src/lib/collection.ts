// Coleção guardada no SQLite do celular.
import { emitDataChanged, getDb } from './db';
import type { CardRow } from './sources/collector';
import { getCard, getSet, tryCard } from './tcgdex';

export type Variant = 'normal' | 'holo' | 'reverse' | 'firstEdition' | 'promo';
export type Condition = 'M' | 'NM' | 'SP' | 'MP' | 'HP' | 'D';

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
}

export interface Item {
  id: number;
  card_id: string;
  variant: Variant;
  language: string;
  condition: Condition;
  quantity: number;
  purchase_price: number | null;
  card: DbCard;
}

/** Garante que a carta está salva localmente (nome PT e EN, sigla e total da coleção). */
export async function ensureCard(cardId: string): Promise<DbCard> {
  const db = await getDb();
  const existing = await db.getFirstAsync<DbCard>('SELECT * FROM cards WHERE id = ?', [cardId]);
  if (existing) return existing;

  const pt = await getCard(cardId, 'pt');
  const [set, en] = await Promise.all([getSet(pt.set.id, 'pt'), tryCard(cardId, 'en')]);
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
    image: pt.image ?? null,
    myp_path: null,
    liga_url: null,
  };
  await db.runAsync(
    `INSERT OR IGNORE INTO cards (id, set_id, set_name, set_abbr, set_official_count, local_id, name_pt, name_en, rarity, image)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.set_id, row.set_name, row.set_abbr, row.set_official_count, row.local_id, row.name_pt, row.name_en, row.rarity, row.image],
  );
  return row;
}

export async function addToCollection(
  cardId: string,
  opts: { variant: Variant; condition: Condition; quantity: number; language?: string },
) {
  await ensureCard(cardId);
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO items (card_id, variant, language, condition, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (card_id, variant, language, condition) DO UPDATE SET quantity = quantity + excluded.quantity`,
    [cardId, opts.variant, opts.language ?? 'pt', opts.condition, opts.quantity],
  );
  emitDataChanged();
}

type Joined = Omit<Item, 'card'> & { c_json: string };

function hydrate(rows: Joined[]): Item[] {
  return rows.map(({ c_json, ...it }) => ({ ...it, card: JSON.parse(c_json) as DbCard }));
}

const SELECT_ITEMS = `
  SELECT i.id, i.card_id, i.variant, i.language, i.condition, i.quantity, i.purchase_price,
         json_object('id', c.id, 'set_id', c.set_id, 'set_name', c.set_name, 'set_abbr', c.set_abbr,
                     'set_official_count', c.set_official_count, 'local_id', c.local_id, 'name_pt', c.name_pt,
                     'name_en', c.name_en, 'rarity', c.rarity, 'image', c.image, 'myp_path', c.myp_path,
                     'liga_url', c.liga_url) AS c_json
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
