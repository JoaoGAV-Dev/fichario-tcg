import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';

import { toCsv, toXlsx, type ExportRow } from '../src/lib/export-format';

const rows: ExportRow[] = [
  { name: 'Busca de Energia', nameEn: 'Energy Search', set: 'Heróis Ascendentes', abbr: 'POR', number: '072/088', rarity: 'Comum', variant: 'Normal', language: 'PT', condition: 'NM', qty: 2, price: 0.7, total: 1.4, added: '2026-11-03' },
  { name: 'Charizard "ex" <&>', nameEn: 'Charizard ex', set: 'Obsidiana; Chamas', abbr: 'OBF', number: '125/197', rarity: 'Rara Dupla', variant: 'Holo', language: 'PT', condition: 'NM', qty: 1, price: null, total: null, added: '2026-11-03' },
];

describe('exportação', () => {
  it('CSV no padrão do Excel brasileiro', () => {
    const csv = toCsv(rows);
    expect(csv.startsWith('﻿Carta;')).toBe(true);
    expect(csv).toContain('Busca de Energia;Energy Search;Heróis Ascendentes;POR;072/088;Comum;Normal;PT;NM;2;0,7;1,4;2026-11-03');
    expect(csv).toContain('"Charizard ""ex"" <&>"');
    expect(csv).toContain('"Obsidiana; Chamas"');
  });
  it('XLSX válido com total', () => {
    const files = unzipSync(toXlsx(rows));
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('Charizard &quot;ex&quot; &lt;&amp;&gt;');
    expect(sheet).toContain('<f>SUM(L2:L3)</f>');
  });
});
