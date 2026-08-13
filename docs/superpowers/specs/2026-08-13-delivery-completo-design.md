# Delivery Completo — Design

**Data:** 2026-08-13
**Status:** aprovado pelo dono do projeto
**Escopo:** endereço de entrega, taxa, tempo estimado e entregador em pedidos `tipo: 'delivery'`

---

## 1. Problema

Hoje `pedidos.tipo` aceita `'delivery'`, mas o pedido não guarda nada específico
de entrega: não há endereço, taxa, tempo prometido nem registro de quem levou.
Na prática o restaurante anota isso fora do sistema. Esta é a última lacuna que
impede o Restaurant OS de operar um delivery real.

## 2. Decisões tomadas

| Questão | Decisão |
|---|---|
| Origem do endereço | Padrão vem do cadastro do cliente, editável no pedido; o pedido guarda um **snapshot** do endereço usado |
| Taxa de entrega | **Taxa fixa por empresa** (configurável), sugerida no pedido e editável pelo atendente |
| Entregador | **Cadastro simples** por empresa (nome, telefone, ativo). Não faz login no sistema |
| Fluxo de status | Delivery ganha `saiu_para_entrega` entre `pronto` e `concluido` |
| Tempo estimado | Padrão por empresa, editável no pedido; pedidos atrasados destacados na tela |
| Onde acompanhar | Dentro da tela **Pedidos** existente (filtro + informação nos cards), sem tela nova |
| Modelagem | **Campos no próprio pedido** (não tabela `entregas` 1:1, não JSON) |

### Por que campos no pedido e não uma tabela `entregas`

Um pedido de delivery é um pedido. Listar, buscar, editar e imprimir continua
sendo uma query só, nos dois backends. Uma tabela 1:1 obrigaria join ou segunda
query em todo caminho de leitura, em Mongo **e** Supabase, para um ganho
hipotético (histórico de rastreamento) que não está no escopo. O projeto já usa
esse padrão: `pedidos.comanda_id` é opcional e nulo na maioria dos pedidos.

### Por que a taxa não usa o campo `acrescimo`

O comentário atual em `packages/domain/src/index.ts` sugere `acrescimo` para
taxa de entrega. Rejeitado: com a taxa dissolvida no acréscimo genérico é
impossível responder "quanto faturei de taxa de entrega no mês" ou imprimir a
linha "Taxa de entrega" no cupom — o dado se perde no momento da gravação e não
há como recuperá-lo depois. `acrescimo` permanece o ajuste manual genérico
(cortesia, arredondamento, acerto pontual).

---

## 3. Modelo de dados

### 3.1 Migration `0017_delivery.sql`

Colunas novas em `pedidos` — todas com default, nenhuma obrigatória, para não
quebrar pedidos existentes nem os outros tipos:

| Coluna | Tipo | Default | Responsabilidade |
|---|---|---|---|
| `entrega_endereco` | `text` | `''` | Snapshot do endereço usado neste pedido |
| `entrega_taxa` | `numeric(10,2)` | `0` | Taxa cobrada neste pedido |
| `entrega_tempo_estimado_min` | `integer` | `null` | Minutos prometidos ao cliente |
| `entregador_id` | `uuid` | `null` | FK → `entregadores(id)`, `ON DELETE SET NULL` |
| `entregador_nome` | `text` | `''` | Snapshot do nome de quem levou |
| `saiu_para_entrega_em` | `timestamptz` | `null` | Quando o pedido saiu para a rua |

`entregador_nome` é snapshot pelo mesmo motivo que `pedido_itens.nome` e
`.preco` são: se o entregador for desativado ou removido meses depois, os
pedidos antigos continuam dizendo quem levou.

### 3.2 Tabela nova `entregadores`

```
id           uuid primary key
empresa_id   uuid not null  → empresas(id)
nome         text not null
telefone     text not null default ''
ativo        boolean not null default true
created_at   timestamptz not null default now()
```

- RLS por `empresa_id`, no mesmo formato das demais tabelas do projeto
- Índice em `(empresa_id, ativo)`
- Mongo é schemaless: o repositório apenas passa a gravar os campos; o índice
  correspondente entra em `ensureMongoIndexes()` na factory

### 3.3 Config da empresa

Dentro do JSON `empresas.config` (sem migração de coluna):

```json
{ "delivery": { "taxa_padrao": 8, "tempo_estimado_min": 40 } }
```

(valores acima são exemplo). Empresa sem o bloco `delivery` no config se comporta
como `taxa_padrao: 0` e `tempo_estimado_min: null` — nenhuma migração de dados é
necessária para as empresas já existentes.

### 3.4 Contratos de domínio

- `PedidoStatus` ganha `'saiu_para_entrega'` (canônico, minúsculo).
  `normPedidoStatus()` passa a mapear o legado `'SAIU_PARA_ENTREGA'` para ele.
- Interface `Pedido` ganha os seis campos da tabela acima.
- Interface nova `Entregador extends TenantScoped`.
- `EmpresaConfig` ganha `delivery: EmpresaDeliveryConfig`.
- `EntregadorRepository` no contrato de repositórios.

---

## 4. Regra de cálculo do total

A gramática de valores do pedido passa de:

```
total = subtotal - desconto + acrescimo
```

para:

```
total = subtotal - desconto + acrescimo + entrega_taxa
```

`computePedidoValores()` recebe a taxa como quarto parâmetro. Consequências
tratadas junto:

