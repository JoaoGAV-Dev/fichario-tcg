// Banco local (SQLite) — tudo fica no celular, sem servidor.
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

let dbPromise: Promise<SQLiteDatabase> | null = null;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    set_name TEXT NOT NULL,
    set_abbr TEXT,
    set_official_count INTEGER,
    local_id TEXT NOT NULL,
    name_pt TEXT NOT NULL,
    name_en TEXT,
    rarity TEXT,
    image TEXT,
    myp_path TEXT,
    liga_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES cards(id),
    variant TEXT NOT NULL DEFAULT 'normal',
    language TEXT NOT NULL DEFAULT 'pt',
    condition TEXT NOT NULL DEFAULT 'NM',
    quantity INTEGER NOT NULL DEFAULT 1,
    purchase_price REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (card_id, variant, language, condition)
  );
  CREATE INDEX IF NOT EXISTS items_card ON items(card_id);
  CREATE TABLE IF NOT EXISTS snapshots (
    card_id TEXT NOT NULL,
    source TEXT NOT NULL,
    captured_on TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    price_min REAL,
    price_avg REAL,
    price_max REAL,
    price_last REAL,
    offers INTEGER,
    url TEXT,
    raw TEXT,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (card_id, source, captured_on)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `,
  // v2: dados extras da carta para o painel (total da coleção com secretas, nº da Pokédex, variantes)
  `
  ALTER TABLE cards ADD COLUMN set_total INTEGER;
  ALTER TABLE cards ADD COLUMN dex_id INTEGER;
  ALTER TABLE cards ADD COLUMN variants TEXT;
  ALTER TABLE cards ADD COLUMN set_logo TEXT;
  CREATE INDEX IF NOT EXISTS items_created ON items(created_at);
  `,
];

async function open(): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync('fichario.db');
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await db.execAsync(MIGRATIONS[version]);
    version++;
    await db.execAsync(`PRAGMA user_version = ${version}`);
  }
  return db;
}

export function getDb(): Promise<SQLiteDatabase> {
  dbPromise ??= open().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  return r?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

// ---------------------------------------------------------------- avisos de mudança
// Telas se inscrevem para recarregar quando a coleta em segundo plano grava preços novos.
type Listener = () => void;
const listeners = new Set<Listener>();
export function onDataChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitDataChanged() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}
