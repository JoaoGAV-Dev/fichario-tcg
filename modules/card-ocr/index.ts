import { requireOptionalNativeModule } from 'expo';

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OcrResult {
  text: string;
  lines: OcrLine[];
  width: number;
  height: number;
}

interface CardOcrNative {
  isAvailable(): boolean;
  recognizeAsync(uri: string): Promise<OcrResult>;
}

// Opcional: no Expo Go o módulo não existe (só no APK compilado).
const Native = requireOptionalNativeModule<CardOcrNative>('CardOcr');

export const isOcrAvailable = (): boolean => !!Native?.isAvailable();

export function recognizeAsync(uri: string): Promise<OcrResult> {
  if (!Native) throw new Error('OCR indisponível nesta versão (use o APK).');
  return Native.recognizeAsync(uri);
}
