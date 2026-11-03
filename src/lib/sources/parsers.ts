// Parsers puros (sem dependências) — HTML da MYP, texto da Liga e números em R$.

/** "R$ 2.490,00" | "R$&nbsp;24,61" | "24,61" -> 2490 / 24.61 */
export function parseBRL(text: string | null | undefined): number | null {
  if (!text) return null;
  const clean = text.replace(/&nbsp;| /g, ' ');
  const m = clean.match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '') + '.' + m[2]);
}

/** Número da carta como a MYP/Liga escrevem: "125/197" com zero à esquerda até 3 dígitos. */
export function formatCardNumber(localId: string, officialCount?: number | null): string {
  const n = /^\d+$/.test(localId) ? localId.padStart(3, '0') : localId;
  if (!officialCount) return n;
  const total = String(officialCount).padStart(3, '0');
  return `${n}/${total}`;
}

export interface MypSearchHit {
  sku: string; // pokemon_obf_125/197
  productId: number;
  path: string; // /pokemon/produto/199364/charizard-ex
}

/** Lê a página de busca da MYP e devolve os produtos de carta avulsa (sku "pokemon_..."). */
export function parseMypSearch(html: string): MypSearchHit[] {
  const hits: MypSearchHit[] = [];
  const re = /data-ga-item-id="(pokemon_[^"]+)"[\s\S]*?href="(\/pokemon\/produto\/(\d+)\/[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!hits.some((h) => h.sku === m![1])) {
      hits.push({ sku: m[1], path: m[2], productId: Number(m[3]) });
    }
  }
  return hits;
}

/** Escolhe o produto certo da busca: sigla da coleção + número. */
export function pickMypHit(
  hits: MypSearchHit[],
  setAbbr: string | null | undefined,
  localId: string,
  officialCount?: number | null,
): MypSearchHit | null {
  const num = formatCardNumber(localId, officialCount);
  const numOnly = formatCardNumber(localId);
  if (setAbbr) {
    const abbr = setAbbr.toLowerCase();
    const exact = hits.find((h) => h.sku === `pokemon_${abbr}_${num}`);
    if (exact) return exact;
    const loose = hits.find((h) => h.sku === `pokemon_${abbr}_${numOnly}`);
    if (loose) return loose;
  }
  // Sem sigla: aceita só se houver exatamente um produto com aquele número/total
  const byNum = hits.filter((h) => h.sku.endsWith(`_${num}`));
  return byNum.length === 1 ? byNum[0] : null;
}

export interface MypPrices {
  min: number | null;
  avg: number | null;
  last: number | null;
  tcgplayerBrl: number | null;
  offers: number | null;
  sku: string | null;
}

/** Lê a página do produto da MYP (preço é renderizado no servidor). */
export function parseMypProduct(html: string): MypPrices {
  const menor = html.match(/class="resumo-preco resumo-preco--menor"[^>]*title="([^"]*)"[\s\S]*?<span class="moeda">([^<]*)</);
  const ultimo = html.match(/class="resumo-preco resumo-preco--ultimo"[\s\S]*?<span class="moeda">([^<]*)</);
  const tcg = html.match(/class="resumo-preco resumo-preco--tcg"[\s\S]*?<span class="moeda">([^<]*)</);
  const offers = html.match(/Ofertas\s*<span class="abas-contador">\((\d+)\)/);
  const sku = html.match(/"sku":\s*"([^"]+)"/);
  const avgFromTitle = menor ? menor[1].match(/m[ée]dio\s*(R\$[^"]*)/i) : null;
  return {
    min: menor ? parseBRL(menor[2]) : null,
    avg: avgFromTitle ? parseBRL(avgFromTitle[1]) : null,
    last: ultimo ? parseBRL(ultimo[1]) : null,
    tcgplayerBrl: tcg ? parseBRL(tcg[1]) : null,
    offers: offers ? Number(offers[1]) : null,
    sku: sku ? sku[1] : null,
  };
}

export interface LigaPrices {
  min: number | null;
  avg: number | null;
  max: number | null;
}

/**
 * Extrai menor / médio / maior do TEXTO visível da página de carta da Liga.
 * (A Liga fica atrás do Cloudflare; quem lê a página é o WebView no celular.)
 */
export function parseLigaText(text: string): LigaPrices {
  const t = text.replace(/ /g, ' ');
  const PRICE = String.raw`(R\$\s*[\d.]+,\d{2})`;
  const GAP = String.raw`(?:(?!R\$)[\s\S]){0,40}?`; // até 40 caracteres sem outro "R$" no meio

  // Layout em tabela: "Menor  Médio  Maior" e depois os três valores na mesma ordem
  const table = t.match(
    new RegExp(String.raw`menor\s*(?:pre[cç]o)?\s*\n?\s*(?:pre[cç]o\s*)?m[ée]dio\s*\n?\s*(?:maior)(?:\s*pre[cç]o)?` +
      GAP + PRICE + GAP + PRICE + GAP + PRICE, 'i'),
  );
  if (table) return { min: parseBRL(table[1]), avg: parseBRL(table[2]), max: parseBRL(table[3]) };

  // Layout rótulo + valor: "Menor preço R$ 2,00 ... Preço médio R$ 5,10 ... Maior preço R$ 12,00"
  const grab = (label: string) => {
    const m = t.match(new RegExp(label + GAP + PRICE, 'i'));
    return m ? parseBRL(m[1]) : null;
  };
  return {
    min: grab(String.raw`menor(?:\s+pre[cç]o)?`),
    avg: grab(String.raw`(?:pre[cç]o\s+)?m[ée]dio`),
    max: grab(String.raw`maior(?:\s+pre[cç]o)?`),
  };
}

/** URL da carta na Liga Pokémon (nomes em inglês, número no formato 006/165). */
export function ligaCardUrl(nameEn: string, localId: string, officialCount?: number | null): string {
  const num = formatCardNumber(localId, officialCount);
  const card = `${nameEn} (${num})`;
  const n = formatCardNumber(localId);
  return `https://www.ligapokemon.com.br/?view=cards/card&card=${encodeURIComponent(card)}&num=${encodeURIComponent(n)}`;
}
