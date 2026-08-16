# Custo e Margem (CMV) — Design

**Data:** 2026-08-14
**Status:** Aprovado, pronto para plano de implementacao

---

## 1. Problema

O sistema sabe quanto **entrou** e nunca quanto **sobrou**.

`Produto` tem `preco` e nao tem custo em lugar nenhum do modelo. A consequencia
direta e que nenhum dos numeros que um dono de restaurante usa para decidir
existe hoje:

- **CMV%** (custo da mercadoria vendida sobre a receita) — o indicador numero 1
  do setor, saudavel entre 28% e 35%
- **Lucro bruto** — o Dashboard mostra `faturamentoHoje` e para por ai
- **Margem por item** — impossivel saber que o refrigerante paga a conta
  enquanto o prato executivo da prejuizo

Um restaurante fecha as portas com faturamento alto e CMV descontrolado. Hoje o
sistema nao avisaria.

## 2. Objetivo

Transformar o Restaurant OS de **registrador de vendas** em **ferramenta de
gestao**, adicionando custo ao cadastro do produto e derivando dele CMV%,
cobertura e lucro bruto no Dashboard e no Relatorio financeiro.

## 3. Escopo

**Dentro:**

- Campo `custo` no cadastro do produto (entrada manual)
- Apuracao do custo no momento em que a venda vira `transacao`
- CMV%, cobertura e lucro bruto no Dashboard (dia)
- Os mesmos indicadores no Relatorio financeiro (periodo filtrado) e no CSV

**Fora (decidido, nao esquecido):**

- **Margem por item na lista de produtos** — a granularidade existe no dado mas
  nao sera exposta nesta entrega
- **Preview de margem ao vivo no dialog** — o campo entra, o calculo ao vivo nao
- **Ficha tecnica / insumos** — proxima feature, depende desta
- **Custo por media ponderada de compras** — exige subsistema de fornecedores e
  notas de entrada
- **Historico de alteracao de custo** — o custo atual e sobrescrito; o historico
  fica preservado indiretamente nas transacoes ja congeladas

## 4. Decisoes de design

### 4.1 Custo congelado na transacao, nao no item

Tres lugares poderiam guardar o custo de uma venda. A escolha foi a transacao.

| Alternativa | Por que nao |
|---|---|
| **Snapshot no item** (`pedido_itens.custo_unitario`) | Obriga reescrever as 4 funcoes atomicas do Postgres (`create_pedido_com_itens`, `upsert_pedido_com_itens` e as equivalentes de comanda), que usam **lista explicita de colunas** — coluna esquecida some em silencio (armadilha do HANDOFF §4.3). Paga o preco da granularidade por item sem que nenhuma superficie desta entrega a use |
| **Lookup vivo** (join com `produtos.custo` na hora do relatorio) | **Reescreve a historia**: custo da carne sobe 20% hoje e o CMV de janeiro muda sozinho. Quebra quando o produto e excluido. Viola o principio de snapshot que o projeto ja declara no §4.1 |

A transacao ja e a fonte unica de verdade financeira, ja e o que o Dashboard e o
Relatorio leem, e e criada por `transacaoRepo.create()` direto — **fora** das
funcoes atomicas. Congelar o custo ali entrega precisao historica com o menor
raio de mudanca e sem tocar na parte mais fragil do sistema.

Se um dia margem por item virar prioridade, sobe-se para snapshot no item sem
perder nada do que ja foi gravado.

### 4.2 `custo` e nulo, nunca zero por omissao

`produtos.custo` e `numeric(12,2) default null`.

| Valor | Significa |
|---|---|
| `null` | **Nao cadastrado.** Sai do calculo, conta contra a cobertura |
| `0` | **Custo zero real.** Brinde, cortesia, item de marketing. Entra no calculo |

Se fosse `not null default 0`, todo produto nasceria "de graca" e o CMV do
primeiro dia sairia lindo e falso. A distincao nulo-versus-zero e o que permite
reportar *"CMV sobre 68% do faturamento"* em vez de mentir com 100%.

