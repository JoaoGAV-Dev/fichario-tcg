// Inicializa o WebView (CookieManager) na thread principal ao abrir o app.
// Sem isso, o primeiro fetch do React Native inicializa o Chromium numa thread de rede e,
// em algumas versões do WebView, o app cai com SIGTRAP ("Invalid file descriptor to ICU data").
const { withMainApplication } = require('expo/config-plugins');

const MARK = 'fichario: webview warmup';

module.exports = function withWebViewWarmup(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes(MARK)) {
      src = src.replace(
        /super\.onCreate\(\)\n/,
        `super.onCreate()\n    // ${MARK}\n    try { android.webkit.CookieManager.getInstance() } catch (e: Throwable) {}\n`,
      );
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};
