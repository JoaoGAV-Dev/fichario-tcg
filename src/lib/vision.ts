// Banco do reconhecimento por imagem: o GitHub gera (workflow "Banco de cartas") e publica na
// release "cards-db"; aqui o app baixa uma vez (~10–20 MB), guarda e carrega no módulo nativo.
// Depois disso o reconhecimento funciona sem internet.
import { Directory, File, Paths } from 'expo-file-system';

import { indexInfo, isVisionAvailable, loadIndexAsync } from '../../modules/card-vision';
import { getMeta, setMeta } from './db';

const BASE = 'https://github.com/JoaoGAV-Dev/fichario-tcg/releases/download/cards-db/';
const DAY = 86_400_000;

export interface VisionManifest {
  version: string;
  count: number;
  dim: number;
  files: { model: string; emb: string; ids: string };
  thresholds?: { min: number; strong: number };
}

export interface VisionStatus {
  state: 'unavailable' | 'idle' | 'checking' | 'downloading' | 'loading' | 'ready' | 'error';
  progress?: number; // 0..1 durante o download
  count?: number;
  version?: string;
  error?: string;
  thresholds: { min: number; strong: number };
}

const DEFAULT_T = { min: 0.8, strong: 0.9 };
let status: VisionStatus = { state: isVisionAvailable() ? 'idle' : 'unavailable', thresholds: DEFAULT_T };
const listeners = new Set<(s: VisionStatus) => void>();

function set(s: Partial<VisionStatus>) {
  status = { ...status, ...s };
  listeners.forEach((fn) => fn(status));
}
export const visionStatus = () => status;
export function onVisionStatus(fn: (s: VisionStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const dir = () => new Directory(Paths.document, 'vision');
const fileFor = (m: VisionManifest, key: keyof VisionManifest['files']) => new File(dir(), `${m.version}-${m.files[key]}`);

async function fetchManifest(): Promise<VisionManifest | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${BASE}manifest.json?t=${Date.now()}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as VisionManifest;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let job: Promise<VisionStatus> | null = null;

/** Garante o banco carregado (baixa/atualiza se preciso). Pode chamar várias vezes. */
export function ensureVisionIndex(force = false): Promise<VisionStatus> {
  if (!isVisionAvailable()) return Promise.resolve(status);
  job ??= (async () => {
    try {
      const localRaw = await getMeta('vision_manifest');
      let local = localRaw ? (JSON.parse(localRaw) as VisionManifest) : null;
      const haveLocal = !!local && (['model', 'emb', 'ids'] as const).every((k) => fileFor(local!, k).exists);
      if (!haveLocal) local = null;

      // Procura versão nova no máximo 1x por dia (ou sempre, se não houver nada salvo)
      const checkedAt = Number((await getMeta('vision_checked')) ?? 0);
      let target = local;
      if (force || !local || Date.now() - checkedAt > DAY) {
        set({ state: 'checking' });
        const remote = await fetchManifest();
        if (remote) {
          await setMeta('vision_checked', String(Date.now()));
          if (!local || remote.version !== local.version) target = remote;
        } else if (!local) {
          set({ state: 'error', error: 'Não consegui baixar o banco de cartas. Confira a internet (só precisa na 1ª vez).' });
          return status;
        }
      }
      if (!target) return status;

      const info = indexInfo();
      if (info.ready && info.version === target.version) {
        set({ state: 'ready', count: info.count, version: info.version, thresholds: target.thresholds ?? DEFAULT_T });
        return status;
      }

      if (target !== local) {
        dir().create({ idempotent: true, intermediates: true });
        const keys = ['ids', 'model', 'emb'] as const;
        const done: Record<string, number> = {};
        const total: Record<string, number> = {};
        set({ state: 'downloading', progress: 0 });
        for (const k of keys) {
          const dest = fileFor(target, k);
          const part = new File(dir(), `${dest.name}.part`);
          if (part.exists) part.delete();
          await File.downloadFileAsync(BASE + target.files[k], part, {
            idempotent: true,
            onProgress: (p) => {
              done[k] = p.bytesWritten;
              total[k] = p.totalBytes;
              const d = Object.values(done).reduce((a, b) => a + b, 0);
              const t = Math.max(1, Object.values(total).reduce((a, b) => a + b, 0));
              // ids+modelo são pequenos; o peso maior é o banco (emb)
              set({ progress: Math.min(0.99, k === 'emb' ? 0.3 + 0.7 * ((done.emb ?? 0) / Math.max(1, total.emb ?? 1)) : 0.3 * (d / t)) });
            },
          });
          if (dest.exists) dest.delete();
          part.move(dest);
        }
      }

      set({ state: 'loading' });
      const n = await loadIndexAsync(
        fileFor(target, 'model').uri, fileFor(target, 'emb').uri, fileFor(target, 'ids').uri, target.dim, target.version);
      await setMeta('vision_manifest', JSON.stringify(target));
      // apaga versões antigas
      try {
        for (const f of dir().list()) if (f instanceof File && !f.name.startsWith(`${target.version}-`)) f.delete();
      } catch {}
      set({ state: 'ready', count: n, version: target.version, thresholds: target.thresholds ?? DEFAULT_T, progress: 1, error: undefined });
      return status;
    } catch (e) {
      set({ state: 'error', error: String((e as Error)?.message ?? e).slice(0, 160) });
      return status;
    }
  })().finally(() => {
    job = null;
  });
  return job;
}
