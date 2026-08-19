# PDV — Cobranca no cartao pela maquininha (Mercado Pago Point) — Design

**Data:** 2026-08-19
**Escopo:** cobrar no cartao direto pela maquininha, sem ninguem digitar o valor,
com confirmacao real do adquirente. Vale para comanda (mesa), balcao e delivery.
**Fora de escopo:** estorno pela maquininha, integracao com Stone/Cielo/PagBank.

---

## 1. Problema

Hoje o sistema **acredita no atendente**. Quando alguem clica "cartao" numa
comanda, o backend grava na hora:

```js
// route.js — POST /comandas/:id/pagamentos
metodo: b.metodo, valor: Number(b.valor), status: 'approved', provider: 'manual',
```

Ninguem verificou nada. Isso cria tres problemas reais:

1. **Erro de digitacao.** R$ 145,00 virando R$ 14,50 na maquininha e dinheiro
   perdido que so aparece na conciliacao do fim do mes, se aparecer.
2. **Venda fantasma.** Se o cartao foi recusado e o atendente clicou "cartao"
   assim mesmo, a comanda fecha com dinheiro que nunca entrou. O sistema nao
   tem como saber.
3. **Trabalho dobrado.** Digitar o valor duas vezes, no sistema e na maquininha.

O objetivo aqui e o item 2 tanto quanto o 1: **prova de que o pagamento
aconteceu**, nao a palavra de quem estava no caixa.

### Por que agora

Nao ha demanda operacional — a producao tem 1 empresa e **zero pagamentos no
cartao registrados** (conferido em `transacoes` no dia 2026-08-19). A motivacao
e **comercial**: ter integracao com maquininha como diferencial de venda. Isso
define o criterio de sucesso — precisa ser **real e demonstravel**, nunca
simulado — e justifica escolher o caminho mais curto ate algo que funcione de
verdade, em vez do mais abrangente.

## 2. Decisoes tomadas

| Questao | Decisao |
|---|---|
| Qual adquirente primeiro | **Mercado Pago Point** |
| Por que | E o unico que cobra pela maquininha **por API de nuvem**, sem app instalado. E o sistema ja tem credencial MP por empresa + webhook validado |
| Stone / Cielo / PagBank | **Fora do v1.** Todas exigem app Android rodando dentro da maquininha; Stone e Rede ainda exigem homologacao tecnica |
| TEF tradicional (CliSiTef) | **Descartado.** Exige PC Windows + pinpad + software por loja — incompativel com SaaS web |
| Qual API do MP | **Orders API** (`/v1/orders`). A Payment Intents API e legado e tem guia de migracao publicado |
| Onde funciona | **Comanda, balcao e delivery** |
| O que a aprovacao faz com o pedido | Marca como **pago**. O pedido segue o ciclo normal (cozinha -> pronto -> concluido) |
| Pagamento manual continua? | **Sim.** E o fallback pra quem nao tem Point e pra maquininha fora do ar |
| Estorno pela maquininha | **Fora do v1.** Cancelar cobranca *pendente* entra; estornar cobranca *aprovada* fica pra depois |
| Quantas maquininhas por empresa | **Uma.** Multiplos terminais e extensao natural, nao v1 |

### Por que "pago" e diferente de "concluido"

Hoje, no balcao, tres coisas acontecem no mesmo instante: o pedido e concluido,
o dinheiro entra e a receita e lancada. Sao a mesma acao.

Com cartao de verdade isso se separa. Um pedido "para levar" ou de delivery e
**pago primeiro e preparado depois**. Se a aprovacao do cartao concluisse o
pedido, ele **sumiria da fila da cozinha antes de a comida existir** — o KDS
perderia o pedido.

Por isso: aprovacao marca **pago** e lanca a receita (o dinheiro entrou de
verdade — mesma regra de regime de caixa que `contas` ja usa). A conclusao
continua sendo o momento em que a comida fica pronta e sai.

### Por que nao existe "PdvProvider plugavel" de verdade

O `PaymentProvider` atual (`lib/integrations/payments/provider.js`) e uma
abstracao honesta porque todos os gateways que ele cobre sao **HTTP a partir do
servidor**. Maquininha nao e assim:

- **Mercado Pago Point:** o servidor chama a API do MP. Adapter no servidor.
- **Stone / Cielo / PagBank:** o codigo roda **dentro da maquininha**, num app
  Android que chama o SDK local e depois avisa o servidor.

