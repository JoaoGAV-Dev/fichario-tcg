import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import type { RefMode } from './prices';

interface Settings {
  refMode: RefMode;
  setRefMode: (m: RefMode) => void;
}

const Ctx = createContext<Settings>({ refMode: 'media', setRefMode: () => {} });

export const REF_LABEL: Record<RefMode, string> = {
  media: 'Média Liga + MYP',
  liga: 'Liga Pokémon (preço médio)',
  myp: 'MYP Cards (preço médio)',
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [refMode, setMode] = useState<RefMode>('media');
  useEffect(() => {
    AsyncStorage.getItem('refMode').then((v) => {
      if (v === 'media' || v === 'liga' || v === 'myp') setMode(v);
    });
  }, []);
  const setRefMode = (m: RefMode) => {
    setMode(m);
    AsyncStorage.setItem('refMode', m).catch(() => {});
  };
  return <Ctx.Provider value={{ refMode, setRefMode }}>{children}</Ctx.Provider>;
}

export const useSettings = () => useContext(Ctx);
