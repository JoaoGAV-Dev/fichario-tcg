import '@/lib/background'; // registra a tarefa de coleta diária (precisa rodar no carregamento)

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { registerBackgroundRefresh } from '@/lib/background';
import { getDb } from '@/lib/db';
import { LigaProvider } from '@/lib/liga';
import { refreshDueToday } from '@/lib/prices';
import { SettingsProvider } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

function useDailyCollection() {
  useEffect(() => {
    getDb()
      .then(() => SplashScreen.hideAsync())
      .catch(() => SplashScreen.hideAsync());
    registerBackgroundRefresh().catch(() => {});
    // Ao abrir (e ao voltar para o app), completa a coleta de MYP/TCGdex do dia, se faltar algo
    const run = () => refreshDueToday().catch(() => {});
    const t = setTimeout(run, 2500);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && run());
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, []);
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const c = Colors[scheme === 'dark' ? 'dark' : 'light'];
  useDailyCollection();

  return (
    <SafeAreaProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <SettingsProvider>
          <LigaProvider>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: c.background },
                headerTintColor: c.text,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: c.background },
                headerBackTitle: 'Voltar',
              }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="set/[id]" options={{ title: 'Coleção' }} />
              <Stack.Screen name="card/[id]" options={{ title: 'Carta' }} />
            </Stack>
          </LigaProvider>
        </SettingsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