Um adapter Stone **nao pode existir no servidor**. Fingir que os dois encaixam
na mesma interface criaria uma abstracao mentirosa — do mesmo tipo que as
feature flags decorativas do B1, que existiam e ninguem lia.

O que fica generico de verdade (e e o que permite Stone amanha sem reescrever):

- o **ciclo de vida** do pagamento: nasce `pending`, vira `approved` /
  `rejected` / `cancelled`
- a **API interna** que a tela consome: a tela nunca sabe qual maquininha e
- o **ponto de confirmacao**: qualquer origem (webhook do MP hoje, app Android
  amanha) entra pelo mesmo caminho de "esta cobranca foi resolvida"

Uma futura integracao Stone reaproveita fluxo de comanda, ciclo do pagamento,
conferencia de caixa e telas. O que ela precisa de novo e o app Android e um
endpoint autenticado que ele chame — nao um redesenho.

## 3. Contrato da API do Mercado Pago (Orders API)

Confirmado na documentacao em 2026-08-19. **Usar Orders API, nao Payment
Intents** (legado).

| Operacao | Chamada |
|---|---|
| Criar cobranca | `POST https://api.mercadopago.com/v1/orders` |
| Consultar | `GET https://api.mercadopago.com/v1/orders/{order_id}` |
| Cancelar | `POST https://api.mercadopago.com/v1/orders/{order_id}/cancel` |

Corpo da criacao (campos que importam):

- `type` — tipo da ordem (point)
- `external_reference` — **usar `{empresa_id}:{comanda|pedido}:{id}`**, mesmo
  padrao ja usado no Pix (`route.js`, `POST /comandas/:id/pix`)
- `expiration_time` — expiracao da cobranca
- `transactions.payments[].amount` — **valor em reais, string com 2 casas
  decimais** (nao centavos)
- `config.point.terminal_id` — **qual maquininha acende**

Estados da ordem: `created`, `at_terminal`, `expired`, `canceled`, `refunded`,
`processed`.

**Notificacao:** topico **`order.processed`**, configurado no painel do Mercado
Pago apontando para a URL do webhook. E um topico **diferente** do que o Pix usa
(`payment`) — por isso o design tem uma rota de webhook separada.

**A confirmar na implementacao** (a doc varia por pais e versao): o valor exato
de `type`, o formato de `expiration_time`, e se `processed` vem acompanhado de um
status de pagamento aprovado/recusado dentro do payload. A defesa contra isso
esta no item 6: o sistema **nunca confia no corpo do webhook**, sempre consulta
`GET /v1/orders/{id}` para decidir.

## 4. Modelo de dados

### 4.1 Migration `0029_pdv_point.sql`

Uma unica mudanca de schema:

```sql
-- Momento em que o pedido foi pago por uma cobranca rastreada (maquininha).
-- NULL = nao pago por esse caminho, o que inclui todo o historico anterior a
-- esta migration e todo pagamento manual (dinheiro, cartao digitado).
alter table public.pedidos
  add column if not exists pago_em timestamptz;
```

`terminal_id` **nao ganha coluna nenhuma.** Vai dentro de `integracoes.config`
(que ja e `jsonb`) da integracao `mercadopago` que ja existe, junto do
`accessToken` — mesma conta, mesma credencial. Criar uma integracao separada pra
maquininha faria duas fontes de verdade para a mesma conta do Mercado Pago.

### 4.2 `pagamentos` — sem mudanca de schema

A tabela ja tem tudo:

| Campo | Uso no Point |
|---|---|
| `provider` | `'mercadopago_point'` |
| `provider_payment_id` | o `order_id` do Mercado Pago |
| `status` | `pending` -> `approved` / `rejected` / `cancelled` |
| `idempotency_key` | ja usado |
| `external_reference` | `{empresa_id}:{comanda\|pedido}:{id}` |
| `comanda_id` / `pedido_id` | ja existem os dois |

**`pedido_id` ja existe e nunca foi usado** — o fluxo de pedido nunca gravou em
`pagamentos`. Este design passa a usar.

### 4.3 Por que `pago_em` e coluna, e nao derivado

O projeto prefere status derivado (`contas.atrasada`, `assinatura.atrasada`) —
mas ali o dado de origem e uma **data**, e derivar e trivial e sempre correto.

