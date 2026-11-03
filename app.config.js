// Versão do APK vem do número da compilação no GitHub Actions (permite instalar por cima da anterior).
module.exports = ({ config }) => {
  const build = Number(process.env.BUILD_NUMBER || 1);
  return {
    ...config,
    version: `1.0.${build}`,
    android: { ...config.android, versionCode: build },
    ios: { ...config.ios, buildNumber: String(build) },
  };
};
