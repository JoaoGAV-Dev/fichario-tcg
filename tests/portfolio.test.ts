import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {} } }));
vi.mock('../src/lib/db', () => ({ getDb: async () => ({}), setMeta: async () => {}, emitDataChanged: () => {} }));

import type { Item } from '../src/lib/collection';
import { baseName, buildDashboard, holdingsOf, movers, pokedexGroups, valueSeries } from '../src/lib/portfolio';
import { minusDays, type Snapshot } from '../src/lib/prices';

const today = '2026-11-03';
const snap = (card: string, source: 'liga' | 'myp', daysAgo: number, avg: number): Snapshot => ({
  card_id: card, source, captured_on: minusDays(today, daysAgo), currency: 'BRL',
  price_min: null, price_avg: avg, price_max: null, price_last: null, offers: null, url: null,
});
const card = (id: string, set: string, extra: Record<string, unknown> = {}) => ({
  id, set_id: set, set_name: set.toUpperCase(), set_abbr: null, set_official_count: 100, local_id: '1',
  name_pt: id, name_en: null, rarity: null, image: `img/${id}`, myp_path: null, liga_url: null, set_total: 120, dex_id: 25, ...extra,
});
const item = (id: number, cardId: string, set: string, qty: number, created: string, extra = {}): Item => ({
  id, card_id: cardId, variant: 'normal', language: 'pt', condition: 'NM', quantity: qty, purchase_price: null,
  created_at: created, card: card(cardId, set, extra),
});

const items = [
  item(1, 'a', 's1', 2, '2026-10-30 12:00:00'),
  item(2, 'b', 's1', 1, '2026-01-01 12:00:00'),
  item(3, 'c', 's2', 1, '2026-11-02 12:00:00', { dex_id: 6, name_pt: 'Charizard ex' }),
];
const snaps = new Map<string, Snapshot[]>([
  ['a', [snap('a', 'liga', 0, 10), snap('a', 'liga', 31, 20)]],
  ['b', [snap('b', 'myp', 0, 30)]],
  ['c', [snap('c', 'liga', 0, 5), snap('c', 'liga', 30, 4)]],
]);

describe('painel', () => {
  const d = buildDashboard(items, snaps, 'liga', today);
  it('valor, cópias e coleções', () => {
    expect(d.value).toBe(2 * 10 + 30 + 5);
    expect(d.copies).toBe(4);
    expect(d.activeSets).toBe(2);
    expect(d.priced).toBe(3);
  });
  it('variação de 30 dias só com cartas comparáveis', () => {
    // a: 20 -> 10 (x2), c: 4 -> 5 ; b sem preço antigo
    expect(d.change30).toEqual({ delta: (20 + 5) - (40 + 4), pct: -43.2, compared: 2, estimated: 0 });
  });
  it('cartas que entraram nos últimos 30 dias', () => {
    expect(d.entries30).toEqual({ distinct: 2, copies: 3, value: 25 });
  });
  it('coleções com capa da mais valiosa', () => {
    expect(d.sets[0]).toMatchObject({ setId: 's1', owned: 2, total: 120, value: 50, cover: 'img/b' });
  });
});

describe('gráfico, movimentações e Pokédex', () => {
  const hs = holdingsOf(items, snaps, 'liga', today);
  it('série usa o primeiro preço conhecido antes da coleta começar', () => {
    const s = valueSeries(hs, snaps, 'liga', 7, null, today);
    expect(s).toHaveLength(8);
    expect(s[s.length - 1].value).toBe(55);
    expect(valueSeries(hs, snaps, 'liga', 7, 's2', today)[0].value).toBe(4);
  });
  it('subiram e caíram', () => {
    const m = movers(hs, snaps, 'liga', 30, today);
    expect(m.down.map((x) => [x.holding.cardId, x.pct, x.delta])).toEqual([['a', -50, -20]]);
    expect(m.up.map((x) => [x.holding.cardId, x.pct])).toEqual([['c', 25]]);
  });
  it('agrupa por Pokémon', () => {
    const g = pokedexGroups(hs);
    expect(g.map((x) => [x.dexId, x.name, x.cards])).toEqual([[6, 'Charizard', 1], [25, 'a', 2]]);
    expect(baseName('Pikachu VMAX')).toBe('Pikachu');
  });
});

