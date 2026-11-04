// Catálogo de cartas e coleções via TCGdex (gratuito, open source, com português).
// Docs: https://tcgdex.dev
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Lang = 'pt' | 'en' | 'ja' | 'zh-tw';
export const CATALOG_LANG: Lang = 'pt'; // trocar/expandir aqui quando adicionar outros idiomas

const API = 'https://api.tcgdex.net/v2';
const DAY = 24 * 60 * 60 * 1000;

export interface SetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount: { official: number; total: number };
}
export interface Serie {
  id: string;
  name: string;
  logo?: string;
  sets: SetBrief[];
}
export interface CardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}
export interface SetDetail extends SetBrief {
  releaseDate?: string;
  serie: { id: string; name: string };
  abbreviation?: { official?: string };
  cards: CardBrief[];
}
export interface CardDetail extends CardBrief {
  rarity?: string;
  illustrator?: string;
  category?: string;
  set: SetBrief;
  variants?: { normal?: boolean; reverse?: boolean; holo?: boolean; firstEdition?: boolean; wPromo?: boolean };
  pricing?: {
    cardmarket?: { avg?: number; low?: number; trend?: number; avg1?: number; avg7?: number; avg30?: number; unit?: string };
    tcgplayer?: Record<string, any>;
  };
}

// Séries que são do jogo digital (TCG Pocket) e não existem como carta física
const DIGITAL_SERIES = new Set(['tcgp']);

const memory = new Map<string, unknown>();

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = await AsyncStorage.getItem(`tcgdex:${key}`);
    if (raw) {
      const { at, value } = JSON.parse(raw);
      if (Date.now() - at < ttl) {
        memory.set(key, value);
        return value as T;
      }
    }
  } catch {}
  const value = await load();
  memory.set(key, value);
  AsyncStorage.setItem(`tcgdex:${key}`, JSON.stringify({ at: Date.now(), value })).catch(() => {});
  return value;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`TCGdex ${res.status} em ${path}`);
  return res.json();
}

/** Todas as séries físicas com suas coleções, da mais nova para a mais antiga. */
export function getSeries(lang: Lang = CATALOG_LANG): Promise<Serie[]> {
  return cached(`series:${lang}`, 1 * DAY, async () => {
    const list = await get<{ id: string; name: string; logo?: string }[]>(`/${lang}/series`);
    const physical = list.filter((s) => !DIGITAL_SERIES.has(s.id));
    const full = await Promise.all(physical.map((s) => get<Serie>(`/${lang}/series/${s.id}`)));
    return full
      .map((s) => ({ id: s.id, name: s.name, logo: s.logo, sets: [...(s.sets ?? [])].reverse() }))
      .reverse();
  });
}

export function getSet(setId: string, lang: Lang = CATALOG_LANG): Promise<SetDetail> {
  return cached(`set:${lang}:${setId}`, 3 * DAY, () => get<SetDetail>(`/${lang}/sets/${encodeURIComponent(setId)}`));
}

export function getCard(cardId: string, lang: Lang = CATALOG_LANG): Promise<CardDetail> {
  return cached(`card:${lang}:${cardId}`, 1 * DAY, () => get<CardDetail>(`/${lang}/cards/${encodeURIComponent(cardId)}`));
}

/** Busca o card sem cache e sem lançar erro (para descobrir se um id existe). */
export async function tryCard(cardId: string, lang: Lang = CATALOG_LANG): Promise<CardDetail | null> {
  try {
    return await getCard(cardId, lang);
  } catch {
    return null;
  }
}

/** Imagem da carta. Cartas sem scan em PT caem para a imagem em inglês. */
export function cardImage(card: { id: string; image?: string }, quality: 'low' | 'high' = 'low'): string {
  if (card.image) return `${card.image}/${quality}.webp`;
  // id "sv03-125" -> https://assets.tcgdex.net/en/<serie>/<set>/<num> não é derivável sem a série;
  // a tela usa o fallback de "sem imagem" nesse caso.
  return '';
}

export function setLogo(set: { logo?: string; symbol?: string }): string | undefined {
  if (set.logo) return `${set.logo}.webp`;
  if (set.symbol) return `${set.symbol}.webp`;
  return undefined;
}

/** Índice de todas as coleções físicas (id -> coleção + ordem de lançamento, 0 = mais nova). */
export async function setIndex(): Promise<Map<string, SetBrief & { order: number; serie: string }>> {
  const series = await getSeries();
  const map = new Map<string, SetBrief & { order: number; serie: string }>();
  let order = 0;
  for (const s of series) for (const set of s.sets) map.set(set.id, { ...set, order: order++, serie: s.name });
  return map;
}

/** "sv03-125" -> "sv03"; "30th-c-001" -> "30th-c" */
export const setIdOf = (cardId: string) => cardId.slice(0, cardId.lastIndexOf('-'));

/** Busca cartas pelo nome (em português). */
export async function searchCards(name: string, lang: Lang = CATALOG_LANG): Promise<CardBrief[]> {
  const q = name.trim();
  if (q.length < 2) return [];
  return cached(`search:${lang}:${q.toLowerCase()}`, 1 * DAY, () =>
    get<CardBrief[]>(`/${lang}/cards?name=${encodeURIComponent(q)}`),
  );
}

/** Todas as cartas de um Pokémon (pelo número da Pokédex). */
export function cardsByDex(dexId: number, lang: Lang = CATALOG_LANG): Promise<CardBrief[]> {
  return cached(`dex:${lang}:${dexId}`, 3 * DAY, () => get<CardBrief[]>(`/${lang}/cards?dexId=eq:${dexId}`));
}

/** URL da imagem: base do TCGdex (+ /low.webp) ou URL completa (cartas que vêm de outra fonte). */
export function imgUrl(base: string, quality: 'low' | 'high' = 'low'): string {
  if (/\.(png|jpe?g|webp)$/i.test(base)) return quality === 'high' ? base.replace(/\.png$/i, '_hires.png') : base;
  return `${base}/${quality}.webp`;
}
