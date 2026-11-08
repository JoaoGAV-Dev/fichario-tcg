import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ViewProps } from 'react-native';
import { Platform } from 'react-native';

export interface VisionMatch {
  id: string;
  score: number;
}
export type VisionKind = 'cards' | 'sealed';
export interface CardEvent {
  kind?: VisionKind;
  /** Lacrados: idioma lido na embalagem ('PT' | 'EN' | ''). */
  lang?: string;
  /** Cartas: texto lido logo acima da carta (etiqueta de slab PSA/CGC/BGS), se houver. */
  label?: string;
  id: string;
  score: number;
  guide: boolean;
  matches: VisionMatch[];
}
export interface ImageResult {
  id?: string;
  lang?: string;
  score?: number;
  guide?: boolean;
  ms: number;
  candidates?: number;
  quad?: number[];
  matches: VisionMatch[];
}
export interface AnalyzedMatch {
  id: string;
  score: number;
  quad: number[];
  matches: VisionMatch[];
  /** carta: etiqueta do slab; lacrado: idioma ('PT' | 'EN' | '') */
  label?: string;
  lang?: string;
}
export interface AnalyzeResult {
  card: AnalyzedMatch | null;
  sealed: AnalyzedMatch | null;
  /** todo o texto da imagem (OCR) */
  text: string;
  ms: number;
}
export type TrackState = 'searching' | 'tracking' | 'recognized';

interface CardVisionNative {
  isAvailable(): boolean;
  indexInfo(kind?: VisionKind): { ready: boolean; count: number; version: string };
  loadIndexAsync(model: string, emb: string, ids: string, dim: number, version: string, kind?: VisionKind): Promise<number>;
  recognizeImageAsync(uri: string, kind?: VisionKind): Promise<ImageResult>;
  analyzeImageAsync?(uri: string, cardStrong: number, sealedStrong: number): Promise<AnalyzeResult>;
}

// Só existe no APK Android (no Expo Go / iOS cai no OCR antigo).
const Native = Platform.OS === 'android' ? requireOptionalNativeModule<CardVisionNative>('CardVision') : null;

export const isVisionAvailable = (): boolean => {
  try {
    return !!Native?.isAvailable();
  } catch {
    return false;
  }
};

export const indexInfo = (kind: VisionKind = 'cards') => Native?.indexInfo(kind) ?? { ready: false, count: 0, version: '' };

export function loadIndexAsync(model: string, emb: string, ids: string, dim: number, version: string, kind: VisionKind = 'cards') {
  if (!Native) throw new Error('Reconhecimento por imagem indisponível nesta versão');
  return Native.loadIndexAsync(model, emb, ids, dim, version, kind);
}

export function recognizeImageAsync(uri: string, kind: VisionKind = 'cards') {
  if (!Native) throw new Error('Reconhecimento por imagem indisponível nesta versão');
  return Native.recognizeImageAsync(uri, kind);
}

export interface CardScannerProps extends ViewProps {
  active: boolean;
  paused?: boolean;
  mode?: VisionKind;
  zoom?: number;
  torch?: boolean;
  minScore?: number;
  strongScore?: number;
  onCard?: (e: { nativeEvent: CardEvent }) => void;
  onTrack?: (e: { nativeEvent: { state: TrackState } }) => void;
  onCameraReady?: (e: { nativeEvent: { index: boolean } }) => void;
  onCameraError?: (e: { nativeEvent: { message: string } }) => void;
}

export const CardScannerView: React.ComponentType<CardScannerProps> | null = Native
  ? requireNativeView<CardScannerProps>('CardVision')
  : null;

/** Foto ou print: tenta carta (inclusive em slab) e lacrado, e lê o texto da imagem. */
export function analyzeImageAsync(uri: string, cardStrong: number, sealedStrong: number): Promise<AnalyzeResult> {
  if (!Native?.analyzeImageAsync) throw new Error('Atualize o app para conferir preço por foto');
  return Native.analyzeImageAsync(uri, cardStrong, sealedStrong);
}