### 4.3 Produto sem custo sai da conta e aparece na cobertura

Item cujo produto tem `custo = null` nao entra em `custo_total` nem em
`receita_com_custo` — entra apenas em `receita_base`. Dessa diferenca nasce a
**cobertura**, exibida sempre ao lado do CMV.

Um CMV de 31% com 40% de cobertura nao e um CMV de 31%. Quem olha precisa ver as
duas coisas no mesmo instante, nao em nota de rodape.

### 4.4 Estorno nao devolve custo

Estornar uma venda cria `despesa/Estorno` com os tres campos de custo em zero.

A comida foi produzida e consumida ou perdida — o custo aconteceu de verdade.
Devolve-lo maquiaria o CMV justamente no caso em que houve desperdicio. Efeito
pratico: estorno **piora** o CMV, que e o sinal correto.

O estorno continua visivel como despesa no Relatorio financeiro, onde ja esta
hoje. Nao ha dupla contagem.

### 4.5 Falha na apuracao nao derruba a venda

Se a leitura dos produtos falhar, a venda segue e a transacao e gravada com
`custo_total = 0` e `receita_com_custo = 0`, **mantendo `receita_base` real**
(ela vem dos itens, que ja estao em maos — nao depende da leitura que falhou).

Zerar os tres seria pior: tiraria a venda tambem do denominador da cobertura, e
a cobertura passaria a parecer melhor do que e justamente quando o sistema falhou
em apurar. Mantendo a base, a cobertura cai — que e o sinal honesto de "esta
venda nao teve custo apurado".

Mesma politica `non-fatal` que o Estoque adotou (o erro vai para `auditoria`).
Nenhum indicador de gestao vale travar um caixa em horario de pico.

### 4.6 Sem migracao retroativa

Transacoes anteriores a esta migration ficam com os tres campos em `0` e caem
fora do calculo naturalmente (`receita_com_custo = 0`). A cobertura reflete isso
sem nenhum tratamento especial. Mesma regra que o Caixa adotou para
`forma_pagamento`.

## 5. Modelo de dados

### 5.1 Migration `0020_custo.sql`

```sql
-- Custo unitario do produto. NULL = nao cadastrado (fica fora do CMV e conta
-- contra a cobertura). 0 = custo zero real (brinde, cortesia) e entra no
-- calculo. A distincao e o que impede o CMV de mentir para baixo.
alter table public.produtos
  add column if not exists custo numeric(12,2) default null
    check (custo is null or custo >= 0);

-- Custo apurado no momento da venda. Congelado: mudar o custo do produto
-- amanha nao reescreve o CMV de hoje.
alter table public.transacoes
  add column if not exists custo_total       numeric(12,2) not null default 0,
  add column if not exists receita_com_custo numeric(12,2) not null default 0,
  add column if not exists receita_base      numeric(12,2) not null default 0;
```

Os tres campos de `transacoes` sao `not null default 0` porque aqui zero e
honesto: transacao sem custo apurado tem `receita_com_custo = 0` e sai da conta.

Nao ha indice novo. As consultas de CMV agregam sobre `(empresa_id, data)`, que
ja tem indice (`idx_transacoes_data`).

### 5.2 Contratos de dominio

Em `packages/domain/src/index.ts`:

```typescript
export interface Produto extends TenantScoped {
  // ...campos atuais
  /**
   * Custo unitario. `null` = nao cadastrado (fica fora do CMV e conta contra
   * a cobertura); `0` = custo zero real (brinde, cortesia) e entra no calculo.
   */
  custo: number | null;
}

export interface Transacao extends TenantScoped {
  // ...campos atuais
  /** Custo apurado na venda. Congelado — mudar o custo do produto amanha
   *  nao reescreve o CMV de hoje. */
  custo_total: number;
  /** Receita dos itens que tinham custo. Denominador do CMV. */
  receita_com_custo: number;
  /** Receita de todos os itens. Denominador da cobertura. */
  receita_base: number;
}
```

## 6. Calculo — `lib/custo.js`

