# Caixa — Design

**Data:** 2026-08-13
**Escopo:** abertura e fechamento de caixa, sangria, suprimento, conferencia de
valores e estorno de venda. Inclui a correcao da forma de pagamento na origem.

---

## 1. Problema

O restaurante nao tem como fechar o dia. Nao existe registro de quanto dinheiro
entrou na gaveta, quanto saiu, nem conferencia entre o que o sistema calculou e
o que foi contado fisicamente. O dono fecha "no olho".

Dois problemas menores, no mesmo codigo, impedem que qualquer conferencia feche:

- **`transacoes` nao guarda forma de pagamento.** O livro-caixa sabe quanto
  entrou, mas nao por qual meio. Sem isso e impossivel separar o que esta na
  gaveta (dinheiro) do que caiu na conta (PIX, cartao).
- **Comanda com dois metodos perde um.** Ao fechar, o pedido gerado grava
  `pagamento: comanda.pagamentos?.[0]?.metodo` (`route.js:1635`) — conta
  dividida entre cartao e dinheiro vira "cartao" e o dinheiro some do registro.

E uma lacuna operacional: **nao existe estorno**. O codigo bloqueia alterar o
valor de um pedido concluido com 409 e orienta "registre um ajuste no
financeiro" (`route.js:1135`), mas esse lancamento nao existe como
funcionalidade — o dono teria que criar uma despesa solta na mao.

## 2. Decisoes tomadas

| Questao | Decisao |
|---|---|
| Quantos caixas | **Um por vez**, abre no inicio do dia e fecha no fim |
| O que o fechamento registra | **Valores finais** (conferencia), nao detalhe linha a linha |
| Fonte dos numeros | **`transacoes`** para dinheiro; **`pedidos`+`pedido_itens`** para produto |
| Sangria e receita? | **Nao.** Sangria move dinheiro da gaveta para o cofre — nao e despesa |
| Estorno e transacao? | **Sim.** Reduz faturamento de verdade |
| Venda sem caixa aberto | **Permitida**, com aviso na tela. Bloquear venda e pior que a falha |

### Por que sangria nao e despesa

Uma sangria tira dinheiro da gaveta e leva para o cofre ou o banco. O dinheiro
continua sendo do restaurante — nao virou custo. Se fosse gravada como
`transacao` do tipo despesa, o relatorio financeiro subtrairia esse valor do
lucro e o resultado do mes ficaria errado.

Por isso movimentos de gaveta vivem em tabela propria (`caixa_movimentos`) e
nunca entram em `transacoes`.

### Por que estorno e transacao

Um estorno devolve dinheiro ao cliente. O faturamento diminui de fato. Entra em
`transacoes` como despesa da categoria `Estorno`, amarrada ao `pedido_id`
original. O `total` do pedido permanece imutavel — o historico da venda nao se
reescreve; o acerto e um lancamento novo, do jeito que o proprio codigo ja
orientava.

## 3. Modelo de dados

### 3.1 Migration `0018_caixa.sql`

**Tabela nova `caixas`** — a sessao de caixa:

```
id                        uuid primary key
empresa_id                uuid not null  -> empresas(id)
status                    text not null default 'aberto'   -- 'aberto' | 'fechado'
aberto_por                uuid           -> usuarios(id)
aberto_por_nome           text not null default ''
aberto_em                 timestamptz not null default now()
valor_abertura            numeric(10,2) not null default 0  -- fundo de troco
fechado_por               uuid           -> usuarios(id)
fechado_por_nome          text not null default ''
fechado_em                timestamptz
valor_contado             numeric(10,2)  -- o que foi contado na gaveta
valor_esperado            numeric(10,2)  -- o que o sistema calculou
diferenca                 numeric(10,2)  -- contado - esperado (sobra/falta)
observacoes               text not null default ''
created_at                timestamptz not null default now()
```

- RLS por `empresa_id`
- Indice em `(empresa_id, status)` — a consulta quente e "existe caixa aberto?"
- **Indice unico parcial** garantindo um caixa aberto por empresa:
  `CREATE UNIQUE INDEX ON caixas (empresa_id) WHERE status = 'aberto'`

**Tabela nova `caixa_movimentos`** — sangria e suprimento:

