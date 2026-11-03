// Exporta a coleção para planilha: Excel (.xlsx) ou CSV (abre no Excel/Google Planilhas).
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { toCsv, toXlsx, type ExportRow } from './export-format';

import { CONDITIONS, VARIANT_LABEL, listCollection, type Item } from './collection';
import { getCollectionSnapshots, refPrice, todayBR, type RefMode } from './prices';

export function toRows(items: Item[], priceOf: (cardId: string) => number | null): ExportRow[] {
  const rows = items.map((it) => {
    const c = it.card;
    const tot = c.set_official_count || c.set_total;
    const price = priceOf(it.card_id);
    return {
      name: c.name_pt,
      nameEn: c.name_en ?? '',
      set: c.set_name,
      abbr: c.set_abbr ?? '',
      number: tot ? `${c.local_id}/${tot}` : c.local_id,
      rarity: c.rarity ?? '',
      variant: VARIANT_LABEL[it.variant] ?? it.variant,
      language: it.language.toUpperCase(),
      condition: CONDITIONS.includes(it.condition) ? it.condition : String(it.condition),
      qty: it.quantity,
      price,
      total: price === null ? null : Math.round(price * it.quantity * 100) / 100,
      added: (it.created_at ?? '').slice(0, 10),
    };
  });
  return rows.sort((a, b) => a.set.localeCompare(b.set) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

export async function exportCollection(format: 'xlsx' | 'csv', mode: RefMode): Promise<number> {
  const items = await listCollection();
  if (!items.length) throw new Error('Sua coleção ainda está vazia.');
  const snaps = await getCollectionSnapshots(30);
  const today = todayBR();
  const rows = toRows(items, (id) => refPrice(snaps.get(id) ?? [], today, mode));
  const file = new File(Paths.cache, `colecao-fichario-${today}.${format}`);
  if (file.exists) file.delete();
  file.create();
  if (format === 'csv') await file.write(toCsv(rows));
  else await file.write(toXlsx(rows));
  await Sharing.shareAsync(file.uri, {
    mimeType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dialogTitle: 'Exportar coleção',
    UTI: format === 'csv' ? 'public.comma-separated-values-text' : 'org.openxmlformats.spreadsheetml.sheet',
  });
  return rows.length;
}