Modulo puro, mesmo padrao de `lib/caixa.js` e `lib/cupom-dados.js`: nao toca
banco, nao toca HTTP, testavel em `node` sem navegador.

```javascript
/**
 * Apura o custo de uma venda a partir dos itens e do custo cadastrado de
 * cada produto.
 *
 * @param {object} p
 * @param {Array<{produto_id: string|null, preco: number, quantidade: number}>} p.itens
 * @param {Object<string, number|null>} p.custoPorProduto  mapa produto_id -> custo
 * @param {number} p.rateio  fracao desta transacao sobre o total da venda
 * @returns {{custo_total: number, receita_com_custo: number, receita_base: number}}
 */
export function computeCustoVenda({ itens, custoPorProduto, rateio = 1 })

/**
 * Agrega transacoes ja gravadas em indicadores de gestao. So `tipo === 'receita'`
 * entra — estornos nao devolvem custo (ver §4.4).
 *
 * @param {Array<Transacao>} transacoes
 * @returns {{custo_total: number, receita_com_custo: number, receita_base: number,
 *            cmv_percent: number|null, cobertura_percent: number|null,
 *            lucro_bruto: number|null}}
 */
export function computeCMV(transacoes)
```

**Regras do calculo:**

- Item entra em `receita_base` sempre: `preco * quantidade`
- Item entra em `custo_total` e `receita_com_custo` **apenas** se
  `custoPorProduto[produto_id]` for um numero (inclusive `0`). `null` e
  `undefined` ficam de fora
- Item sem `produto_id` (avulso) nunca tem custo
- Todo resultado passa por arredondamento de 2 casas a cada etapa, para que
  centavos nao acumulem erro de ponto flutuante (mesmo `round2` de `lib/caixa.js`)
- `rateio` multiplica os tres valores no final

**`null`, nao zero, quando nao da para saber:**
`cmv_percent`, `cobertura_percent` e `lucro_bruto` retornam `null` quando o
denominador e zero. "Nao da para saber" e diferente de "e zero", e a UI precisa
distinguir para mostrar o estado vazio certo no primeiro dia de uso.

**`receita_base` e o subtotal dos itens, nao o total da transacao.**
Desconto, acrescimo e taxa de entrega **nao** entram em nenhum dos tres campos.
A razao e que CMV compara custo de mercadoria com receita de mercadoria: taxa de
entrega e receita de servico (com custo proprio, o entregador, que esta fora
desta entrega), e desconto e acrescimo sao ajuste comercial do operador. Mistura-los
distorceria o indicador nos dois sentidos.

Consequencia pratica: `transacao.valor` (o que entrou no caixa) e
`transacao.receita_base` (a mercadoria vendida) sao numeros diferentes de
proposito, e a diferenca entre eles e exatamente desconto/acrescimo/entrega. O
Relatorio ja mostra esses tres separadamente hoje — nao ha numero perdido.

### 6.1 Exemplo verificado

Venda de 3 itens:

| Item | Preco | Custo | Coberto |
|---|---|---|---|
| A | 20 | 8 | sim |
| B | 30 | `null` | nao |
| C | 10 | 4 | sim |

```
receita_base      = 60
receita_com_custo = 30   (20 + 10)
custo_total       = 12   (8 + 4)

CMV%      = 12 / 30 = 40,0%
Cobertura = 30 / 60 = 50,0%
Lucro     = 30 - 12 = 18,00
```

O CMV e verdadeiro sobre o que ele cobre, e a lacuna esta visivel.

## 7. Pontos de integracao

Tres locais em `app/api/[[...path]]/route.js` criam transacao de receita. Em cada
um, ler os produtos dos itens, montar `custoPorProduto`, chamar
`computeCustoVenda` e gravar os tres campos.

| Linha (atual) | Situacao | Itens | Rateio |
|---|---|---|---|
| ~1377 | `PUT /pedidos/:id` concluindo | `pedido.itens` | `1` |
| ~1929 | `POST /comandas/:id/fechar` **com** pagamentos | `comanda.itens` | `pg.valor / totals.total` |
| ~1947 | `POST /comandas/:id/fechar` **sem** pagamento | `comanda.itens` | `1` |

