import { describe, expect, it } from 'vitest';

import { parseAskPrice, parseGrading, parseTypedPrice, verdict } from '../src/lib/grading';

describe('parseGrading', () => {
  it('etiqueta PSA', () => {
    expect(parseGrading('2023 POKEMON SV 151\nCHARIZARD ex\n#199\nGEM MT 10\n81234567\nPSA')).toMatchObject({ company: 'PSA', grade: 10, label: 'PSA 10' });
    expect(parseGrading('PSA\nMINT 9\nPIKACHU')).toMatchObject({ company: 'PSA', grade: 9 });
  });
  it('CGC e BGS com meia nota', () => {
    expect(parseGrading('CGC\nMINT+ 9.5\nCharizard')).toMatchObject({ company: 'CGC', grade: 9.5, label: 'CGC 9,5' });
    expect(parseGrading('BECKETT GEM MINT 9.5')).toMatchObject({ company: 'BGS', grade: 9.5 });
    expect(parseGrading('Carta graduada CGC 10 Pristine')).toMatchObject({ company: 'CGC', grade: 10 });
  });
  it('título de anúncio', () => {
    expect(parseGrading('Umbreon VMAX 215/203 PSA 10 Evolving Skies')).toMatchObject({ company: 'PSA', grade: 10 });
  });
  it('carta crua não vira graduada', () => {
    expect(parseGrading('Charizard ex 199/165 HP 330 Fraqueza x2')).toBeNull();
    expect(parseGrading('Básico Pikachu 60 PV')).toBeNull();
    expect(parseGrading('')).toBeNull();
    expect(parseGrading('EX 7')).toBeNull();
  });
});

describe('parseAskPrice', () => {
  it('real, ignorando parcela e frete', () => {
    expect(parseAskPrice('12x de R$ 50,00 sem juros\nR$ 549,90\nFrete R$ 20,00', 5)).toEqual({ value: 549.9, from: 'BRL' });
    expect(parseAskPrice('Charizard PSA 10 R$1.250,00', 5)).toEqual({ value: 1250, from: 'BRL' });
    expect(parseAskPrice('R$ 80', 5)).toEqual({ value: 80, from: 'BRL' });
  });
  it('dólar convertido', () => {
    expect(parseAskPrice('Price: $1,200.50', 5)).toEqual({ value: 6002.5, from: 'USD' });
    expect(parseAskPrice('Price: $10', null)).toBeNull();
  });
});

describe('verdict', () => {
  it('faixas', () => {
    expect(verdict(80, 100)?.level).toBe('barato');
    expect(verdict(110, 100)?.level).toBe('justo');
    expect(verdict(130, 100)?.level).toBe('caro');
    expect(verdict(200, 100)?.level).toBe('muito-caro');
    expect(verdict(0, 100)).toBeNull();
  });
  it('preço digitado', () => {
    expect(parseTypedPrice('1.234,56')).toBe(1234.56);
    expect(parseTypedPrice('R$ 80')).toBe(80);
    expect(parseTypedPrice('99.9')).toBe(99.9);
    expect(parseTypedPrice('')).toBeNull();
  });
});