import { brPriceAt } from '../src/lib/prices';
import { mypSku, parseMypEditionPath, parseMypListing, parseTcgHistory, slugify } from '../src/lib/sources/parsers';

describe('preço rápido e histórico longo', () => {
  it('estima o preço BR antigo pela tendência do TCGplayer', () => {
    const tcg = (daysAgo: number, v: number): Snapshot => ({ ...snap('x', 'liga', daysAgo, v), source: 'tcgplayer', currency: 'USD' });
    const s = [snap('x', 'liga', 0, 100), tcg(0, 10), tcg(91, 8), tcg(182, 5)];
    expect(brPriceAt(s, minusDays(today, 90), 'liga', today, 45)).toEqual({ value: 80, estimated: true });
    expect(brPriceAt(s, minusDays(today, 180), 'liga', today, 45)).toEqual({ value: 50, estimated: true });
    expect(brPriceAt(s, today, 'liga', today)).toEqual({ value: 100, estimated: false });
    expect(brPriceAt([snap('x', 'liga', 0, 100)], minusDays(today, 90), 'liga', today, 45)).toBeNull();
  });
  it('lê a listagem da coleção na MYP com preço e estoque', () => {
    const html = `<div class="card" data-ga-item-id="pokemon_obf_125/197"><a href="/pokemon/produto/199364/charizard-ex"></a>
      <span class="quantidade-num">219</span><span class="card-preco moeda">
                    R$ 2,50                </span></div>
      <div class="card" data-ga-item-id="pokemon_obf_001/197"><a href="/pokemon/produto/1/oddish"></a><span class="quantidade-num">0</span></div>`;
    expect(parseMypListing(html)).toEqual([
      { sku: 'pokemon_obf_125/197', path: '/pokemon/produto/199364/charizard-ex', qty: 219, min: 2.5 },
      { sku: 'pokemon_obf_001/197', path: '/pokemon/produto/1/oddish', qty: 0, min: null },
    ]);
    expect(mypSku('OBF', '125', 197)).toBe('pokemon_obf_125/197');
  });
  it('monta o endereço da coleção na MYP', () => {
    expect(slugify('Escarlate e Violeta: Obsidiana em Chamas')).toBe('escarlate-e-violeta-obsidiana-em-chamas');
    expect(slugify('Megaevolução: Heróis Excelsos')).toBe('megaevolucao-herois-excelsos');
    expect(parseMypEditionPath('<ul class="breadcrumb"><li><a href="/pokemon">Pokémon</a></li>\n<li><a href="/pokemon/escarlate-e-violeta-obsidiana-em-chamas">x</a></li></ul>'))
      .toBe('/pokemon/escarlate-e-violeta-obsidiana-em-chamas');
  });
  it('escolhe a variante e a condição certas no histórico do TCGplayer', () => {
    const j = { result: [
      { variant: 'Holofoil', condition: 'Lightly Played', totalQuantitySold: '830', buckets: [{ marketPrice: '5.11', bucketStartDate: '2026-11-02' }] },
      { variant: 'Holofoil', condition: 'Near Mint', totalQuantitySold: '300', buckets: [
        { marketPrice: '5.6', bucketStartDate: '2026-11-02' }, { marketPrice: '4.9', bucketStartDate: '2026-10-26' }] },
    ] };
    expect(parseTcgHistory(j, 'Holofoil')).toEqual([{ date: '2026-10-26', market: 4.9 }, { date: '2026-11-02', market: 5.6 }]);
  });
});
