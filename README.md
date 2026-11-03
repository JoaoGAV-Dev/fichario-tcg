# Fichário TCG

App Android para catalogar cartas de Pokémon TCG por coleção, **escanear automaticamente** pelo rodapé e
acompanhar o valor em R$ pela **Liga Pokémon** e pela **MYP Cards**, com variação de **1, 3, 6 e 12 meses**.

Funciona 100% no celular: sem servidor, sem conta, sem custo.

## Instalar no celular
1. Abra **Releases** neste repositório (no navegador do celular) e baixe o `.apk` mais recente.
2. Abra o arquivo. Se o Android pedir, permita "Instalar apps desta fonte".
3. Para atualizar, é só instalar o APK novo por cima. A coleção é mantida.

Todo push na branch `main` gera um APK novo automaticamente (GitHub Actions → "Gerar APK").

## Como funciona
| Parte | Fonte | Como |
|---|---|---|
| Coleções e cartas (PT-BR) | TCGdex | API aberta, sem chave |
| Scanner | No aparelho (CameraX + OpenCV + TensorFlow Lite) | **Reconhecimento pela imagem**: acha a borda da carta quadro a quadro (contorno amarelo → verde), endireita o recorte e compara a "impressão digital" da arte com ~19,6 mil cartas (PT + promos/energias só em inglês). Funciona offline depois de baixar o banco (~15 MB, 1ª vez) |
| Banco de cartas | GitHub Actions (`vision/build_db.py`) | Toda segunda: baixa as imagens do TCGdex, gera o modelo e os vetores e publica na release `cards-db`. Relatório com fotos reais em `cards-db-report` |
| Scanner antigo (reserva) | Google ML Kit | Leitura do rodapé (sigla/número), usado se o banco não puder ser baixado |
| Preço na hora | Cache local + MYP por coleção + cotação | Na 1ª carta de uma coleção, baixa o menor preço de **todas** as cartas dela (~1 s); as próximas aparecem instantâneas |
| Preço MYP completo | mypcards.com | Menor, médio e último vendido (em segundo plano) |
| Preço Liga | ligapokemon.com.br | Navegador escondido dentro do app (a Liga bloqueia robôs com Cloudflare) |
| Referência internacional | TCGplayer (US$) e Cardmarket (€) | Convertidos para R$ pela cotação do dia (AwesomeAPI / Frankfurter) |
| Histórico longo | TCGplayer | 1 ano, semana a semana, desde o primeiro dia |
| Histórico em R$ | SQLite no celular | Uma "foto" diária. Antes dela existir, o valor é **estimado**: preço BR de hoje × variação da carta nos EUA (sempre marcado) |

### Painel (inspirado no Deck Certo)
- Valor da coleção e a variação dos últimos 30 dias.
- Cartas que entraram no período.
- Coleções com capa, progresso e valor.
- Mais valiosas.
- Evolução do valor (7/30/90 dias/tudo, com filtro por coleção).
- Movimentações (subiram/caíram).
- Aba Pokédex e busca por nome.

## Desenvolvimento
```bash
npm install
npm test             # parsers (MYP/Liga/rodapé) e cálculo de variação
npx tsc --noEmit
```
O scanner usa módulos nativos próprios (`modules/card-vision` e `modules/card-ocr`), então **não roda no Expo Go**: o build é feito pelo GitHub Actions.

Reconhecimento por imagem: `vision/cardvision.py` (detecção, igual a `CardDetector.kt`), `vision/build_db.py` (banco + avaliação; `workflow_dispatch` com `eval` compara redes) e `vision/real/` (fotos reais usadas no teste — ponha mais fotos `<nome>__<n>.jpg` para medir).

```
src/app/            telas: coleção, escanear, coleções, ajustes, carta, coleção (set)
src/lib/            db (SQLite), prices, collection, liga (WebView), background, backup, ocr, match, footer, tcgdex
src/lib/sources/    parsers de MYP/Liga + coleta
modules/card-vision/ câmera com contorno ao vivo + reconhecimento (Android Kotlin)
modules/card-ocr/   módulo nativo de OCR (Android Kotlin; iOS Swift ainda não testado)
vision/             geração e teste do banco de cartas (Python, roda no GitHub Actions)
.github/workflows/  build do APK
tests/              testes
```

## Limitações conhecidas
- O preço é por **carta** (número), sem separar normal, reverse ou holo.
- A leitura da Liga usa o texto visível da página e ainda não foi validada na página real. Se aparecer "sem preço", ajuste `parseLigaText` em `src/lib/sources/parsers.ts`.
- Cartas de Treinador podem ter nome diferente na Liga; a URL usa o nome em inglês.
- MYP e Liga não têm API oficial: se o site mudar, o parser precisa de ajuste.
- iPhone: o código é multiplataforma, mas instalar fora da App Store exige conta Apple Developer (paga).
