# Fix: botões dos cards de pedidos vazando para fora do card

## Sintoma
Com pedidos presentes nas 4 colunas do pipeline (Recebido, Em Preparo, Pronto,
Concluído), os botões de ação nos cards de pedido (avançar status, ajustar
valor, imprimir, cancelar) ficavam parcialmente fora da área visível do card,
sobrepondo a coluna vizinha e impedindo o clique em alguns deles.

## Local
`app/page.js`, componente `Pedidos()` (view "Pedidos"), linha ~543 (antes do
fix).

## Causa raiz
O grid de colunas é `grid gap-4 md:grid-cols-2 xl:grid-cols-4`. A partir do
breakpoint `xl` (>=1280px), cada coluna ocupa uma fração pequena da largura da
tela (ex.: ~230px de conteúdo do card em uma viewport de 1280px). A linha de
botões de cada card era:

```jsx
<div className="flex gap-2 pt-1">
  {next && <Button size="sm" className="flex-1 h-8">{STATUS[next].label} ...</Button>}
  {/* ajuste (%) */}
  {/* dropdown impressão */}
  {/* cancelar (X) */}
</div>
```

O componente `Button` usa `whitespace-nowrap` e nenhum dos itens tinha
`min-w-0`/wrap, então a soma das larguras intrínsecas (botão de próximo status
com rótulo longo como "Em Preparo"/"Concluído" + 3 botões-ícone de ~40px cada +
gaps) ultrapassava a largura disponível do `CardContent`. Como o `Card` não
tem `overflow-hidden`, os botões que não cabiam simplesmente vazavam
visualmente para fora do card, ficando por baixo/atrás da coluna seguinte —
inacessíveis ao clique sem rolagem horizontal.

Confirmado via medição de DOM (Playwright) antes do fix, viewport 1280px,
card do pedido #7 (coluna "Em Preparo"):
- `cardRight` = 756px
- botão cancelar (`X`) `right` = 781.4px
- **overflow = +25.4px para fora do card**

## Fix aplicado
Reestruturada a linha de ações em duas linhas com `flex flex-col`:
1. O botão principal (avançar status) ocupa `w-full` em uma linha própria.
2. Os botões-ícone (ajustar valor, imprimir, cancelar) ficam em uma segunda
   linha com `flex flex-wrap gap-2`, garantindo que, mesmo no pior caso
   (coluna muito estreita), eles quebrem linha em vez de vazar.

```jsx
<div className="flex flex-col gap-2 pt-1">
  {next && <Button size="sm" className="w-full h-8">{STATUS[next].label} ...</Button>}
  <div className="flex flex-wrap gap-2">
    {/* ajuste (%) */}
    {/* dropdown impressão */}
    {/* cancelar (X) */}
  </div>
</div>
```

Essa abordagem funciona em qualquer largura de coluna, porque os únicos itens
que precisavam de mais espaço (o botão de próximo status, com texto variável)
passaram a ocupar 100% da largura do card, e o grupo de ícones (que juntos
somam ~120-150px) tem `flex-wrap` como rede de segurança.

## Testes realizados (Playwright, servidor dev local)
Dados de teste: pedidos já existentes no ambiente cobrindo as 4 colunas
(Recebido: 1, Em Preparo: 2, Pronto: 3, Concluído: 4).

- **1280px (breakpoint `xl`, 4 colunas)** — antes: botão cancelar do pedido #7
  vazava 25px para fora do card, sobrepondo a coluna "Pronto". Depois: 0
  botões com overflow em nenhum dos 10 cards (checado via
  `getBoundingClientRect` comparando cada botão com os limites do card pai).
- **1440px** — 0 botões com overflow.
- **375px (mobile, grid-cols-1)** — 0 botões com overflow, `document.body.scrollWidth === window.innerWidth` (sem scroll horizontal de página).
- **Hit-test**: `document.elementFromPoint()` no centro do botão cancelar do
  pedido #7 (pós-fix) retorna o próprio botão — confirma que o botão está
  clicável e não está sendo interceptado por outro elemento.
- **Build de produção**: `yarn build` concluído com exit code 0, sem erros de
  tipo/lint, rota `/` compilada normalmente (First Load JS 301 kB).

## Screenshots
- Antes (1280px): botão cancelar (`X`) do pedido #7 vazando sobre a coluna
  "Pronto".
- Depois (1280px, 1440px, 375px): todos os botões dentro dos limites do card,
  layout em duas linhas (ação principal + ícones secundários).

## Arquivo alterado
- `app/page.js` (função `Pedidos`, linhas ~543-562 antes do fix)
