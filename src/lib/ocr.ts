// OCR no próprio aparelho (Google ML Kit, via módulo nativo em modules/card-ocr).
// Grátis, offline e rápido o bastante para ler a câmera continuamente.
import { isOcrAvailable, recognizeAsync, type OcrLine } from '../../modules/card-ocr';
import { parseCardFooter, type FooterInfo } from './footer';

export { isOcrAvailable };

const NUMBER = /(?:\b(?:TG|GG|SV|RC|SH)?\d{1,3}\s*[/|\\]\s*(?:TG|GG|SV|RC|SH)?\d{2,3}\b)/i;
const PROMO = /\b(?:SVP|MEP|SWSH|SM|XY|BW)\s*(?:[A-Z]{2}\s*)?\d{2,3}\b/;

/**
 * Das linhas lidas na foto, pega a do número da carta ("125/197") — a mais baixa, porque o
 * rodapé fica embaixo — e junta as linhas vizinhas na mesma altura (sigla "OBF", idioma "PT").
 */
export function footerTextFromLines(lines: OcrLine[]): string | null {
  const hits = lines.filter((l) => NUMBER.test(l.text) || PROMO.test(l.text));
  if (!hits.length) return null;
  const target = hits.reduce((a, b) => (b.y + b.height > a.y + a.height ? b : a));
  const cy = target.y + target.height / 2;
  const tol = Math.max(target.height, 8) * 1.2;
  return lines
    .filter((l) => Math.abs(l.y + l.height / 2 - cy) <= tol)
    .sort((a, b) => a.x - b.x)
    .map((l) => l.text)
    .join(' ');
}

export interface FrameRead {
  footer: string | null;
  info: FooterInfo | null;
}

/** Lê uma foto e devolve o rodapé interpretado (ou null se não achou). */
export async function readCardFooter(photoUri: string): Promise<FrameRead> {
  const res = await recognizeAsync(photoUri);
  const footer = footerTextFromLines(res.lines);
  if (!footer) return { footer: null, info: null };
  const info = parseCardFooter(footer);
  return { footer, info: info.number ? info : null };
}
