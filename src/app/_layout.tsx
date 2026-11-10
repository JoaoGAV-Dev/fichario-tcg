import '@/lib/background'; // registra a tarefa de coleta diária (precisa rodar no carregamento)

import { DarkTheme, Stack, ThemeProvider, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, Pressable, ScrollView, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { registerBackgroundRefresh } from '@/lib/background';
import { getDb } from '@/lib/db';
import { LigaProvider } from '@/lib/liga';
import { runDailyCollection } from '@/lib/daily';
import { getSeries } from '@/lib/tcgdex';
import { ensureCatalog, setsWithAbbr } from '@/lib/catalog';
import { SettingsProvider } from '@/lib/settings';

SplashScreen.preventAutoHideAsync();

function useDailyCollection() {
  useEffect(() => {
    getDb()
      .then(() => SplashScreen.hideAsync())
      .catch(() => SplashScreen.hideAsync());
    registerBackgroundRefresh().catch(() => {});
    // Ao abrir (e ao voltar para o app), completa a coleta de MYP/TCGdex do dia, se faltar algo
    const run = () => runDailyCollection().catch(() => {});
    getSeries().catch(() => {}); // deixa o catálogo pronto para o scanner
    ensureCatalog().catch(() => {});
    setsWithAbbr().catch(() => {});
    const t = setTimeout(run, 2500);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && run());
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, []);
}

export default function RootLayout() {
  const c = Colors.dark;
  useDailyCollection();
  const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, primary: c.accent, background: c.background, card: c.background, text: c.text, border: c.border } };

  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <SettingsProvider>
          <LigaProvider>
            <StatusBar style="light" />
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
              <Stack.Screen name="check" options={{ title: 'Conferir preço' }} />
              <Stack.Screen name="grade" options={{ title: 'Avaliar para graduar' }} />
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
    <ScrollView style={{ backgroundColor: '#0B0A14' }} contentContainerStyle={{ padding: 24, paddingTop: 72, gap: 12 }}>
      <Text style={{ fontSize: 22, fontWeight: '800', color: '#F5F3FF' }}>Algo deu errado</Text>
      <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, color: '#A9A3C9' }}>{String(error?.stack ?? error)}</Text>
      <Pressable onPress={retry} style={{ backgroundColor: '#FACC15', padding: 14, borderRadius: 12, alignItems: 'center' }}>
        <Text style={{ fontWeight: '700' }}>Tentar de novo</Text>
      </Pressable>
    </ScrollView>
  );
}