```
id             uuid primary key
empresa_id     uuid not null  -> empresas(id)
caixa_id       uuid not null  -> caixas(id)
tipo           text not null              -- 'sangria' | 'suprimento'
valor          numeric(10,2) not null
motivo         text not null default ''
usuario_id     uuid           -> usuarios(id)
usuario_nome   text not null default ''
created_at     timestamptz not null default now()
```

- RLS por `empresa_id`
- Indice em `(empresa_id, caixa_id)`

**Colunas novas em `transacoes`:**

| Coluna | Tipo | Default | Responsabilidade |
|---|---|---|---|
| `forma_pagamento` | `text` | `''` | Metodo desta transacao (`pix`, `cartao`, `dinheiro`) |
| `caixa_id` | `uuid` | `null` | FK -> `caixas(id)`, `ON DELETE SET NULL`. Nulo em vendas feitas sem caixa aberto e em todas as transacoes anteriores a esta migration |

`caixa_id` explicito em vez de derivar por intervalo de horario: a derivacao
por timestamp e fragil e transforma toda conferencia em uma query de janela.
Com a coluna, o fechamento e uma soma direta e a auditoria e exata.

### 3.2 Contratos de dominio

- `Transacao` ganha `forma_pagamento: string` e `caixa_id: UUID | null`
- Interfaces novas `Caixa` e `CaixaMovimento`, ambas `extends TenantScoped`
- `CaixaRepository` e `CaixaMovimentoRepository` no contrato de repositorios
- Tipos novos: `CaixaStatus = 'aberto' | 'fechado'`,
  `CaixaMovimentoTipo = 'sangria' | 'suprimento'`

## 4. Regra de calculo do valor esperado

Somente **dinheiro** fica na gaveta. PIX e cartao caem na conta e nao entram na
contagem fisica.

```
valor_esperado =
    valor_abertura
  + receitas em dinheiro do caixa
  - estornos pagos em dinheiro do caixa
  + suprimentos
  - sangrias

diferenca = valor_contado - valor_esperado
```

Onde "do caixa" significa `transacoes.caixa_id = <id>` e
`transacoes.forma_pagamento = 'dinheiro'`.

`diferenca` positiva e sobra, negativa e falta. O sistema **nao bloqueia** o
fechamento por diferenca — registra o valor e exige observacao quando ela nao e
zero. Quem decide o que fazer com quebra de caixa e o dono, nao o software.

Calculo feito no Service, nunca em trigger — mesma regra do resto do projeto
(ADR-006).

## 5. Correcao da forma de pagamento

### 5.1 Uma transacao por pagamento

Ao fechar comanda, em vez de uma transacao com o primeiro metodo, gerar **uma
transacao por registro de pagamento**, cada uma com seu `forma_pagamento` e seu
`valor`.

A soma continua identica — nenhum numero do dashboard atual muda — mas o
livro-caixa passa a ser verdadeiro e a conferencia de dinheiro fecha.

Comanda sem pagamento registrado (fluxo antigo) gera uma transacao unica com
`forma_pagamento = 'dinheiro'`, preservando o comportamento atual.

### 5.2 Pedido direto

Pedido concluido fora de comanda ja tem `pedido.pagamento`. A transacao passa a
copiar esse valor para `forma_pagamento`.

### 5.3 Transacoes antigas

Ficam com `forma_pagamento = ''`. **Sem migracao retroativa** — nao ha dado de
onde inferir o metodo, e inventar um falsearia a auditoria. Os relatorios
mostram essas linhas como "nao informado".

## 6. API

### 6.1 Endpoints novos

| Metodo | Rota | Permissao | Comportamento |
|---|---|---|---|
| GET | `/caixa/atual` | qualquer autenticado | Caixa aberto da empresa com os valores parciais calculados, ou `null` |
| POST | `/caixa/abrir` | GERENTE+ | Abre com `valor_abertura`. 409 se ja houver caixa aberto |
| POST | `/caixa/fechar` | GERENTE+ | Recebe `valor_contado` e `observacoes`. Calcula esperado e diferenca, grava, muda status |
| POST | `/caixa/movimento` | GERENTE+ | Registra sangria ou suprimento no caixa aberto. 409 se nao houver caixa aberto |
| GET | `/caixa/historico` | GERENTE+ | Lista caixas fechados, mais recentes primeiro. Aceita `?limite=` |
| POST | `/pedidos/:id/estorno` | GERENTE+ | Estorna venda concluida. Exige `valor` e `motivo` |

