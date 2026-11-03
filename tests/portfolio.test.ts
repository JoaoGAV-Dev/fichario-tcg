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
    expect(d.change30).toEqual({ delta: (20 + 5) - (40 + 4), pct: -43.2, compared: 2 });
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
