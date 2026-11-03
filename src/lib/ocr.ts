// Leitura da carta com OCR no aparelho (Google ML Kit, via módulo nativo em modules/card-ocr).
// Dois passes por quadro:
//   1. a carta inteira (recortada do contorno) → nome (letra grande) e rodapé se der;
//   2. só a faixa do rodapé, recortada e AMPLIADA → sigla + número (letra de ~1 mm).
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { isOcrAvailable, recognizeAsync, type OcrLine } from '../../modules/card-ocr';
import { parseCardFooter, type FooterInfo } from './footer';

export { isOcrAvailable };

export interface Rect { originX: number; originY: number; width: number; height: number }

const NUMBER = /(?:\b(?:TG|GG|SV|RC|SH)?[\dOoIl]{1,3}\s*[/|\\]\s*(?:TG|GG|SV|RC|SH)?[\dOoIl]{2,3}\b)/i;
// "MEE PT 007", "SVP 074", "POR PT 072" — sigla (2–4) + idioma opcional + número, sem total
const CODE_NUMBER = /\b[A-Z0-9]{2,4}\s+(?:[A-Z]{2}\s+)?[\dOo]{2,3}\b/;

/**
 * Das linhas lidas, pega a do número da carta (a mais baixa: o rodapé fica embaixo) e junta as
 * vizinhas na mesma altura (sigla, idioma).
 */
export function footerTextFromLines(lines: OcrLine[]): string | null {
  const hits = lines.filter((l) => NUMBER.test(l.text) || CODE_NUMBER.test(l.text));
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

const NOT_NAME = /^(item|treinador|trainer|apoiador|est[aá]dio|ferramenta|pok[eé]mon|b[aá]sico|est[aá]gio\s*\d?|energia\s*b[aá]sica\s*$|energia|evolui de.*|ps|hp|\d+)$/i;

/** Nome da carta: a maior linha de texto no topo (ignora "Item", "TREINADOR", PS…). */
export function cardNameFromLines(lines: OcrLine[], height: number): string | null {
  const top = lines
    .filter((l) => l.y + l.height / 2 < height * 0.22)
    .map((l) => ({ ...l, text: l.text.replace(/\b(PS|HP)\s*\d+.*$/i, '').replace(/\s*(PS|HP)?\s*\d{2,3}\s*$/i, '').replace(/(ex|EX|V|GX)\d{2,3}$/, '$1').trim() }))
    .filter((l) => l.text.length >= 3 && /[a-zà-ú]/i.test(l.text) && !NOT_NAME.test(l.text));
  if (!top.length) return null;
  return top.reduce((a, b) => (b.height > a.height ? b : a)).text;
}

/** Converte o retângulo da tela (contorno) para pixels da foto (a câmera preenche em modo "cover"). */
export function screenRectToPhoto(
  guide: { x: number; y: number; width: number; height: number },
  screen: { width: number; height: number },
  photo: { width: number; height: number },
): Rect {
  const scale = Math.max(screen.width / photo.width, screen.height / photo.height);
  const offX = (photo.width * scale - screen.width) / 2;
  const offY = (photo.height * scale - screen.height) / 2;
  const x = Math.max(0, (guide.x + offX) / scale);
  const y = Math.max(0, (guide.y + offY) / scale);
  return {
    originX: Math.round(x),
    originY: Math.round(y),
    width: Math.round(Math.min(guide.width / scale, photo.width - x)),
    height: Math.round(Math.min(guide.height / scale, photo.height - y)),
  };
}

/** Faixa do rodapé: últimos 22% do contorno + um pouco abaixo (a carta costuma ficar mais baixa). */
export function footerBand(card: Rect, photoHeight: number): Rect {
  const top = card.originY + Math.round(card.height * 0.78);
  const bottom = Math.min(photoHeight, card.originY + card.height + Math.round(card.height * 0.04));
  return { originX: card.originX, originY: top, width: card.width, height: Math.max(8, bottom - top) };
}

async function ocrCrop(photoUri: string, rect: Rect, width: number) {
  const img = await ImageManipulator.manipulate(photoUri).crop(rect).resize({ width }).renderAsync();
  const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 });
  try {
    return await recognizeAsync(out.uri);
  } finally {
    try {
      new File(out.uri).delete();
    } catch {}
  }
}

export interface CardRead {
  name: string | null;
  footer: string | null;
  info: FooterInfo | null; // rodapé interpretado (null se não leu número)
}

const complete = (i: FooterInfo | null) => !!i?.number && (i.setCodes.length > 0 || i.total !== null);

export async function readCard(photoUri: string, card: Rect, photoHeight: number): Promise<CardRead> {
  // Passe 1: carta inteira
  const a = await ocrCrop(photoUri, card, 1400);
  const name = cardNameFromLines(a.lines, a.height);
  const bottomLines = a.lines.filter((l) => l.y > a.height * 0.7);
  let footer = footerTextFromLines(bottomLines);
  let info = footer ? parseCardFooter(footer) : null;
  if (info && !info.number) info = null;

  // Passe 2: rodapé ampliado (só se o 1º não leu sigla/total)
  if (!complete(info)) {
    const b = await ocrCrop(photoUri, footerBand(card, photoHeight), 2000);
    const f2 = footerTextFromLines(b.lines);
    const i2 = f2 ? parseCardFooter(f2) : null;
    if (i2?.number && (complete(i2) || !info)) {
      footer = f2;
      info = i2;
    }
  }
  return { name, footer, info };
}