**Rateio da comanda dividida:** o rateio responde *"que fatia desta venda esta
transacao representa"*, e multiplica os tres campos calculados sobre os itens.

O denominador e `totals.total` (com taxa de servico e desconto), enquanto os
campos rateados sao baseados no subtotal dos itens (§6). Isso e proposital e
fecha exatamente, porque a soma dos rateios e sempre `1`:

```
subtotal itens = 100      total = 110      pago: 60 dinheiro + 50 cartao

rateio dinheiro = 60/110 = 0,5454...
rateio cartao   = 50/110 = 0,4545...
                           ─────────
                    soma =  1,0000  ✓

receita_base dinheiro = 100 × 0,5454 = 54,55
receita_base cartao   = 100 × 0,4545 = 45,45
                                       ──────
                                soma = 100,00  ✓
```

Arredondar cada transacao a 2 casas pode deixar 1 centavo de diferenca na soma
em casos de divisao nao exata (ex.: 3 pagamentos iguais de um total de 100). E
aceitavel: o CMV e um indicador percentual, nao um valor conciliado contra a
gaveta. O Caixa continua conferindo por `valor`, que nao passa por rateio.

**Nao recebem custo:**
`POST /pedidos/:id/estorno` (§4.4), lancamento manual no financeiro (sem itens),
e o seed de demonstracao.

**Custo da leitura extra:** os mesmos itens ja sao percorridos logo abaixo pela
baixa de estoque. Uma leitura de produtos por venda, desprezivel.

## 8. Superficies

### 8.1 Dashboard

`GET /dashboard/metrics` ganha um bloco `cmv` no retorno, calculado sobre as
transacoes do dia:

```json
"cmv": {
  "custo_total": 558.00,
  "receita_com_custo": 1802.00,
  "receita_base": 2650.00,
  "cmv_percent": 31.0,
  "cobertura_percent": 68.0,
  "lucro_bruto": 1244.00
}
```

Dois cards ao lado dos atuais:

```
┌─────────────────────┐  ┌─────────────────────┐
│ Lucro Bruto Hoje    │  │ CMV                 │
│ R$ 1.244,00         │  │ 31,0%               │
│ sobre R$ 1.802 com  │  │ saudavel (28–35%)   │
│ custo apurado       │  │ cobertura: 68% ⚠    │
└─────────────────────┘  └─────────────────────┘
```

**Faixas de cobertura:** `<50%` vermelha, `50–80%` amarela, `>80%` verde.

**Faixa de CMV:** 28–35% exibida como referencia textual do setor, nao como
julgamento — margem varia muito por tipo de operacao.

**Estado vazio (dia 1):** quando `cmv_percent` e `null`, os cards nao mostram
`—`. Mostram *"Cadastre o custo dos produtos para acompanhar sua margem"* com
atalho para o Cardapio. E a unica chance de explicar a feature para quem nunca a
viu.

### 8.2 Relatorio financeiro

`GET /financeiro/relatorio` ganha os mesmos campos, calculados sobre o periodo ja
filtrado pela tela. Exibidos na tabela **e no CSV** — o CSV e onde o contador vai
olhar.

### 8.3 Cadastro do produto

Campo `Custo (R$)` no dialog do produto, ao lado do preco:

- `type="number"`, `min="0"`, `step="0.01"`
- Ajuda curta: *"Quanto voce paga para produzir. Deixe vazio se ainda nao souber."*
- **Campo vazio grava `null`**, nao `0` — e isso que mantem a cobertura honesta
  em vez de empurrar o produto para dentro da conta valendo zero

Sem preview de margem ao vivo (fora de escopo, §3).

## 9. Bordas e tratamento de erro

