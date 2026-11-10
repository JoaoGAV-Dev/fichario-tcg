import { describe, expect, it } from 'vitest';

import type { AssessResult } from '../modules/card-vision';
import { centerCap, fmtRatio, preGrade, wearLevel, worthGrading } from '../src/lib/pregrade';

const regions = (over: Record<string, [number, number]> = {}) =>
  ['corner_tl', 'corner_tr', 'corner_br', 'corner_bl', 'edge_left', 'edge_right', 'edge_top', 'edge_bottom'].map((name) => ({
    name, corner: name.startsWith('corner'), mm: over[name]?.[0] ?? 0, count: over[name]?.[1] ?? 0,
  }));

function res(side: 'front' | 'back', p: Partial<AssessResult> = {}): AssessResult {
  return {
    ok: true, side, borders: { left: 3, right: 3, top: 3, bottom: 3 }, lr: 50, tb: 50, colored: true, glare: 0,
    regions: regions(), scratches: 0, cardPx: 2400, aspect: 88 / 63, tilt: 0.01, image: 'file://x.jpg', ms: 100, ...p,
  };
}

describe('centralização', () => {
  it('limites PSA', () => {
    expect(centerCap(54, false)).toBe(10);
    expect(centerCap(58, false)).toBe(9);
    expect(centerCap(64, false)).toBe(8);
    expect(centerCap(74, true)).toBe(10);
    expect(centerCap(80, true)).toBe(9);
    expect(centerCap(95, true)).toBe(3);
    expect(centerCap(null, false)).toBeNull();
    expect(fmtRatio(58.4)).toBe('58/42');
  });
});

describe('preGrade', () => {
  it('carta perfeita', () => {
    const g = preGrade(res('front', { lr: 51, tb: 52 }), res('back'));
    expect(g.cap).toBe(10);
    expect(g.chance10).toBe('boa');
    expect(g.warnings).toEqual([]);
  });
  it('limitada pela centralização da frente', () => {
    const g = preGrade(res('front', { lr: 62, tb: 50 }), res('back'));
    expect(g.cap).toBe(8);
    expect(g.factors.find((f) => f.key === 'center-front')?.detail).toContain('62/38');
  });
  it('desgaste no verso', () => {
    expect(wearLevel(0.3, 1)).toBe('leve');
    expect(wearLevel(0.7, 1)).toBe('visível');
    expect(wearLevel(1.2, 1)).toBe('forte');
    const g = preGrade(res('front'), res('back', { regions: regions({ corner_tl: [0.3, 1] }) }));
    expect(g.cap).toBe(9);
    expect(g.factors.find((f) => f.key === 'corners')?.detail).toContain('canto sup. esquerdo (verso): leve');
    const g2 = preGrade(res('front'), res('back', { regions: regions({ edge_left: [1.5, 2] }) }));
    expect(g2.cap).toBe(6);
  });
  it('frente prateada não conta desgaste; riscos no verso', () => {
    const g = preGrade(res('front', { colored: false, regions: regions({ corner_tl: [2, 3] }) }), res('back', { scratches: 2 }));
    expect(g.factors.find((f) => f.key === 'corners')?.cap).toBe(10);
    expect(g.cap).toBe(8);
  });
  it('avisos de foto e falta do verso', () => {
    const g = preGrade(res('front', { cardPx: 800, glare: 0.05 }), null);
    expect(g.warnings.join(' ')).toContain('chegue mais perto');
    expect(g.warnings.join(' ')).toContain('reflexo');
    expect(g.warnings.join(' ')).toContain('Falta a foto do verso');
    expect(g.chance10).not.toBe('boa');
    const n = preGrade(res('front', { ok: false, error: 'nocard' }), null);
    expect(n.cap).toBeNull();
  });
});

describe('vale a pena', () => {
  it('compara com custo', () => {
    expect(worthGrading(50, 400, 150)?.verdict).toBe('vale');
    expect(worthGrading(50, 210, 150)?.verdict).toBe('empate');
    expect(worthGrading(50, 120, 150)?.verdict).toBe('nao-vale');
    expect(worthGrading(50, 0, 150)).toBeNull();
  });
});
