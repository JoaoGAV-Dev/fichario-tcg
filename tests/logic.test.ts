import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
vi.mock('../src/lib/db', () => ({ getDb: async () => ({}), setMeta: async () => {}, emitDataChanged: () => {} }));
vi.mock('../modules/card-ocr', () => ({ isOcrAvailable: () => false, recognizeAsync: async () => ({}) }));

import {
  formatCardNumber, ligaCardUrl, parseBRL, parseLigaText, parseMypProduct, parseMypSearch, pickMypHit,
} from '../src/lib/sources/parsers';
import { localIdVariants, parseCardFooter } from '../src/lib/footer.ts';
import { candidateSets, pickCandidates } from '../src/lib/match.ts';
import { footerTextFromLines } from '../src/lib/ocr.ts';
import {
  cardmarketMonthTrend, changesFor, chartSeries, minusDays, portfolioChanges, priceOn, refPrice, todayBR, type Snapshot,
} from '../src/lib/prices.ts';
import type { SetDetail } from '../src/lib/tcgdex.ts';
import { mypProductHtml, mypSearchHtml } from './fixtures/myp.ts';

describe('parseBRL', () => {
  it('lê formatos brasileiros', () => {
    expect(parseBRL('R$ 2,50')).toBe(2.5);
    expect(parseBRL('R$&nbsp;2.490,00')).toBe(2490);
    expect(parseBRL('R$ 24,61')).toBe(24.61);
    expect(parseBRL('sem preço')).toBeNull();
  });
});

describe('MYP', () => {
  it('acha o produto certo na busca pela sigla e número', () => {
    const hits = parseMypSearch(mypSearchHtml);
    expect(hits.map((h) => h.sku)).toEqual(['pokemon_pps_125/197', 'pokemon_obf_125/197']);
    const hit = pickMypHit(hits, 'OBF', '125', 197);
    expect(hit?.path).toBe('/pokemon/produto/199364/charizard-ex');
  });
  it('sem sigla e com número ambíguo, não chuta', () => {
    expect(pickMypHit(parseMypSearch(mypSearchHtml), null, '125', 197)).toBeNull();
  });
  it('lê menor, médio, último vendido e ofertas da página do produto', () => {
    expect(parseMypProduct(mypProductHtml)).toEqual({
      min: 2.5, avg: 24.61, last: 5, tcgplayerBrl: 29.65, offers: 99, sku: 'pokemon_obf_125/197',
    });
  });
});

describe('Liga', () => {
  it('monta a URL da carta', () => {
    expect(formatCardNumber('6', 165)).toBe('006/165');
    expect(ligaCardUrl('Charizard ex', '006', 165)).toBe(
      'https://www.ligapokemon.com.br/?view=cards/card&card=Charizard%20ex%20(006%2F165)&num=006',
    );
  });
  it('lê preços no formato rótulo + valor', () => {
    expect(parseLigaText('Menor preço R$ 389,90 Preço médio R$ 391,90 Maior preço R$ 399,90')).toEqual({
      min: 389.9, avg: 391.9, max: 399.9,
    });
    expect(parseLigaText('Menor\nR$ 2,00\nMédio\nR$ 5,10\nMaior\nR$ 1.200,00')).toEqual({ min: 2, avg: 5.1, max: 1200 });
  });
  it('lê preços em layout de tabela (rótulos e depois valores)', () => {
    expect(parseLigaText('Menor Médio Maior\nR$ 2,00 R$ 5,10 R$ 12,00')).toEqual({ min: 2, avg: 5.1, max: 12 });
  });
  it('sem preços devolve nulos', () => {
    expect(parseLigaText('Carta não encontrada')).toEqual({ min: null, avg: null, max: null });
  });
});

describe('rodapé da carta (OCR)', () => {
  it('Escarlate e Violeta: sigla + idioma + número', () => {
    const f = parseCardFooter('G OBF PT 125/197');
    expect(f).toMatchObject({ number: '125', total: 197, setCodes: ['OBF'], language: 'PT' });
  });
  it('Megaevolução e ruído de OCR', () => {
    expect(parseCardFooter('MEG PT O86/l32')).toMatchObject({ number: '086', total: 132, setCodes: ['MEG'] });
    expect(parseCardFooter('Illus. 5ban Graphics  OBF PT 125 / 197')).toMatchObject({ number: '125', total: 197 });
  });
  it('Espada e Escudo: só número', () => {
    expect(parseCardFooter('025/202')).toMatchObject({ number: '025', total: 202, setCodes: [] });
  });
  it('galeria de treinador', () => {
    expect(parseCardFooter('TG05/TG30')).toMatchObject({ number: 'TG05', total: 30, totalRaw: 'TG30' });
  });
  it('promos', () => {
    expect(parseCardFooter('SVP PT 074')).toMatchObject({ number: '074', setCodes: ['SVP'] });
    expect(parseCardFooter('SWSH123')).toMatchObject({ number: '123', setCodes: ['SWSH'] });
  });
  it('variações do localId', () => {
    expect(localIdVariants('007')).toEqual(['007', '7', '07']);
  });
});

