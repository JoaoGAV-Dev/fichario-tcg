// Pré-avaliação para graduação (estilo PSA) a partir das medidas da foto (CardGrader.kt).
// Não é a nota: é o TETO provável — o que a centralização e o desgaste visível permitem.
import type { AssessResult } from '../../modules/card-vision';

/** PSA: nota, pior proporção aceita na frente e no verso (lado maior / soma, em %). */
export const PSA_CENTER: [number, number, number][] = [
  [10, 55, 75], [9, 60, 90], [8, 65, 90], [7, 70, 90], [6, 80, 90], [5, 85, 90], [4, 85, 90],
];

export function centerCap(worst: number | null | undefined, back: boolean): number | null {
  if (worst == null) return null;
  for (const [g, f, b] of PSA_CENTER) if (worst <= (back ? b : f) + 0.5) return g;
  return 3;
}

/** 58.3 → "58/42" */
export function fmtRatio(x: number | null | undefined): string {
  if (x == null) return '—';
  const a = Math.round(x);
  return `${a}/${100 - a}`;
}

export type WearLevel = 'ok' | 'leve' | 'visível' | 'forte';
export function wearLevel(mm: number, count: number): WearLevel {
  if (count === 0) return 'ok';
  if (mm >= 1 || count >= 6) return 'forte';
  if (mm >= 0.5 || count >= 3) return 'visível';
  return 'leve';
}

export const REGION_LABEL: Record<string, string> = {
  corner_tl: 'canto sup. esquerdo', corner_tr: 'canto sup. direito', corner_br: 'canto inf. direito', corner_bl: 'canto inf. esquerdo',
  edge_left: 'borda esquerda', edge_right: 'borda direita', edge_top: 'borda de cima', edge_bottom: 'borda de baixo',
};

export interface Factor {
  key: 'center-front' | 'center-back' | 'corners' | 'edges' | 'surface';
  label: string;
  /** nota máxima que esse item permite (null = não deu para avaliar) */
  cap: number | null;
  detail: string;
}
export interface PreGrade {
  /** teto estimado (null se nada deu para avaliar) */
  cap: number | null;
  chance10: 'boa' | 'possível' | 'baixa';
  factors: Factor[];
  warnings: string[];
}

function wearCap(levels: WearLevel[]): number {
  const n = (l: WearLevel) => levels.filter((x) => x === l).length;
  if (n('forte')) return 6;
  if (n('visível') >= 2) return 7;
  if (n('visível') === 1 || n('leve') >= 3) return 8;
  if (n('leve')) return 9;
  return 10;
}

function photoWarnings(r: AssessResult, side: string): string[] {
  const w: string[] = [];
  if (!r.ok) return [`${side}: não achei a carta. Use um fundo liso que contraste com a borda e deixe um espaço em volta.`];
  if (r.cardPx < 1100) w.push(`${side}: chegue mais perto — a carta deve ocupar quase toda a altura da foto.`);
  if (r.tilt > 0.04) w.push(`${side}: o celular estava inclinado; fotografe bem de cima, paralelo à carta.`);
  if (Math.abs(r.aspect / (88 / 63) - 1) > 0.04) w.push(`${side}: a borda achada não parece a da carta inteira — confira na imagem.`);
  if (r.glare > 0.01) w.push(`${side}: tem reflexo de luz na borda; o desgaste pode estar escondido. Tente luz mais difusa.`);
  return w;
}

