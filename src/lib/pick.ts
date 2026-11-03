// "Mesma carta" para desempate do scanner: mesmo nome, ou a mesma energia básica em qualquer
// coleção/idioma ("Energia de Escuridão", "Energia {D} Básica", "Basic Darkness Energy" → energy:dark).
const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ENERGY_TYPES: Record<string, string[]> = {
  dark: ['escuridao', 'darkness', 'd'], water: ['agua', 'water', 'w'], fire: ['fogo', 'fire', 'r'],
  grass: ['planta', 'grama', 'grass', 'g'], lightning: ['eletrica', 'eletrico', 'lightning', 'raio', 'raios', 'l'],
  psychic: ['psiquica', 'psiquico', 'psychic', 'p'], fighting: ['luta', 'fighting', 'f'],
  metal: ['metal', 'metalica', 'm'], fairy: ['fada', 'fairy', 'y'],
};
const FILLER = new Set(['energia', 'energy', 'basica', 'basico', 'basic', 'de', 'da', 'do']);

export function familyKey(name: string): string {
  const n = norm(name);
  if (/\b(energia|energy)\b/.test(n)) {
    const rest = n.split(' ').filter((w) => w && !FILLER.has(w));
    if (rest.length === 1) {
      for (const [k, words] of Object.entries(ENERGY_TYPES)) if (words.includes(rest[0])) return `energy:${k}`;
    }
  }
  return n;
}