Aqui seria derivar de "existe pagamento aprovado para este pedido", o que
**funciona so para pedidos pagos por Point**. Pagamento manual (dinheiro, cartao
digitado) nao grava linha em `pagamentos` — entao o derivado responderia "nao
pago" para uma venda em dinheiro perfeitamente paga. Um campo que mente para o
caso mais comum e pior que uma coluna.

`pago_em` e gravado no momento da aprovacao e nunca recalculado.

## 5. API interna

| Metodo | Rota | O que faz |
|---|---|---|
| `POST` | `/comandas/:id/cartao` | cria cobranca no terminal, devolve pagamento `pending` |
| `POST` | `/pedidos/:id/cartao` | idem, para balcao e delivery |
| `POST` | `/pagamentos/:id/cancelar-cobranca` | cancela cobranca pendente no MP |
| `GET` | `/pagamentos/:id` | **ja existe** — a tela usa para acompanhar |
| `POST` | `/pagamentos/webhook/point` | confirmacao (topico `order.processed`) |

Permissao: as rotas de cobranca exigem `can(ctx.papel, 'pagamentos')`, igual ao
Pix. O webhook e pre-auth e valida assinatura, igual ao do Mercado Pago atual.

### 5.1 `GET /pagamentos/:id` ganha consulta ativa

Hoje o endpoint so le o banco. Passa a ter uma regra: **se o pagamento esta
`pending` ha mais de 3 segundos e e do provider `mercadopago_point`, consulta
`GET /v1/orders/{id}` no Mercado Pago antes de responder.**

Isso torna o webhook um **atalho, nao uma dependencia**. Ver item 6.

## 6. Fluxos

### 6.1 Comanda (mesa)

1. Caixa clica **"Cobrar no cartao"** na comanda
2. `POST /comandas/:id/cartao` com o valor (padrao: o `restante`)
3. Backend cria a ordem no MP com o `terminal_id` da empresa, grava `pagamentos`
   com `status: 'pending'`, devolve o id
4. **A maquininha acende com o valor.** Ninguem digita
5. Tela mostra *"Aguardando o cliente na maquininha..."* + botao **Cancelar**,
   consultando `GET /pagamentos/:id` a cada 2s
6. Cliente paga -> MP notifica -> backend consulta a ordem, grava `approved` e
   empurra para o resumo da comanda (`pushPagamentoResumo`, ja existe)
7. A tela ve `approved`: mostra sucesso, o `restante` cai, comanda pode fechar

Recusado ou cancelado: a tela mostra o motivo, **a comanda fica intacta**, e o
caixa tenta outra forma de pagamento.

### 6.2 Balcao e delivery (pedido)

Identico ate o passo 6. Na aprovacao:

1. grava `pagamentos` com `approved`
2. grava `pedidos.pago_em`
3. **lanca a receita** em `transacoes` (com `forma_pagamento`, `caixa_id` se
   houver caixa aberto, e os campos de custo — mesma logica que
   `PUT /pedidos/:id` ja usa ao concluir)
4. **nao mexe no `status` do pedido** — ele segue para a cozinha normalmente

### 6.3 Regra critica: receita lancada uma vez so

`PUT /pedidos/:id` com `status: 'concluido'` **cria uma transacao de receita
hoje**. Se o pedido ja foi pago por cartao, essa transacao ja existe — concluir
depois criaria uma **segunda**, dobrando o faturamento do dia.

Regra: **ao concluir um pedido, so lanca receita se `pago_em` for nulo.**

Este e o ponto de maior risco financeiro do design inteiro e precisa de teste
dedicado (item 8).

## 7. Erros e casos chatos

| Situacao | Comportamento |
|---|---|
| **Cliente desiste / demora** | Botao Cancelar chama `POST /v1/orders/{id}/cancel`. **Sem isso a maquininha fica travada** esperando e o caixa nao consegue cobrar de novo |
| **Webhook nao chega** (rede da loja caiu, MP atrasou) | O polling consulta o MP direto (item 5.1). O caixa nunca fica travado sem saber se pode liberar o cliente |
| **Webhook chega duas vezes** | Dedupe por evento em `webhook_events`, igual ao webhook atual |
| **Maquininha nao configurada** (`terminal_id` ausente) | 400 com "Maquininha nao configurada". **Nunca simular sucesso** |
| **Mercado Pago fora do ar** | 502 com mensagem clara. Caixa cai no pagamento manual |
| **Duas cobrancas na mesma comanda** | O terminal aceita uma ordem por vez; a segunda recebe erro do MP e a tela mostra "maquininha ocupada" |
| **Ordem expira** | Estado `expired` -> pagamento vira `cancelled`, comanda intacta |
| **Aprovou mas o navegador fechou** | O pagamento esta gravado. Ao reabrir a comanda, ele aparece no resumo — a verdade esta no banco, nao na tela |

