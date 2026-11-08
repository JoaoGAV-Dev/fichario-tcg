// Cartas graduadas (slab PSA/CGC/BGS…) e "conferir preço" de anúncio: lê empresa/nota e o preço pedido
// a partir do texto da imagem (OCR), e compara o preço pedido com o de mercado.

export type Grader = 'PSA' | 'CGC' | 'BGS' | 'SGC' | 'TAG' | 'ACE';
export interface Grading {
  company: Grader | null;
  grade: number;
  /** "PSA 10", "CGC 9.5", "Graduada 9" */
  label: string;
}

const COMPANY: [RegExp, Grader][] = [
  [/\bPSA\b/, 'PSA'],
  [/\bCGC\b|\bCSG\b/, 'CGC'],
  [/\bBGS\b|\bBECKETT\b/, 'BGS'],
  [/\bSGC\b/, 'SGC'],
  [/\bTAG\b/, 'TAG'],
  [/\bACE\b(?!\s*SPEC)/, 'ACE'],
];

const GRADE = '(10|[1-9](?:[.,]5)?)(?![\\d/.,])';
// descrição da nota que vem antes do número na etiqueta (PSA: "GEM MT 10", CGC: "PRISTINE 10", "MINT+ 9.5")
const DESC = new RegExp(
  `\\b(?:GEM\\s*-?\\s*M(?:IN)?T|PRISTINE|PERFECT|MINT\\s*\\+?|NM\\s*-?\\s*MT\\s*\\+?|NEAR\\s*MINT\\s*\\+?|NM|EX\\s*-?\\s*MT|EX|VG\\s*-?\\s*EX|VG|GOOD|FAIR|FR|POOR|PR)\\s*${GRADE}`,
);

function norm(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toUpperCase()
    .replace(/[|]/g, ' ');
}

/** Empresa + nota a partir do texto lido (etiqueta do slab ou título do anúncio). null = carta crua. */
export function parseGrading(text: string | undefined | null): Grading | null {
  if (!text) return null;
  const s = norm(text);
  let company: Grader | null = null;
  let grade: number | null = null;
  for (const [re, c] of COMPANY) {
    const m = re.exec(s);
    if (!m) continue;
    company = c;
    // "PSA 10", "CGC 9.5", "BGS: 9,5" (até 3 caracteres entre a empresa e a nota)
    const near = new RegExp(`^[\\s:#-]{0,3}${GRADE}`).exec(s.slice(m.index + m[0].length));
    if (near) grade = Number(near[1].replace(',', '.'));
    break;
  }
  if (grade === null) {
    const d = DESC.exec(s);
    // sem empresa, só aceita a descrição completa de etiqueta (GEM MT / PRISTINE / NM-MT…), não "EX 7"
    if (d && (company || /GEM|PRISTINE|MINT|NM|MT/.test(d[0]))) grade = Number(d[1].replace(',', '.'));
  }
  if (grade === null || grade < 1 || grade > 10) return null;
  return { company, grade, label: `${company ?? 'Graduada'} ${String(grade).replace('.', ',')}` };
}

/** Preço pedido no anúncio (R$, ou US$ convertido). Ignora parcelas ("12x de R$ 50") e frete. */
export function parseAskPrice(text: string | undefined | null, usdBrl: number | null): { value: number; from: 'BRL' | 'USD' } | null {
  if (!text) return null;
  const toNum = (raw: string, br: boolean) => {
    let v = raw.replace(/\s/g, '');
    if (br) v = v.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    else v = v.replace(/,(?=\d{3}(\D|$))/g, '');
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const skip = (before: string) => /(\d\s*x\s*(de)?|parcela|frete|envio|shipping|economize|desconto|off)\s*$/i.test(before);
  const re = /R\s?\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (skip(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    const v = toNum(m[1], true);
    if (v !== null) return { value: v, from: 'BRL' };
  }
  if (usdBrl) {
    const us = /(?:US\s?\$|USD\s?|(?<![R\w])\$)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
    for (let m = us.exec(text); m; m = us.exec(text)) {
      if (skip(text.slice(Math.max(0, m.index - 14), m.index))) continue;
      const v = toNum(m[1], false);
      if (v !== null) return { value: Math.round(v * usdBrl * 100) / 100, from: 'USD' };
    }
  }
  return null;
}

export type VerdictLevel = 'barato' | 'justo' | 'caro' | 'muito-caro';
export interface Verdict {
  level: VerdictLevel;
  /** diferença do pedido para a referência: +0.25 = 25% acima */
  diff: number;
  title: string;
}

/** Compara o preço pedido com a referência de mercado (faixa de ±15% = dentro do esperado). */
export function verdict(asked: number, ref: number): Verdict | null {
  if (!(asked > 0) || !(ref > 0)) return null;
  const diff = asked / ref - 1;
  const pct = `${Math.abs(Math.round(diff * 100))}%`;
  if (diff <= -0.15) return { level: 'barato', diff, title: `Abaixo do mercado (${pct} mais barato)` };
  if (diff < 0.15) return { level: 'justo', diff, title: 'Dentro do esperado' };
  if (diff < 0.5) return { level: 'caro', diff, title: `Acima do mercado (${pct} mais caro)` };
  return { level: 'muito-caro', diff, title: `Bem acima do mercado (${pct} mais caro)` };
}

/** "1.234,56" / "1234.5" / "R$ 80" → número. */
export function parseTypedPrice(s: string): number | null {
  const t = s.replace(/[^\d.,]/g, '');
  if (!t) return null;
  const br = /,\d{1,2}$/.test(t) || /\.\d{3}(\D|$)/.test(t);
  const v = br ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
