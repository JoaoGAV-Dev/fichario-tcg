// Preço quase instantâneo para o scanner:
// 1) preço brasileiro já salvo hoje, 2) menor preço da MYP em cache da coleção, 3) internacional convertido (≈R$).
// Em segundo plano baixa a coleção inteira da MYP (deixa as próximas cartas instantâneas) e o histórico.
import { ensureCard, type Variant } from './collection';
import { getCardSnapshots, refPrice, refreshCards, todayBR, type RefMode } from './prices';
import { cachedMypPrice, intlPriceBRL, warmCard } from './sources/fast';

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
  try {
    const card = await ensureCard(cardId);
    const today = todayBR();
    const local = refPrice(await getCardSnapshots(cardId, 3), today, refMode);
    if (local !== null) show(local, 'Liga/MYP hoje');
    else {
      const cached = await cachedMypPrice(card);
      if (cached !== null) show(cached, 'MYP · menor preço');
      else {
        const intl = await intlPriceBRL(cardId);
        if (intl) show(intl.value, `≈ ${intl.label}`);
      }
    }
    await warmCard(card, variant);
    const after = refPrice(await getCardSnapshots(cardId, 3), today, refMode) ?? (await cachedMypPrice(card));
    if (after !== null) show(after, 'MYP · menor preço');
    else if (!shown) put(null);
    refreshCards([card], undefined, 0).then(async () => {
      const full = refPrice(await getCardSnapshots(cardId, 3), todayBR(), refMode);
      if (full !== null) show(full, 'Liga/MYP · médio');
    }).catch(() => {});
  } catch {
    if (!shown) put(null);
  }
}