describe('casamento com o catálogo', () => {
  const set = (id: string, abbr: string, official: number, ids: string[]): SetDetail => ({
    id, name: id, cardCount: { official, total: official + 20 }, serie: { id: 'sv', name: 'sv' },
    abbreviation: { official: abbr }, cards: ids.map((l) => ({ id: `${id}-${l}`, localId: l, name: `c${l}` })),
  });
  const obf = set('sv03', 'OBF', 197, ['124', '125']);
  const pps = set('ppsx', 'PPS', 197, ['125']);

  it('desempata pela sigla', () => {
    const r = pickCandidates(parseCardFooter('OBF PT 125/197'), [pps, obf]);
    expect(r.map((c) => c.card.id)).toEqual(['sv03-125']);
  });
  it('sem sigla, devolve as duas para o usuário escolher', () => {
    expect(pickCandidates(parseCardFooter('125/197'), [pps, obf])).toHaveLength(2);
  });
  it('filtra coleções pelo total impresso', () => {
    const briefs = [obf, set('me01', 'MEG', 132, [])];
    expect(candidateSets(parseCardFooter('086/132'), briefs).map((s) => s.id)).toEqual(['me01']);
  });
});

describe('rodapé a partir das linhas do OCR', () => {
  const L = (text: string, x: number, y: number, h = 20) => ({ text, x, y, width: 100, height: h });
  it('junta sigla, idioma e número que estão na mesma altura', () => {
    const lines = [
      L('Charizard ex', 40, 30, 40), L('330', 400, 30, 40), L('Escuridão Ardente 180+', 40, 500),
      L('125/197', 300, 880), L('OBF', 120, 882), L('PT', 200, 879), L('Illus. 5ban Graphics', 40, 850),
    ];
    expect(footerTextFromLines(lines)).toBe('OBF PT 125/197');
  });
  it('sem número legível, devolve null', () => {
    expect(footerTextFromLines([L('Charizard ex', 0, 0), L('Fraqueza x2', 0, 800)])).toBeNull();
  });
  it('promo sem barra', () => {
    expect(footerTextFromLines([L('SVP PT 074', 10, 900)])).toBe('SVP PT 074');
  });
});

describe('variação de preço', () => {
  const today = '2026-11-02';
  const s = (source: Snapshot['source'], daysAgo: number, avg: number | null, min: number | null = null): Snapshot => ({
    card_id: 'x', source, captured_on: minusDays(today, daysAgo), currency: 'BRL',
    price_min: min, price_avg: avg, price_max: null, price_last: null, offers: null, url: null,
  });
  const snaps = [
    s('liga', 0, 120), s('liga', 31, 100), s('liga', 95, 80), s('liga', 370, 50),
    s('myp', 0, null, 110), s('myp', 30, 90),
  ];

  it('data de hoje no Brasil', () => {
    expect(todayBR(Date.parse('2026-11-03T01:30:00Z'))).toBe('2026-11-02');
  });
  it('pega o último preço até a data', () => {
    expect(priceOn(snaps, 'liga', minusDays(today, 30))).toBe(100);
    expect(priceOn(snaps, 'myp', today)).toBe(110); // MYP sem médio usa o menor
  });
  it('referência média, Liga e MYP', () => {
    expect(refPrice(snaps, today, 'media')).toBe(115);
    expect(refPrice(snaps, today, 'liga')).toBe(120);
    expect(refPrice(snaps, minusDays(today, 200), 'media', 45)).toBeNull();
  });
  it('variação 1/3/6/12 meses', () => {
    const c = changesFor(snaps, 'liga', today);
    // 6 meses: o único preço antigo é de 370 dias atrás (fora da tolerância de 45 dias) -> sem histórico
    expect(c.map((x) => x.pct)).toEqual([20, 50, null, 140]);
    const ref = changesFor(snaps, { ref: 'media' }, today);
    expect(ref[0].pct).toBe(21.1); // 115 vs (100+90)/2=95
  });
  it('série do gráfico e tendência Cardmarket', () => {
    expect(chartSeries(snaps, 'liga', 90, today).map((p) => p.value)).toEqual([100, 100, 120]);
    const cm: Snapshot = { ...s('cardmarket', 0, 4.08), raw: { avg30: 3.4 } };
    expect(cardmarketMonthTrend([cm])).toBe(20);
  });

  it('valor da coleção só compara cartas com preço nas duas pontas', () => {
    const other: Snapshot[] = [s('myp', 0, 10)]; // carta nova: sem preço antigo
    const map = new Map([['x', snaps], ['y', other.map((o) => ({ ...o, card_id: 'y' }))]]);
    const res = portfolioChanges([{ card_id: 'x', quantity: 2 }, { card_id: 'y', quantity: 1 }], map, 'liga', today);
    expect(res[0]).toMatchObject({ key: '1m', valueNow: 240, valueThen: 200, compared: 1, total: 2, pct: 20 });
    expect(res[2]).toMatchObject({ key: '6m', compared: 0, pct: null });
  });
});