## 8. Testes

**Unitarios** (`test_point_calculo.mjs`, modulo puro, sem rede)
- formatacao do valor em reais com 2 casas (o erro classico: mandar centavos)
- montagem do `external_reference`
- traducao de estado da ordem MP -> status interno (`processed` -> `approved`,
  `expired`/`canceled` -> `cancelled`)

**Integracao** (`tests/backend_test_pdv.py`)
- cobrar sem `terminal_id` configurado -> 400, nao simula
- cobranca criada nasce `pending` e nao altera o `restante` da comanda
- webhook aprova -> comanda reflete o pagamento e o `restante` cai
- webhook aprova pedido -> `pago_em` preenchido, receita lancada, **`status` do
  pedido inalterado** (continua indo pra cozinha)
- **concluir pedido ja pago NAO lanca receita duas vezes** (item 6.3)
- cancelar cobranca pendente -> pagamento vira `cancelled`
- webhook duplicado nao processa duas vezes
- isolamento multi-tenant: empresa A nao confirma pagamento de empresa B

**Manual, insubstituivel:** cobrar de verdade numa Point Smart fisica. E o que
valida a demo de venda — e a unica prova de que a integracao existe.

## 9. Frontend

- **Comanda:** botao "Cobrar no cartao" ao lado do "Gerar Pix" ja existente
- **Pedido:** botao equivalente na tela de pedidos
- **Dialogo de espera:** valor, *"Aguardando o cliente na maquininha..."*,
  spinner, botao Cancelar. Consulta `GET /pagamentos/:id` a cada 2s, para em
  ~3 min (a ordem ja expirou nesse ponto)
- **Configuracao:** campo `terminal_id` na aba Integracoes, junto do Access
  Token do Mercado Pago que ja existe la

Nota: o fluxo de Pix atual **nao atualiza a tela sozinho** — mostra "pending" e
congela. O cartao **precisa** atualizar, porque o caixa esta parado na frente do
cliente. Essa e a unica parte do design que nao e copia do que ja existe.

## 10. Pre-requisitos fora do codigo

1. **Comprar uma Point Smart** e vincular a conta Mercado Pago
2. **Confirmar com o suporte do MP que o modelo exato aceita integracao por API**
   (a doc cita "Point Smart" e "Point Plus"; o modelo em loja hoje e o "Point
   Smart 2"). Sem isso, a maquininha nao integra
3. **Configurar o webhook** no painel do MP, topico `order.processed`, apontando
   para `/api/pagamentos/webhook/point?tenant=<empresa_id>`
4. **Pegar o `terminal_id`** no painel de desenvolvedor

## 11. Nota comercial

O Mercado Pago cobra **~4,99% no credito a vista** contra ~2,99% da Stone
(referencia 2026). Num restaurante de R$ 50 mil/mes com 60% no credito, isso e
**~R$ 600/mes a mais** — provavelmente mais que a mensalidade do sistema.

Consequencia pro discurso de venda: **nao pedir para o cliente trocar de
maquininha.** O pitch que funciona e *"se voce ja usa Mercado Pago, o sistema
conversa direto com sua maquininha"*. A favor do MP: o credito cai em **D+14**
contra D+30 dos concorrentes.

## 12. Referencias

- [Point — processamento de pagamento (Orders API)](https://www.mercadopago.com.mx/developers/en/docs/mp-point/payment-processing)
- [Point — configurar notificacoes](https://www.mercadopago.com.mx/developers/en/docs/mp-point/integration-configuration/integrate-with-pdv/notifications)
- [Novos status para pagamentos Point](https://www.mercadopago.com.ar/developers/en/news/2025/04/09/New-statuses-for-Payments-made-with-Point-Terminals)
- [Integrar SmartPOS Stone/Rede/Cielo/PagBank (por que ficou de fora)](http://www.team17.com.br/blog-post-smartpos.html)
- [Comparativo de taxas 2026](https://dinheirodaminhaempresa.com/comparativos/maquininha-stone-pagbank-cielo-mercadopago-rede-2026/)