export function preGrade(front: AssessResult | null, back: AssessResult | null): PreGrade {
  const factors: Factor[] = [];
  const warnings: string[] = [];
  if (front) warnings.push(...photoWarnings(front, 'Frente'));
  if (back) warnings.push(...photoWarnings(back, 'Verso'));

  for (const [r, back_] of [[front, false], [back, true]] as const) {
    if (!r) continue;
    const key = back_ ? 'center-back' : 'center-front';
    const label = back_ ? 'Centralização do verso' : 'Centralização da frente';
    if (!r.ok) {
      factors.push({ key, label, cap: null, detail: 'Carta não encontrada na foto' });
      continue;
    }
    const worst = r.lr != null && r.tb != null ? Math.max(r.lr, r.tb) : r.lr ?? r.tb;
    const cap = centerCap(worst, back_);
    const parts = [`esq./dir. ${fmtRatio(r.lr)}`, `cima/baixo ${fmtRatio(r.tb)}`];
    factors.push({
      key, label, cap,
      detail: worst == null ? 'Não consegui medir a moldura (carta sem borda visível ou foto ruim)' : parts.join(' · '),
    });
  }

  // cantos e bordas: verso sempre; frente só com moldura colorida (na prateada o branco não aparece)
  const usable = [front, back].filter((r): r is AssessResult => !!r?.ok && (r.side === 'back' || r.colored));
  if (usable.length) {
    for (const corner of [true, false]) {
      const regs = usable.flatMap((r) => r.regions.filter((g) => g.corner === corner).map((g) => ({ ...g, side: r.side })));
      const lv = regs.map((g) => wearLevel(g.mm, g.count));
      const bad = regs.map((g, i) => ({ g, l: lv[i] })).filter((x) => x.l !== 'ok')
        .sort((a, b) => b.g.mm - a.g.mm)
        .map((x) => `${REGION_LABEL[x.g.name] ?? x.g.name} (${x.g.side === 'back' ? 'verso' : 'frente'}): ${x.l}`);
      factors.push({
        key: corner ? 'corners' : 'edges',
        label: corner ? 'Cantos' : 'Bordas',
        cap: wearCap(lv),
        detail: bad.length ? bad.slice(0, 3).join(' · ') + (bad.length > 3 ? ` · +${bad.length - 3}` : '') : 'Sem branco visível',
      });
    }
  } else if (front?.ok || back?.ok) {
    factors.push({ key: 'corners', label: 'Cantos e bordas', cap: null, detail: 'Fotografe o verso: na borda prateada o desgaste não aparece' });
  }

  if (back?.ok) {
    const n = back.scratches;
    factors.push({
      key: 'surface', label: 'Superfície (verso)',
      cap: n === 0 ? 10 : n === 1 ? 9 : n <= 3 ? 8 : 7,
      detail: n === 0 ? 'Nenhum risco aparente (confira com luz de lado)' : `${n} possíve${n === 1 ? 'l risco' : 'is riscos'} — confira na imagem`,
    });
  }

  const caps = factors.map((f) => f.cap).filter((c): c is number => c != null);
  const cap = caps.length ? Math.min(...caps) : null;
  const frontWorst = front?.ok ? Math.max(front.lr ?? 100, front.tb ?? 100) : 100;
  const clean = factors.every((f) => f.cap == null || f.cap === 10);
  const chance10 = cap === 10 && clean && frontWorst <= 52.5 && !!back?.ok ? 'boa' : cap === 10 ? 'possível' : 'baixa';
  if (!front) warnings.push('Falta a foto da frente (centralização da frente é a que mais pesa).');
  if (!back) warnings.push('Falta a foto do verso (é no verso azul que o desgaste aparece).');
  return { cap, chance10, factors, warnings };
}

export interface Worth {
  profit: number;
  verdict: 'vale' | 'empate' | 'nao-vale';
  text: string;
}
/** Vale graduar? (preço graduada na nota provável) − (carta crua) − (custo de graduar e envio). */
export function worthGrading(raw: number, graded: number, cost: number): Worth | null {
  if (!(raw >= 0) || !(graded > 0) || !(cost >= 0)) return null;
  const profit = graded - raw - cost;
  const margin = Math.max(20, 0.15 * (raw + cost));
  if (profit > margin) return { profit, verdict: 'vale', text: 'Vale a pena graduar' };
  if (profit > -margin) return { profit, verdict: 'empate', text: 'Fica no zero a zero — só se for para guardar' };
  return { profit, verdict: 'nao-vale', text: 'Não vale a pena graduar' };
}
