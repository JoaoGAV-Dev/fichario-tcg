// Interpreta o texto do rodapé da carta (lido por OCR ou digitado).
// Exemplos reais de rodapé:
//   "G OBF PT 125/197"     (Escarlate e Violeta em diante: sigla + idioma + número)
//   "MEG PT 086/132"
//   "025/202"              (Espada e Escudo: só o número, sigla é um símbolo)
//   "TG05/TG30", "GG01/GG70", "SV001/SV122"  (galerias)
//   "SVP PT 074", "SWSH123" (promos)

export interface FooterInfo {
  number: string | null; // "125", "TG05", "074"
  total: number | null; // 197 (só a parte numérica do total)
  totalRaw: string | null; // "197", "TG30"
  setCodes: string[]; // siglas candidatas: ["OBF"]
  language: string | null; // "PT", "EN", ...
}

const LANGS = new Set(['PT', 'EN', 'ES', 'FR', 'DE', 'IT', 'JP', 'JA', 'KO', 'ZH']);
// Palavras/ruídos comuns no rodapé que NÃO são sigla de coleção
const NOISE = new Set([
  'HP', 'PS', 'GX', 'EX', 'LV', 'TM', 'VMAX', 'VSTAR', 'ILLUS', 'POKEMON', 'NINTENDO', 'GAME', 'FREAK',
  'CREATURES', 'INC', 'THE', 'AND', 'COPAG', 'DE', 'DA', 'DO', 'E', 'A', 'O',
]);

/** Corrige confusões típicas de OCR dentro de trechos que deveriam ser números. */
function fixDigits(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');
}

export function parseCardFooter(input: string): FooterInfo {
  const text = input.replace(/\s+/g, ' ').trim();
  const info: FooterInfo = { number: null, total: null, totalRaw: null, setCodes: [], language: null };

  // 1) número/total — aceita prefixo de galeria (TG, GG, SV) e "/" lido como "|" ou "\"
  const slash = /\b((?:TG|GG|SV|RC|SH)\d{1,3}|[\dOoIl|]{1,3})\s*[/|\\]\s*((?:TG|GG|SV|RC|SH)\d{2,3}|[\dOoIl|]{2,3})\b/;
  const m = text.match(slash);
  let rest = text;
  if (m) {
    const a = /^[A-Z]{2}\d/.test(m[1]) ? m[1] : fixDigits(m[1]);
    const b = /^[A-Z]{2}\d/.test(m[2]) ? m[2] : fixDigits(m[2]);
    info.number = /^\d+$/.test(a) ? a.padStart(3, '0') : a;
    info.totalRaw = b;
    const tn = b.match(/\d+/);
    info.total = tn ? Number(tn[0]) : null;
    rest = text.replace(m[0], ' ');
  }

  // 2) siglas: palavras curtas em maiúsculas; promos podem vir coladas ao número ("SWSH123")
  const tokens = rest.toUpperCase().match(/\b[A-Z][A-Z0-9-]{1,7}\b/g) ?? [];
  for (const t of tokens) {
    if (LANGS.has(t)) {
      info.language ??= t;
      continue;
    }
    if (NOISE.has(t) || /^\d+$/.test(t)) continue;
    // promo sem barra: "SVP 074" / "SWSH123"
    if (!info.number) {
      const promo = t.match(/^([A-Z]{2,4})(\d{2,3})$/);
      if (promo) {
        info.setCodes.push(promo[1]);
        info.number = promo[2].padStart(3, '0');
        continue;
      }
    }
    if (/^[A-Z]{2,4}$/.test(t)) {
      if (!info.setCodes.includes(t)) info.setCodes.push(t);
      continue;
    }
    // Sigla com dígito lido no lugar de letra ("P0R" -> "POR", "0BF" -> "OBF")
    if (/^[A-Z0-9]{2,4}$/.test(t) && (t.match(/[A-Z]/g) ?? []).length >= 2) {
      const fixed = t.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
      if (/^[A-Z]{2,4}$/.test(fixed) && !info.setCodes.includes(fixed)) info.setCodes.push(fixed);
    }
  }

  // 3) promo no formato "SVP PT 074": número solto depois da sigla
  if (!info.number && info.setCodes.length) {
    const lone = rest.match(/\b(\d{2,3})\b/);
    if (lone) info.number = lone[1].padStart(3, '0');
  }

  return info;
}

/** TCGdex usa localId sem zeros extras em alguns sets ("1") e com zeros em outros ("001"). */
export function localIdVariants(number: string): string[] {
  if (!/^\d+$/.test(number)) return [number];
  const n = String(Number(number));
  return Array.from(new Set([number, n, n.padStart(2, '0'), n.padStart(3, '0')]));
}
