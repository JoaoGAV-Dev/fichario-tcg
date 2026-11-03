// Escanear: reconhecimento pela imagem (câmera com contorno ao vivo). Se o aparelho não tiver o
// módulo (Expo Go/iOS) ou o usuário preferir, cai na leitura antiga pelo texto do rodapé.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { isVisionAvailable } from '../../../modules/card-vision';
import OcrScanScreen from '@/components/ocr-scan';
import VisionScan from '@/components/vision-scan';

export default function ScanScreen() {
  const [useOcr, setUseOcr] = useState(!isVisionAvailable());
  useEffect(() => {
    AsyncStorage.getItem('scanEngine').then((v) => {
      if (v === 'ocr') setUseOcr(true);
    });
  }, []);
  if (useOcr) return <OcrScanScreen />;
  return (
    <VisionScan
      onUseOcr={() => {
        setUseOcr(true);
      }}
    />
  );
}
