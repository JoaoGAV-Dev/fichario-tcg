// Empacota só as bibliotecas nativas da arquitetura compilada (-PreactNativeArchitectures=...).
// Sem isso, OpenCV e TensorFlow Lite trazem as 4 arquiteturas e o APK fica ~60 MB maior.
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = 'fichario: abiFilters';

module.exports = function withAbiFilters(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes(MARK)) {
      src = src.replace(
        /defaultConfig \{\n/,
        `defaultConfig {\n        // ${MARK}\n        ndk { abiFilters.addAll((findProperty("reactNativeArchitectures") ?: "armeabi-v7a,arm64-v8a,x86,x86_64").split(",").collect { it.trim() }) }\n`,
      );
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};