| Situacao | Comportamento |
|---|---|
| Nenhum produto com custo cadastrado | `cmv_percent = null` → estado vazio explicativo |
| Produto excluido apos a venda | Irrelevante — custo ja congelado na transacao |
| Transacao anterior a migration | Tres campos em `0` → fora da conta; cobertura reflete |
| Item avulso sem `produto_id` | Sem custo; entra so em `receita_base` |
| Custo maior que o preco | Permitido. CMV > 100%, margem negativa — e informacao real, nao erro |
| Lancamento manual no financeiro | Sem itens, sem custo |
| Falha ao ler produtos na apuracao | Tres campos em `0`, venda segue, erro em `auditoria` (§4.5) |
| Comanda com `totals.total = 0` | Rateio protegido: divisor zero → rateio `0`, sem `NaN` |

## 10. Testes

### 10.1 Puros — `test_custo_calculo.mjs`

Padrao de `test_caixa_calculo.mjs`, roda com `node test_custo_calculo.mjs`, sem
banco e sem servidor:

1. Venda so com produtos sem custo → `custo_total = 0`, `receita_com_custo = 0`
2. Produto com `custo = 0` **entra** no calculo (brinde e coberto)
3. Mistura coberto/nao-coberto → o exemplo verificado da §6.1
4. Rateio de comanda dividida: duas metades somam exatamente o custo inteiro
5. `cmv_percent` e `null` quando `receita_com_custo = 0`
6. Item sem `produto_id` fica fora do custo
7. Centavos nao acumulam erro de ponto flutuante
8. CMV acima de 100% quando custo > preco
9. `computeCMV` ignora `tipo === 'despesa'` (estorno nao devolve custo)
10. Rateio com `total = 0` nao produz `NaN`

### 10.2 Integracao — `backend_test_custo.py`

Padrao de `backend_test_caixa.py`:

1. Pedido concluido grava os tres campos corretamente
2. Comanda fechada com dois metodos: soma dos custos das duas transacoes bate
   com o custo total da comanda
3. Comanda fechada sem pagamento registrado
4. Produto sem custo nao entra em `receita_com_custo`
5. Dashboard retorna o bloco `cmv` com os valores esperados
6. Relatorio retorna os campos no periodo filtrado
7. Estorno nao altera `custo_total`
8. Isolamento multi-tenant: empresa A nao ve o custo da empresa B

## 11. Arquivos afetados

| Arquivo | Mudanca |
|---|---|
| `supabase/migrations/0020_custo.sql` | **novo** — 1 coluna em `produtos`, 3 em `transacoes` |
| `packages/domain/src/index.ts` | `Produto.custo`, 3 campos em `Transacao` |
| `lib/custo.js` | **novo** — modulo puro |
| `test_custo_calculo.mjs` | **novo** — 10 testes |
| `lib/repositories/mongo/transacaoRepository.js` | `normalize()` precisa repassar os 3 campos |
| `app/api/[[...path]]/route.js` | 3 pontos de gravacao + `/dashboard/metrics` + `/financeiro/relatorio` |
| `app/page.js` | campo no dialog do produto, 2 cards no Dashboard, colunas no Relatorio + CSV |
| `backend_test_custo.py` | **novo** — 8 testes |

**Nenhuma funcao atomica do Postgres e tocada.** Era o principal risco tecnico e
a decisao §4.1 o contorna por inteiro.

**Por que so um repositorio muda** (verificado no codigo, nao suposto): nos dois
backends, `create()` grava a entidade inteira (`insert(entity)` no Supabase,
`insertOne(entity)` no Mongo) e `update()` aplica o patch inteiro
(`update(patch)` / `$set: patch`); no Supabase as leituras usam `select('*')`.
Campo novo na entidade propaga sozinho. A unica excecao e `normalize()` em
`mongo/transacaoRepository.js`, que monta o objeto campo a campo e descartaria
os tres novos em silencio.

## 12. O que esta feature desbloqueia

Ficha tecnica (insumos e receita por produto) e a proxima camada natural. Com
ela, `produtos.custo` deixa de ser digitado e passa a ser **derivado** da receita
— e o estoque, hoje limitado a itens de revenda, passa a funcionar para comida
preparada.

O contrato desta entrega nao muda quando isso acontecer: `custo` continua sendo
um numero por produto; so a origem dele muda de manual para calculada.
