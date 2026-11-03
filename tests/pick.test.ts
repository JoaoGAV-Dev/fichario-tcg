import { describe, expect, it } from 'vitest';

import { familyKey } from '../src/lib/pick';

describe('familyKey', () => {
  it('energias básicas de qualquer coleção/idioma', () => {
    for (const n of ['Energia de Escuridão', 'Energia {D} Básica', 'Basic Darkness Energy', 'Darkness Energy', 'Energia Darkness Básica']) {
      expect(familyKey(n)).toBe('energy:dark');
    }
    expect(familyKey('Energia Elétrica')).toBe('energy:lightning');
    expect(familyKey('Energia de Água Básica')).toBe('energy:water');
  });
  it('outras cartas pelo nome', () => {
    expect(familyKey('Busca de Energia')).toBe('busca de energia');
    expect(familyKey('Energia Dupla Turbo')).toBe('energia dupla turbo');
    expect(familyKey('Meowth de Alola')).toBe('meowth de alola');
  });
});
