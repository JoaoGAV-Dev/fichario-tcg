// Formatos de exportação (sem dependências do app: testável no Node).
import { strToU8, zipSync } from 'fflate';

export interface ExportRow {
  name: string;
  nameEn: string;
  set: string;
  abbr: string;
  number: string;
  rarity: string;
  variant: string;
  language: string;
  condition: string;
  qty: number;
  price: number | null;
  total: number | null;
  added: string;
}

export const HEADERS = [
  'Carta', 'Nome em inglês', 'Coleção', 'Sigla', 'Número', 'Raridade', 'Versão', 'Idioma', 'Estado',
  'Quantidade', 'Preço unitário (R$)', 'Total (R$)', 'Adicionada em',
];

const cells = (r: ExportRow): (string | number | null)[] => [
  r.name, r.nameEn, r.set, r.abbr, r.number, r.rarity, r.variant, r.language, r.condition, r.qty, r.price, r.total, r.added,
];

/** CSV no padrão brasileiro do Excel: ponto e vírgula, vírgula decimal e BOM (acentos certos). */
export function toCsv(rows: ExportRow[]): string {
  const esc = (v: string | number | null) => {
    if (v === null) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');
    return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return '﻿' + [HEADERS, ...rows.map(cells)].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // remove caracteres de controle inválidos em XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Planilha Excel de verdade (.xlsx): cabeçalho fixo, filtro, R$ formatado e linha de total. */
export function toXlsx(rows: ExportRow[]): Uint8Array {
  const money = new Set([10, 11]);
  const widths = [28, 24, 26, 8, 10, 18, 12, 8, 8, 11, 16, 13, 14];
  const sheetRows: string[] = [];
  const cell = (r: number, c: number, v: string | number | null, style = 0) => {
    const ref = `${colName(c)}${r}`;
    const s = style ? ` s="${style}"` : '';
    if (v === null || v === '') return `<c r="${ref}"${s}/>`;
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  sheetRows.push(`<row r="1">${HEADERS.map((h, c) => cell(1, c, h, 1)).join('')}</row>`);
  rows.forEach((row, i) => {
    const r = i + 2;
    sheetRows.push(`<row r="${r}">${cells(row).map((v, c) => cell(r, c, v, money.has(c) ? 2 : 0)).join('')}</row>`);
  });
  const last = rows.length + 1;
  const tr = last + 1;
  sheetRows.push(`<row r="${tr}">${cell(tr, 0, 'Total', 1)}`
    + `<c r="J${tr}" s="1"><f>SUM(J2:J${last})</f></c><c r="L${tr}" s="3"><f>SUM(L2:L${last})</f></c></row>`);

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
<autoFilter ref="A1:${colName(HEADERS.length - 1)}${last}"/>
</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDE9FE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Coleção" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Coleção'!$A$1:$${colName(HEADERS.length - 1)}$${last}</definedName></definedNames>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
    'xl/styles.xml': strToU8(styles),
  };
  return zipSync(files, { level: 6 });
}

