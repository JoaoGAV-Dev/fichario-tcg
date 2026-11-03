import '@/lib/background'; // registra a tarefa de coleta diária (precisa rodar no carregamento)

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, Pressable, ScrollView, Text, useColorScheme } from 'react-native';
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
              <Stack.Screen name="search" options={{ title: 'Buscar carta' }} />
              <Stack.Screen name="pokemon/[dex]" options={{ title: 'Pokémon' }} />
            </Stack>
          </LigaProvider>
        </SettingsProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/** Se alguma tela quebrar, mostra o erro em vez de fechar o app (ajuda a diagnosticar). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 72, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '800' }}>Algo deu errado</Text>
      <Text selectable style={{ fontFamily: 'monospace', fontSize: 12 }}>{String(error?.stack ?? error)}</Text>
      <Pressable onPress={retry} style={{ backgroundColor: '#F7C934', padding: 14, borderRadius: 12, alignItems: 'center' }}>
        <Text style={{ fontWeight: '700' }}>Tentar de novo</Text>
      </Pressable>
    </ScrollView>
  );
}
