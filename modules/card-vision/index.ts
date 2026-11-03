import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ViewProps } from 'react-native';
import { Platform } from 'react-native';

export interface VisionMatch {
  id: string;
  score: number;
}
export interface CardEvent {
  id: string;
  score: number;
  guide: boolean;
  matches: VisionMatch[];
}
export interface ImageResult {
  id?: string;
  score?: number;
  guide?: boolean;
  ms: number;
  candidates?: number;
  quad?: number[];
  matches: VisionMatch[];
}
export type TrackState = 'searching' | 'tracking' | 'recognized';

interface CardVisionNative {
  isAvailable(): boolean;
  indexInfo(): { ready: boolean; count: number; version: string };
  loadIndexAsync(model: string, emb: string, ids: string, dim: number, version: string): Promise<number>;
  recognizeImageAsync(uri: string): Promise<ImageResult>;
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

export const indexInfo = () => Native?.indexInfo() ?? { ready: false, count: 0, version: '' };

export function loadIndexAsync(model: string, emb: string, ids: string, dim: number, version: string) {
  if (!Native) throw new Error('Reconhecimento por imagem indisponível nesta versão');
  return Native.loadIndexAsync(model, emb, ids, dim, version);
}

export function recognizeImageAsync(uri: string) {
  if (!Native) throw new Error('Reconhecimento por imagem indisponível nesta versão');
  return Native.recognizeImageAsync(uri);
}

export interface CardScannerProps extends ViewProps {
  active: boolean;
  paused?: boolean;
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
