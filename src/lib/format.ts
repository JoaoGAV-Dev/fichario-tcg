export function brl(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const [int, dec] = v.toFixed(2).split('.');
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

export function money(v: number | null | undefined, currency: string): string {
  if (currency === 'BRL') return brl(v);
  if (v === null || v === undefined) return '—';
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? 'US$' : currency;
  return `${sym} ${v.toFixed(2).replace('.', ',')}`;
}

export function pctLabel(p: number | null | undefined): string {
  if (p === null || p === undefined) return 'sem histórico';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1).replace('.', ',')}%`;
}

export function dateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
