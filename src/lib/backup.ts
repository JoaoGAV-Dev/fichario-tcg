// Backup da coleção e do histórico de preços (tudo fica só no celular, então é bom exportar às vezes).
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { emitDataChanged, getDb } from './db';
import { todayBR } from './prices';

const TABLES = ['cards', 'items', 'snapshots', 'meta', 'sealed_items'] as const;

export async function exportBackup(): Promise<void> {
  const db = await getDb();
  const data: Record<string, unknown[]> = {};
  for (const t of TABLES) data[t] = await db.getAllAsync(`SELECT * FROM ${t}`);
  const file = new File(Paths.cache, `fichario-backup-${todayBR()}.json`);
  if (file.exists) file.delete();
  file.create();
  await file.write(JSON.stringify({ app: 'fichario-tcg', version: 1, exportedAt: new Date().toISOString(), data }));
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Salvar backup do Fichário' });
}

/** Importa um backup, juntando com o que já existe (o que vier do arquivo prevalece). */
export async function importBackup(): Promise<{ items: number; snapshots: number } | null> {
  const pick = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
  if (pick.canceled || !pick.assets?.[0]) return null;
  const json = JSON.parse(await new File(pick.assets[0].uri).text());
  if (json?.app !== 'fichario-tcg' || !json.data) throw new Error('Arquivo não é um backup do Fichário TCG.');
  const db = await getDb();
  const counts = { items: 0, snapshots: 0 };
  await db.withTransactionAsync(async () => {
    for (const t of TABLES) {
      for (const row of (json.data[t] ?? []) as Record<string, unknown>[]) {
        const cols = Object.keys(row).filter((c) => !((t === 'items' || t === 'sealed_items') && c === 'id'));
        if (!cols.length) continue;
        const sql = `INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
        await db.runAsync(sql, cols.map((c) => row[c] as string | number | null));
        if (t === 'items') counts.items++;
        if (t === 'snapshots') counts.snapshots++;
      }
    }
  });
  emitDataChanged();
  return counts;
}
