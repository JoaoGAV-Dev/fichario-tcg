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
| Scanner | Google ML Kit, no aparelho | A câmera lê o tempo todo. Ao achar sigla + número (`OBF PT 125/197`), identifica a carta sozinho |
| Preço MYP | mypcards.com | Busca `125/197`, confere a sigla e lê menor, médio e último vendido |
| Preço Liga | ligapokemon.com.br | Navegador escondido dentro do app (a Liga bloqueia robôs com Cloudflare) |
| Referência internacional | Cardmarket (€) e TCGplayer (US$) | Vem junto da TCGdex |
| Histórico 1/3/6/12 meses | SQLite no celular | Uma "foto" diária do preço de cada carta |

**Coleta diária:**
- **MYP e TCGdex:** atualizam ao abrir o app e em segundo plano, várias vezes ao dia, mas no máximo uma coleta por carta por dia.
- **Liga:** atualiza escondida uma vez por dia, ao abrir o app. Se ela pedir "Confirme que é humano", o navegador aparece; você toca na caixa e ele volta a rodar escondido.

> O histórico começa no dia em que você instala. Nem a Liga nem a MYP oferecem histórico aberto.
> Enquanto isso, a tela da carta mostra a tendência de 30 dias do Cardmarket.

**Samsung:** em Configurações → Apps → Fichário TCG → Bateria, escolha **Sem restrições**. Sem isso, a coleta em segundo plano pode não rodar.

**Backup:** os dados ficam só no celular. Use Ajustes → Exportar backup de vez em quando.

## Desenvolvimento
```bash
npm install
npm test             # parsers (MYP/Liga/rodapé) e cálculo de variação
npx tsc --noEmit
```
O scanner usa um módulo nativo próprio (`modules/card-ocr`, ML Kit), então **não roda no Expo Go**: o build é feito pelo GitHub Actions.

```
src/app/            telas: coleção, escanear, coleções, ajustes, carta, coleção (set)
src/lib/            db (SQLite), prices, collection, liga (WebView), background, backup, ocr, match, footer, tcgdex
src/lib/sources/    parsers de MYP/Liga + coleta
modules/card-ocr/   módulo nativo de OCR (Android Kotlin; iOS Swift ainda não testado)
.github/workflows/  build do APK
tests/              testes
```

## Limitações conhecidas
- O preço é por **carta** (número), sem separar normal, reverse ou holo.
- A leitura da Liga usa o texto visível da página e ainda não foi validada na página real. Se aparecer "sem preço", ajuste `parseLigaText` em `src/lib/sources/parsers.ts`.
- Cartas de Treinador podem ter nome diferente na Liga; a URL usa o nome em inglês.
- MYP e Liga não têm API oficial: se o site mudar, o parser precisa de ajuste.
- iPhone: o código é multiplataforma, mas instalar fora da App Store exige conta Apple Developer (paga).