- A validação existente "desconto maior que o valor do pedido" passa a comparar
  contra `subtotal + acrescimo + entrega_taxa`.
- Pedidos anteriores à migration ficam com `entrega_taxa = 0` — total
  inalterado, **sem recálculo retroativo**.
- Pedido que não é delivery sempre grava `entrega_taxa = 0`, mesmo que o cliente
  envie outro valor.

---

## 5. API

### 5.1 Endpoints novos

| Método | Rota | Permissão | Comportamento |
|---|---|---|---|
| GET | `/entregadores` | qualquer autenticado | Lista da empresa. `?ativo=true` filtra para o seletor de pedido |
| POST | `/entregadores` | GERENTE+ | Cria. `nome` obrigatório, `telefone` opcional |
| PUT | `/entregadores/:id` | GERENTE+ | Edita `nome`, `telefone`, `ativo` |
| DELETE | `/entregadores/:id` | GERENTE+ | **Soft-delete** via `ativo = false`. Nunca hard-delete: pedidos apontam para o registro |

### 5.2 Endpoints alterados

**`POST /pedidos`** — quando `tipo === 'delivery'`, aceita `entrega_endereco`,
`entrega_taxa`, `entrega_tempo_estimado_min`. Campos ausentes recebem os padrões
da empresa (lidos do `config` no servidor). Quando `tipo !== 'delivery'`, os
campos são ignorados e gravados zerados — o servidor não confia no cliente.

**`PUT /pedidos/:id`** — os mesmos campos ficam editáveis enquanto o pedido não
estiver `concluido` nem `cancelado`, recalculando o total. Trocar o `tipo`
de/para `delivery` ajusta a taxa junto (para delivery aplica o padrão da
empresa; saindo de delivery zera os campos de entrega).

**`PATCH /pedidos/:id/status`** — ao entrar em `saiu_para_entrega`:
- exige `entregador_id` no corpo (400 se ausente)
- grava `entregador_nome` lido do banco, **nunca** do corpo da requisição
- grava `saiu_para_entrega_em = now()`
- recusa o status com 400 se o pedido não for `tipo: 'delivery'`

**`PUT /empresa`** — passa a aceitar `config.delivery.taxa_padrao` e
`config.delivery.tempo_estimado_min`.

### 5.3 Validações

- `entrega_taxa` numérica `>= 0`
- `entrega_tempo_estimado_min` inteiro `> 0` ou nulo
- `entregador_id` deve existir **e pertencer à empresa** — caso contrário 404,
  não 403: não vaza a existência de entregador de outro tenant
- Endereço vazio em pedido delivery **não bloqueia** (a UI avisa). Pedido de
  balcão que vira delivery no meio do atendimento é situação real

### 5.4 Repositórios

`entregadorRepo` implementado nos dois backends (Mongo e Supabase) e registrado
na factory, seguindo exatamente o formato do `kdsTokenRepo`.

---

## 6. Interface

### 6.1 Configurações → Empresa

Bloco novo "Delivery", no mesmo formato visual do bloco de links de TV do KDS:
- Taxa padrão de entrega
- Tempo médio de entrega (minutos)
- Lista de entregadores com adicionar, editar e desativar inline

### 6.2 Diálogo de Pedido

Quando `tipo === 'delivery'`, revela três campos (ocultos nos demais tipos):

- **Endereço de entrega** — pré-preenchido com o endereço do cliente assim que
  ele é selecionado; editável. Cliente sem endereço: campo vazio com o aviso
  "cliente sem endereço cadastrado"
- **Taxa de entrega** — pré-preenchida com o padrão da empresa; editável
- **Tempo estimado (min)** — pré-preenchido com o padrão da empresa; editável

O resumo de valores ganha a linha "Taxa de entrega", entre o acréscimo e o
total.

### 6.3 Tela de Pedidos

- O filtro por tipo ganha a opção **Delivery**
- Cards de pedido delivery mostram endereço (truncado), taxa e — depois de sair
  — o entregador e há quanto tempo está na rua
- Pedido que ultrapassou o tempo estimado é destacado, reusando a lógica de
  envelhecimento já escrita para o KDS
- O botão de avançar status, em pedido delivery com status `pronto`, abre um
  seletor de entregador antes de mudar para "Saiu para entrega"

### 6.4 Cupom impresso

Linha "Taxa de entrega" no bloco de valores e o endereço de entrega no rodapé.

### 6.5 KDS

Sem mudanças. A cozinha não precisa de endereço nem de entregador.

---

## 7. Testes

- `computePedidoValores()` com taxa: total correto, e a validação de desconto
  considerando a taxa
- `POST /pedidos` aplica os padrões da empresa quando os campos vêm ausentes
- `POST /pedidos` zera campos de entrega em pedido que não é delivery
- `PATCH /status` recusa `saiu_para_entrega` em pedido não-delivery (400)
- `PATCH /status` exige `entregador_id` e grava o nome vindo do banco
- `entregador_id` de outra empresa retorna 404 (isolamento multi-tenant)
- `DELETE /entregadores/:id` desativa sem apagar, e pedidos antigos preservam
  `entregador_nome`
- Todos os testes de API rodam contra os dois backends, como o restante da suíte

---

## 8. Fora de escopo

- Taxa por bairro ou por distância
- Entregador com login próprio e tela mobile
- Rastreamento em mapa ou histórico de eventos de entrega
- Notificação automática ao cliente por WhatsApp quando o pedido sai
- Roteirização ou agrupamento de entregas
