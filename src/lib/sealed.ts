// Produtos lacrados (ETB, booster, box, blister, lata…): banco do reconhecimento (release "sealed-db",
// gerado pelo GitHub a partir do catálogo do TCGplayer) e a coleção de lacrados do usuário.
import { Directory, File, Paths } from 'expo-file-system';

import { indexInfo, isVisionAvailable, loadIndexAsync } from '../../modules/card-vision';
import { emitDataChanged, getDb, getMeta, setMeta } from './db';

const BASE = 'https://github.com/JoaoGAV-Dev/fichario-tcg/releases/download/sealed-db/';
const CHECK_EVERY = 12 * 3_600_000;

export type SealedLang = 'EN' | 'PT' | 'JP';
export interface SealedProduct {
  id: string; // en-123456 / jp-123456 (id do TCGplayer)
  name: string;
  lang: 'EN' | 'JP'; // idioma da foto do catálogo (PT usa a mesma arte do EN)
  type: string;
  set: string;
  abbr: string;
  release: string;
  image: string;
  usd: number | null;
}
interface Manifest {
  version: string;
  dim: number;
  files: { model: string; emb: string; ids: string; meta: string };
  thresholds?: { min: number; strong: number };
}
export interface SealedStatus {
  state: 'unavailable' | 'idle' | 'loading' | 'ready' | 'error';
  progress?: number;
  error?: string;
  thresholds: { min: number; strong: number };
}

let status: SealedStatus = { state: isVisionAvailable() ? 'idle' : 'unavailable', thresholds: { min: 0.6, strong: 0.7 } };
const subs = new Set<(s: SealedStatus) => void>();
const set = (p: Partial<SealedStatus>) => {
  status = { ...status, ...p };
  subs.forEach((f) => f(status));
};
export const sealedStatus = () => status;
export function onSealedStatus(f: (s: SealedStatus) => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

let meta: Map<string, SealedProduct> | null = null;
export const sealedProduct = (id: string) => meta?.get(id) ?? null;

const dir = () => new Directory(Paths.document, 'sealed');
const fileFor = (m: Manifest, k: keyof Manifest['files']) => new File(dir(), `${m.version}-${m.files[k]}`);
const KEYS = ['ids', 'meta', 'model', 'emb'] as const;

async function loadMeta(m: Manifest) {
  const text = await fileFor(m, 'meta').text();
  const map = new Map<string, SealedProduct>();
  for (const line of text.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 9) continue;
    map.set(c[0], {
      id: c[0], name: c[1], lang: c[2] === 'JP' ? 'JP' : 'EN', type: c[3], set: c[4], abbr: c[5], release: c[6],
      image: c[7], usd: c[8] ? Number(c[8]) || null : null,
    });
  }
  meta = map;
}

let job: Promise<SealedStatus> | null = null;
/** Baixa (1ª vez ~10 MB) e carrega o banco de lacrados. */
export function ensureSealedIndex(force = false): Promise<SealedStatus> {
  if (!isVisionAvailable()) return Promise.resolve(status);
  job ??= (async () => {
    try {
      const raw = await getMeta('sealed_manifest');
      let local = raw ? (JSON.parse(raw) as Manifest) : null;
      if (local && !KEYS.every((k) => fileFor(local!, k).exists)) local = null;
      let target = local;
      const checked = Number((await getMeta('sealed_checked')) ?? 0);
      if (force || !local || Date.now() - checked > CHECK_EVERY) {
        try {
          const r = await fetch(`${BASE}manifest.json?t=${Date.now()}`);
          if (r.ok) {
            const remote = (await r.json()) as Manifest;
            await setMeta('sealed_checked', String(Date.now()));
            if (!local || remote.version !== local.version) target = remote;
          }
        } catch {}
      }
      if (!target) {
        set({ state: 'error', error: 'Não consegui baixar o banco de lacrados. Confira a internet.' });
        return status;
      }
      const info = indexInfo('sealed');
      if (info.ready && info.version === target.version && meta) {
        set({ state: 'ready', thresholds: target.thresholds ?? status.thresholds });
        return status;
      }
      set({ state: 'loading', progress: 0 });
      if (target !== local) {
        dir().create({ idempotent: true, intermediates: true });
        let i = 0;
        for (const k of KEYS) {
          const dest = fileFor(target, k);
          const part = new File(dir(), `${dest.name}.part`);
          if (part.exists) part.delete();
          await File.downloadFileAsync(BASE + target.files[k], part, { idempotent: true });
          if (dest.exists) dest.delete();
          part.move(dest);
          set({ progress: ++i / KEYS.length });
        }
      }
      await loadIndexAsync(fileFor(target, 'model').uri, fileFor(target, 'emb').uri, fileFor(target, 'ids').uri,
        target.dim, target.version, 'sealed');
      await loadMeta(target);
      await setMeta('sealed_manifest', JSON.stringify(target));
      try {
        for (const f of dir().list()) if (f instanceof File && !f.name.startsWith(`${target.version}-`)) f.delete();
      } catch {}
      set({ state: 'ready', error: undefined, thresholds: target.thresholds ?? status.thresholds });
      return status;
    } catch (e) {
      set({ state: 'error', error: String((e as Error)?.message ?? e).slice(0, 160) });
      return status;
    }
  })().finally(() => {
    job = null;
  });
  return job;
}

// ------------------------------------------------------------------ coleção de lacrados

export interface SealedItem {
  id: number;
  product_id: string;
  name: string;
  lang: SealedLang;
  type: string | null;
  set_name: string | null;
  image: string | null;
  usd: number | null;
  quantity: number;
  created_at: string;
}

export const LANG_LABEL: Record<SealedLang, string> = { PT: 'Português', EN: 'Inglês', JP: 'Japonês' };

export async function addSealed(p: SealedProduct, lang: SealedLang, qty = 1): Promise<number> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sealed_items (product_id, name, lang, type, set_name, image, usd, quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, lang) DO UPDATE SET quantity = quantity + excluded.quantity, usd = excluded.usd`,
    [p.id, p.name, lang, p.type, p.set, p.image, p.usd, qty]);
  const row = await db.getFirstAsync<{ id: number }>('SELECT id FROM sealed_items WHERE product_id = ? AND lang = ?', [p.id, lang]);
  emitDataChanged();
  return row!.id;
}

export async function setSealedQty(id: number, qty: number) {
  const db = await getDb();
  if (qty <= 0) await db.runAsync('DELETE FROM sealed_items WHERE id = ?', [id]);
  else await db.runAsync('UPDATE sealed_items SET quantity = ? WHERE id = ?', [qty, id]);
  emitDataChanged();
}

/** Tira uma unidade (apaga se chegar a zero). */
export async function decSealed(id: number) {
  const db = await getDb();
  const row = await db.getFirstAsync<{ quantity: number }>('SELECT quantity FROM sealed_items WHERE id = ?', [id]);
  await setSealedQty(id, (row?.quantity ?? 1) - 1);
}

export async function listSealed(): Promise<SealedItem[]> {
  const db = await getDb();
  return db.getAllAsync<SealedItem>('SELECT * FROM sealed_items ORDER BY created_at DESC');
}

/** Valor de um lacrado em R$: preço de mercado nos EUA (TCGplayer) convertido. */
export function sealedBRL(usd: number | null, fx: number | null): number | null {
  if (!usd || !fx) return null;
  return Math.round(usd * fx * 100) / 100;
}
