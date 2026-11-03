// Preço para o scanner, em etapas:
// 1) na hora: preço salvo hoje, ou a menor oferta da MYP em cache (prévia), ou o internacional convertido;
// 2) ~1 s depois: a página da carta na MYP (preço MÉDIO das ofertas e último vendido) — é o que fica;
// 3) em segundo plano: coleção inteira da MYP (deixa as próximas instantâneas) e o histórico.
import { ensureCard, type Variant } from './collection';
import { getCardSnapshots, refPrice, refreshCards, todayBR, type RefMode, type Snapshot } from './prices';
import { cachedMypPrice, intlPriceBRL, warmCard } from './sources/fast';

/** Rótulo do preço de referência conforme as fontes que existem hoje. */
function labelFor(snaps: Snapshot[], today: string): string {
  const day = snaps.filter((s) => s.captured_on === today);
  const liga = day.some((s) => s.source === 'liga' && s.price_avg !== null);
  const mypAvg = day.some((s) => s.source === 'myp' && s.price_avg !== null);
  if (liga && mypAvg) return 'média Liga + MYP';
  if (liga) return 'médio na Liga';
  if (mypAvg) return 'médio na MYP';
  return 'menor oferta na MYP';
}

export async function quickPrice(
  cardId: string,
  variant: Variant,
  refMode: RefMode,
  put: (price: number | null, label?: string) => void,
): Promise<void> {
  let shown = false;
  const show = (p: number | null, l?: string) => {
    if (p !== null) shown = true;
    put(p, l);
  };
  const today = todayBR();
  const fromSnaps = async () => {
    const snaps = await getCardSnapshots(cardId, 3);
    const p = refPrice(snaps, today, refMode);
    return p === null ? null : { p, label: labelFor(snaps, today) };
  };
  try {
    const card = await ensureCard(cardId);
    // 1) prévia instantânea
    const local = await fromSnaps();
    if (local) show(local.p, local.label);
    else {
      const cached = await cachedMypPrice(card);
      if (cached !== null) show(cached, 'menor oferta na MYP · conferindo…');
      else {
        const intl = await intlPriceBRL(cardId);
        if (intl) show(intl.value, `≈ ${intl.label} · conferindo…`);
      }
    }
    // 2) página da carta na MYP (médio) — só se ainda não temos o médio de hoje
    if (!local || local.label === 'menor oferta na MYP') {
      await refreshCards([card], undefined, 0).catch(() => {});
      const full = await fromSnaps();
      if (full) show(full.p, full.label);
    }
    if (!shown) {
      const intl = await intlPriceBRL(cardId);
      if (intl) show(intl.value, `≈ ${intl.label} (sem oferta no Brasil)`);
      else put(null);
    }
    // 3) segundo plano
    warmCard(card, variant).catch(() => {});
  } catch {
    if (!shown) put(null);
  }
}
