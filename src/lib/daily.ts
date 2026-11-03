// Coleta diária (ao abrir o app e em segundo plano), da mais rápida para a mais lenta:
//  1. MYP por coleção (menor preço de todas as cartas, poucas requisições)
//  2. MYP carta a carta (preço médio e último vendido)
//  3. Histórico de 1 ano do TCGplayer (só se o que temos tem mais de 6 dias)
import { ownedCards } from './collection';
import { setMeta } from './db';
import { cardsMissingToday, refreshCards } from './prices';
import { getFx, refreshMypSet, refreshTcgHistory } from './sources/fast';

let running: Promise<void> | null = null;

export function runDailyCollection(): Promise<void> {
  running ??= (async () => {
    try {
      const cards = await ownedCards();
      if (!cards.length) return;
      getFx().catch(() => {});
      const bySet = new Map(cards.map((c) => [c.set_id, c]));
      for (const c of bySet.values()) await refreshMypSet(c).catch(() => 0);
      const due = await cardsMissingToday('myp');
      await refreshCards(due);
      for (const c of cards) await refreshTcgHistory(c).catch(() => 0);
      await setMeta('last_auto_refresh', new Date().toISOString());
    } finally {
      running = null;
    }
  })();
  return running;
}
