import { NativeTabs } from 'expo-router/native-tabs';

import { useTheme } from '@/hooks/use-theme';

export default function TabsLayout() {
  const t = useTheme();
  return (
    <NativeTabs
      backgroundColor={t.background}
      indicatorColor={t.backgroundSelected}
      labelStyle={{ selected: { color: t.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Minha coleção</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up.fill" md="style" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="scan">
        <NativeTabs.Trigger.Label>Escanear</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="camera.viewfinder" md="photo_camera" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sets">
        <NativeTabs.Trigger.Label>Coleções</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="books.vertical.fill" md="collections_bookmark" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Ajustes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