### 6.2 Endpoints alterados

**Fechamento de comanda** (`POST /comandas/:id/fechar`) — passa a gerar uma
transacao por pagamento, cada uma com `forma_pagamento` e `caixa_id`.

**Conclusao de pedido** (`PATCH /pedidos/:id`) — a transacao de receita passa a
gravar `forma_pagamento` (de `pedido.pagamento`) e `caixa_id` (do caixa aberto,
ou nulo).

### 6.3 Validacoes

- `valor_abertura` numerico `>= 0`
- `valor_contado` numerico `>= 0`, obrigatorio no fechamento
- `observacoes` **obrigatoria** quando `diferenca != 0`
- Sangria nao pode exceder o dinheiro disponivel na gaveta naquele momento
  (`valor_esperado` parcial) — 400 com a mensagem dizendo quanto ha
- Estorno: `valor > 0` e `valor <= pedido.total`; `motivo` obrigatorio;
  pedido precisa estar concluido; um pedido nao pode ser estornado duas vezes
  alem do total (soma dos estornos anteriores entra na validacao)
- Toda operacao de caixa e estorno grava em `auditoria`

### 6.4 Repositorios

`caixaRepo` e `caixaMovimentoRepo` nos dois backends (Mongo e Supabase),
registrados na factory, no mesmo formato do `entregadorRepo`.

O `transacaoRepo` ganha um metodo de agregacao por caixa:
`somarPorFormaPagamento(empresaId, caixaId)` retornando
`{ forma_pagamento, tipo, total }[]` — usado pelo calculo do esperado e pelo
grafico de pizza dos relatorios (item 5 do roadmap).

## 7. Interface

### 7.1 Barra de status do caixa

Faixa no topo da tela Financeiro:

- **Caixa fechado** — botao "Abrir caixa", que pede o fundo de troco
- **Caixa aberto** — mostra desde quando, o total em dinheiro na gaveta agora e
  tres botoes: "Sangria", "Suprimento", "Fechar caixa"

### 7.2 Dialogo de fechamento

- Resumo por forma de pagamento (quanto entrou em dinheiro, PIX, cartao)
- Sangrias e suprimentos do periodo
- **Valor esperado em dinheiro**, calculado
- Campo "Valor contado" — o que esta fisicamente na gaveta
- A **diferenca aparece ao vivo** conforme o valor e digitado, verde para sobra
  e vermelho para falta
- Campo de observacoes, obrigatorio quando ha diferenca
- Botao "Confirmar fechamento"

### 7.3 Historico de caixas

Lista abaixo da barra: data, quem abriu, quem fechou, esperado, contado,
diferenca. Diferenca destacada quando nao e zero.

### 7.4 Estorno

Botao "Estornar" no pedido ja concluido. Abre dialogo com valor (padrao: total
do pedido, editavel para estorno parcial) e motivo obrigatorio. Depois de
estornado, o card do pedido mostra o valor estornado.

### 7.5 Aviso de caixa fechado

Ao concluir uma venda sem caixa aberto, avisar na tela: "Caixa fechado — esta
venda nao entrara em nenhuma conferencia." A venda acontece normalmente.

## 8. Testes

- Calculo do esperado com abertura, vendas em dinheiro, sangria e suprimento
- Vendas em PIX e cartao **nao** entram no esperado da gaveta
- Comanda com dois metodos gera duas transacoes, e a soma bate com o total
- Fechar caixa com diferenca sem observacao retorna 400
- Sangria maior que o disponivel retorna 400
- Abrir caixa com outro ja aberto retorna 409
- Sangria sem caixa aberto retorna 409
- Estorno em pedido nao concluido retorna 400
- Estorno acumulado acima do total do pedido retorna 400
- Estorno em dinheiro reduz o esperado da gaveta
- Isolamento multi-tenant: caixa de outra empresa retorna 404
- Venda com caixa fechado grava `caixa_id` nulo e nao quebra
- Todos os testes rodam contra os dois backends

## 9. Fora de escopo

- Multiplos caixas ou turnos simultaneos
- Conferencia por terminal ou por operador
- Fechamento parcial ou troca de turno sem fechar
- Graficos e relatorios por periodo (item 5 do roadmap, depende deste)
- Conciliacao bancaria de PIX e cartao
- Bloqueio de venda com caixa fechado
