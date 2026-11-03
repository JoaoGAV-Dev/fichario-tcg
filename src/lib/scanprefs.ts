// Preferências do scanner (ficam em Ajustes para a tela de escanear ficar limpa).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export type ScanMode = 'auto' | 'consulta';
export type VariantPref = 'auto' | 'normal' | 'holo' | 'reverse';
export interface ScanPrefs {
  mode: ScanMode;
  variant: VariantPref;
}
export const VARIANT_PREFS: VariantPref[] = ['auto', 'normal', 'holo', 'reverse'];
export const PREF_LABEL: Record<VariantPref, string> = { auto: 'Automática', normal: 'Normal', holo: 'Holo', reverse: 'Reverse' };

let prefs: ScanPrefs = { mode: 'auto', variant: 'auto' };
let loaded = false;
const subs = new Set<(p: ScanPrefs) => void>();

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const [[, m], [, v]] = await AsyncStorage.multiGet(['scanMode', 'scanVariant']);
    prefs = {
      mode: m === 'consulta' ? 'consulta' : 'auto',
      variant: v && (VARIANT_PREFS as string[]).includes(v) ? (v as VariantPref) : 'auto',
    };
    subs.forEach((f) => f(prefs));
  } catch {}
}

export const scanPrefs = () => prefs;

export function setScanPrefs(p: Partial<ScanPrefs>) {
  prefs = { ...prefs, ...p };
  AsyncStorage.multiSet([['scanMode', prefs.mode], ['scanVariant', prefs.variant]]).catch(() => {});
  subs.forEach((f) => f(prefs));
}

export function useScanPrefs(): ScanPrefs {
  const [p, setP] = useState(prefs);
  useEffect(() => {
    subs.add(setP);
    load();
    setP(prefs);
    return () => {
      subs.delete(setP);
    };
  }, []);
  return p;
}
