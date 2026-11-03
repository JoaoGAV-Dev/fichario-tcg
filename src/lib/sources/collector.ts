// Coleta de preços feita pelo próprio celular (MYP + preços internacionais da TCGdex).
// Só usa `fetch`, sem dependências.

import { ligaCardUrl, parseMypProduct, parseMypSearch, pickMypHit } from './parsers';

export type Source = 'liga' | 'myp' | 'cardmarket' | 'tcgplayer';

export interface CardRow {
  id: string;
  set_abbr: string | null;
  set_official_count: number | null;
  local_id: string;
  name_pt: string;
  name_en: string | null;
  myp_path: string | null;
}

export interface SnapshotRow {
  card_id: string;
  source: Source;
  captured_on?: string;
  currency: string;
  price_min: number | null;
  price_avg: number | null;
  price_max: number | null;
  price_last: number | null;
  offers: number | null;
  url: string | null;
  raw: Record<string, unknown> | null;
}

// Navegador Android padrão + identificação do app (uso pessoal, poucas requisições por dia)
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 FicharioTCG/1.0';
const MYP = 'https://mypcards.com';

const r2 = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;

/** Preços internacionais que a TCGdex já entrega de graça (Cardmarket EUR e TCGplayer USD). */
export async function collectTcgdex(card: CardRow): Promise<SnapshotRow[]> {
  const res = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(card.id)}`);
  if (!res.ok) return [];
  const data = await res.json();
  const pricing = data?.pricing ?? {};
  const out: SnapshotRow[] = [];

  const cm = pricing.cardmarket;
  if (cm) {
    out.push({
      card_id: card.id, source: 'cardmarket', currency: cm.unit ?? 'EUR',
      price_min: r2(cm.low), price_avg: r2(cm.avg ?? cm.trend), price_max: null,
      price_last: r2(cm.avg1), offers: null,
      url: cm.idProduct ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` : null,
      raw: { avg1: cm.avg1, avg7: cm.avg7, avg30: cm.avg30, trend: cm.trend, updated: cm.updated },
    });
  }
  const tp = pricing.tcgplayer;
  if (tp) {
    const key = ['normal', 'holofoil', 'reverseHolofoil', '1stEditionHolofoil', 'unlimitedHolofoil']
      .find((k) => tp[k]);
    const v = key ? tp[key] : null;
    if (v) {
      out.push({
        card_id: card.id, source: 'tcgplayer', currency: tp.unit ?? 'USD',
        price_min: r2(v.lowPrice), price_avg: r2(v.marketPrice ?? v.midPrice), price_max: r2(v.highPrice),
        price_last: null, offers: null,
        url: v.productId ? `https://www.tcgplayer.com/product/${v.productId}` : null,
        raw: { variant: key, updated: tp.updated },
      });
    }
  }
  return out;
}

/** Encontra o produto na MYP (busca por "125/197") e lê menor/médio/último preço. */
export async function collectMyp(card: CardRow): Promise<{ snapshot: SnapshotRow; path: string | null }> {
  const empty = (error: string): { snapshot: SnapshotRow; path: string | null } => ({
    path: card.myp_path,
    snapshot: {
      card_id: card.id, source: 'myp', currency: 'BRL', price_min: null, price_avg: null,
      price_max: null, price_last: null, offers: null, url: null, raw: { error },
    },
  });

  try {
    let path = card.myp_path;

    if (!path) {
      const num = card.local_id.padStart(3, '0');
      const queries = card.set_official_count
        ? [`${num}/${String(card.set_official_count).padStart(3, '0')}`, card.name_pt]
        : [card.name_pt, card.name_en ?? ''];
      for (const q of queries.filter(Boolean)) {
        const html = await (await fetch(`${MYP}/pokemon?ProdutoSearch%5Bquery%5D=${encodeURIComponent(q)}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html' },
        })).text();
        const hit = pickMypHit(parseMypSearch(html), card.set_abbr, card.local_id, card.set_official_count);
        if (hit) { path = hit.path; break; }
      }
    }
    if (!path) return empty('produto não encontrado na MYP');

    const res = await fetch(`${MYP}${path}`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) return empty(`MYP respondeu ${res.status}`);
    const html = await res.text();
    if (/cf-chl|challenge-platform|Just a moment/i.test(html) && !/resumo-preco/.test(html)) {
      return empty('MYP pediu verificação anti-robô; tente mais tarde');
    }
    const p = parseMypProduct(html);
    if (p.min === null && p.avg === null) return { ...empty('sem ofertas ou página mudou'), path };

    return {
      path,
      snapshot: {
        card_id: card.id, source: 'myp', currency: 'BRL',
        price_min: p.min, price_avg: p.avg, price_max: null, price_last: p.last, offers: p.offers,
        url: `${MYP}${path}`,
        raw: { tcgplayerBrl: p.tcgplayerBrl, sku: p.sku },
      },
    };
  } catch (e) {
    return empty(String(e));
  }
}

export function ligaUrlFor(card: CardRow): string {
  return ligaCardUrl(card.name_en ?? card.name_pt, card.local_id, card.set_official_count);
}
