import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Chip, Panel, Txt } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { exportBackup, importBackup } from '@/lib/backup';
import { exportCollection } from '@/lib/export';
import { PREF_LABEL, VARIANT_PREFS, setScanPrefs, useScanPrefs } from '@/lib/scanprefs';
import { getMeta } from '@/lib/db';
import { dateBR } from '@/lib/format';
import { isOcrAvailable } from '@/lib/ocr';
import { getHistorySince, type RefMode } from '@/lib/prices';
import { REF_LABEL, useSettings } from '@/lib/settings';

export default function Settings() {
  const t = useTheme();
  const { refMode, setRefMode } = useSettings();
  const [since, setSince] = useState<string | null>(null);
  const [lastAuto, setLastAuto] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'csv' | null>(null);
  const scan = useScanPrefs();

  async function doExport(fmt: 'xlsx' | 'csv') {
    setExporting(fmt);
    try {
      await exportCollection(fmt, refMode);
    } catch (e) {
      Alert.alert('Exportar coleção', String((e as Error)?.message ?? e));
    } finally {
      setExporting(null);
    }
  }

  useFocusEffect(useCallback(() => {
    getHistorySince().then(setSince).catch(() => {});
    getMeta('last_auto_refresh').then(setLastAuto).catch(() => {});
  }, []));

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.background }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 120 }}>
        <Txt variant="title">Ajustes</Txt>

        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">Exportar coleção</Txt>
          <Txt variant="small">
            Planilha com todas as suas cartas: coleção, número, versão, estado, quantidade e preço de hoje.
            Abre no Excel, Google Planilhas ou WPS.
          </Txt>
          <Button title="Exportar para Excel (.xlsx)" icon="microsoft-excel" loading={exporting === 'xlsx'} onPress={() => doExport('xlsx')} />
          <Button title="Exportar CSV" kind="secondary" icon="file-delimited-outline" loading={exporting === 'csv'} onPress={() => doExport('csv')} />
        </Panel>

        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">Scanner</Txt>
          <Txt variant="small">Ao reconhecer uma carta:</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label="Adicionar à coleção" active={scan.mode === 'auto'} onPress={() => setScanPrefs({ mode: 'auto' })} />
            <Chip label="Só consultar o preço" active={scan.mode === 'consulta'} onPress={() => setScanPrefs({ mode: 'consulta' })} />
          </View>
          <Txt variant="small">Versão ao adicionar (Automática = a mais comum da carta):</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {VARIANT_PREFS.map((v) => (
              <Chip key={v} label={PREF_LABEL[v]} active={scan.variant === v} onPress={() => setScanPrefs({ variant: v })} />
            ))}
          </View>
        </Panel>

        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">Preço de referência</Txt>
          <Txt variant="small">Valor usado no total da coleção e nas variações.</Txt>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(Object.keys(REF_LABEL) as RefMode[]).map((m) => (
              <Chip key={m} label={REF_LABEL[m]} active={refMode === m} onPress={() => setRefMode(m)} />
            ))}
          </View>
          <Txt variant="small">Se a fonte escolhida não tiver preço de uma carta, o app usa a outra.</Txt>
        </Panel>

        <Panel style={{ gap: 8 }}>
          <Txt variant="h2">Histórico de preços</Txt>
          <Txt variant="small">Coletando desde: {since ? dateBR(since) : 'ainda sem coleta'}</Txt>
          <Txt variant="small">Última coleta automática: {lastAuto ? `${dateBR(lastAuto)} ${lastAuto.slice(11, 16)} UTC` : '—'}</Txt>
          <Txt variant="small">
            O app guarda uma foto do preço por dia: MYP e TCGdex sozinhos (também em segundo plano) e a Liga
            sempre que você abre o app. Para a coleta em segundo plano funcionar no Samsung, deixe a bateria do
            app como "Sem restrições".
          </Txt>
          <Button title="Abrir ajustes de bateria do app" kind="secondary" onPress={() => Linking.openSettings()} />
        </Panel>

        <Panel style={{ gap: 10 }}>
          <Txt variant="h2">Backup</Txt>
          <Txt variant="small">
            Tudo fica só neste celular. Exporte de vez em quando (Google Drive, WhatsApp, e-mail…) para não perder
            a coleção e o histórico se trocar de aparelho.
          </Txt>
          <Button
            title="Exportar backup" kind="secondary"
            onPress={() => exportBackup().catch((e) => Alert.alert('Erro', String(e)))}
          />
          <Button
            title="Importar backup" kind="secondary"
            onPress={async () => {
              try {
                const r = await importBackup();
                if (r) Alert.alert('Backup importado', `${r.items} itens e ${r.snapshots} preços.`);
              } catch (e) {
                Alert.alert('Erro', String(e));
              }
            }}
          />
        </Panel>

        <Panel style={{ gap: 6 }}>
          <Txt variant="h2">De onde vêm os dados</Txt>
          <Txt variant="small">• Cartas e coleções: TCGdex (gratuito, em português).</Txt>
          <Txt variant="small">• MYP Cards: menor preço, preço médio e último vendido.</Txt>
          <Txt variant="small">• Liga Pokémon: menor, médio e maior, lidos num navegador dentro do app (a Liga bloqueia robôs).</Txt>
          <Txt variant="small">• Cardmarket e TCGplayer: referência internacional que vem com a TCGdex.</Txt>
          <Txt variant="small">• Scanner: reconhecimento pela imagem no aparelho (offline, grátis){isOcrAvailable() ? '; leitura do rodapé como reserva.' : '.'}</Txt>
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}
