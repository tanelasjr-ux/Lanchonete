# KDS (Tela de Cozinha) + Status pelo Celular — Design

Data: 2026-08-12
Status: aprovado pelo dono do projeto, pronto para virar plano de implementacao.

## 1. Contexto e problema

O papel `COZINHA` existe no sistema (RBAC, permissoes `dashboard`+`pedidos`) mas
nao tem tela propria — hoje ve o mesmo dashboard do gerente. Levantado como
lacuna de produto no HANDOFF (`§11`).

Ao mesmo tempo, o dono levantou uma segunda ideia: o atendente poder usar o
proprio celular. Depois de explorar as duas juntas, elas convergem num unico
ciclo operacional: **a cozinha le o que precisa fazer (KDS), o atendente
sinaliza quando um item sai (celular)**. Sem a segunda metade, o KDS acumula
cards de coisa ja entregue e perde a confianca de quem usa. A parte grande da
ideia original do dono — o atendente *lancar* pedidos pelo celular — fica
**fora deste escopo**, como projeto futuro separado (ver `§8`).

## 2. Decisoes de produto (tomadas nesta sessao, nao renegociar sem confirmar)

1. **KDS e um painel 100% passivo.** Roda numa TV comum da cozinha, sem
   toque, sem controle remoto, sem interacao nenhuma. So mostra.
2. **Conteudo minimo, sem enfeite:** ordem de chegada, o que e (item +
   quantidade), e excecoes (observacao tipo "sem cebola") em destaque. Nao
   ha colunas por status nem cronometro colorido — um cozinheiro sozinho
   precisa ler de relance, nao operar um dashboard.
3. **Quem tira o item da tela e o atendente, pelo celular**, com um toque em
   "saiu"/"pronto" na lista de pendentes. Existe tambem um **envelhecimento
   automatico** como rede de seguranca: item pendente ha muito tempo desce
   pra uma faixa discreta no rodape da TV (nunca some sozinho — perder um
   pedido de vista seria pior que a tela ficar poluida).
4. **A TV nao faz login como usuario.** Usa um link tokenizado, gerado uma
   vez na configuracao da empresa, colado no navegador da TV como pagina
   inicial. Ver `§5.4`.
5. **Observacao por item ("sem cebola") e feature separada, mais simples do
   que parecia:** o campo ja existe de ponta a ponta no backend (banco, RPC,
   rota) para os dois fluxos — falta so o campo na tela. Nao ha migration
   para isso, so UI (`§4`).

## 3. Levantamento tecnico (o que ja existe vs o que falta)

| Fluxo | Status de preparo hoje | Observacao por item hoje |
|---|---|---|
| **Pedido** (balcao/delivery/retirada) | Existe: `pedidos.status`, vocabulario duplo normalizado por `normPedidoStatus()` (`app/api/[[...path]]/route.js:1356`) | Coluna `pedido_itens.observacao` existe desde a migration `0002`; RPC `create_pedido_com_itens`/`upsert_pedido_com_itens` (migration `0015`) ja gravam. **So falta input na tela** (`PedidoDialog`, `app/page.js:641`). |
| **Comanda** (mesa) | **Nao existe.** `comanda_itens` nao tem nenhum campo de status — so `nome/preco/quantidade/desconto/observacao/created_at`. `comandas.status` e so `aberta`/`fechada`, nao serve pra isto. | Coluna `comanda_itens.observacao` existe desde a migration `0005` e a rota `PUT /comandas/:id/itens/:id` ja aceita (`route.js:1218`). **So falta input na tela** — nem no `PedidoDialog` (tipo mesa) nem na tela de comanda (`app/page.js:1355` `addItem`) o campo e enviado hoje. |

**Consequencia:** o unico gap real de backend e um jeito de saber se um item
de comanda ja saiu. Tudo o resto (pedidos e observacao) e leitura/UI sobre o
que ja existe.

## 4. Mudancas de dados

**Migration nova (`0016_kds.sql`)** — duas mudancas independentes, uma
migration porque nascem juntas para esta feature:

```sql
alter table public.comanda_itens
  add column if not exists entregue boolean not null default false;
create index if not exists idx_comanda_itens_pendentes
  on public.comanda_itens(empresa_id, comanda_id) where not entregue;

create table public.kds_tokens (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  token       text not null unique,
  criado_em   timestamptz not null default now(),
  revogado_em timestamptz
);
create index idx_kds_tokens_token on public.kds_tokens(token) where revogado_em is null;

alter table public.kds_tokens enable row level security;
create policy kds_tokens_tenant on public.kds_tokens
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
```

RLS por consistencia com o resto do schema (mesmo padrao de
`webhook_events`, migration `0007`) — mesmo sabendo que `service_role`
ignora RLS em runtime hoje (armadilha 13 do HANDOFF), a policy e defesa em
profundidade que nao custa nada a mais.

Um booleano, nao um enum de 3 estados — decisao consciente. O KDS so
distingue "ainda precisa ser feito" de "ja saiu"; nao ha coluna por status
pra justificar um vocabulario maior, e um enum aqui seria complexidade sem
uso (YAGNI). Itens existentes recebem `entregue = false` por omissao — no
pior caso aparecem uma vez no KDS ate serem marcados, o que e aceitavel
(nao ha como saber retroativamente o que ja foi servido).

**Nenhuma migration para `pedidos`/`pedido_itens`** — o campo de status
(pedido) e a observacao (pedido_itens) ja existem, como mapeado no `§3`.

## 5. Arquitetura

Segue a cadeia existente Route -> Controller -> Service -> Repository, dentro
do route handler catch-all unico (`app/api/[[...path]]/route.js`) e do
frontend SPA unico (`app/page.js`), sem introduzir nova stack.

### 5.1 Endpoint agregador (leitura do KDS e do celular)

`GET /kds/pendentes` — junta num unico payload:
- Pedidos de balcao/delivery/retirada com `normPedidoStatus() in ('novo',
  'em_preparacao')`, com seus itens.
- Itens de comanda aberta com `entregue = false`, cada um com o nome da mesa.

Cada elemento da lista carrega: origem (`pedido` ou `mesa`), identificador
para a acao de marcar como saiu, itens (ou o item, no caso de mesa),
observacao, `created_at`. Ordenado por `created_at` ascendente (fila: mais
antigo primeiro).

Permissao: exige `pedidos` — `COZINHA` e `ATENDENTE` ja tem essa permissao
hoje, nenhuma mudanca de RBAC necessaria para o celular. A TV usa o
mecanismo de token do `§5.4`, nao essa checagem de papel.

Escopado por `empresa_id` do contexto de autenticacao, como todo o resto do
sistema (regra do `§5` do `CLAUDE.md`).

### 5.2 Card = unidade real de criacao, nao agrupamento artificial

- **Pedido** (balcao/delivery/retirada): nasce de uma vez com todos os itens
  -> **um card com a lista de itens dentro**.
- **Item de comanda** (mesa): lancado um a um, em momentos diferentes ->
  **um card por item**, com o nome da mesa em destaque e horario proprio.

Agrupar tudo de uma mesa num card so misturaria um item lancado as 12h com
outro das 12h30 sob um cronometro so — informacao errada. O agrupamento por
mesa fica so visual (cards da mesma mesa proximos na tela), nunca uma fusao
de dados.

### 5.3 Acao de marcar como saiu (celular do atendente)

- **Pedido:** reaproveita `PUT /pedidos/:id` (ja existe) — grava
  `status = 'pronto'`. Sem mudanca de backend.
- **Item de comanda:** estende o patch ja aceito por `PUT
  /comandas/:id/itens/:itemId` (`route.js:1213`) para aceitar `entregue`,
  junto do que ja aceita hoje (`route.js:1218-1219` ja tem o padrao `if
  (b.campo !== undefined) patch.campo = b.campo` — so adicionar `entregue` a
  essa lista). Permissao `mesas`, que `ATENDENTE`/`GERENTE` ja tem.

Tela nova, leve, dentro do SPA existente: lista dos itens pendentes (mesmo
dado do `GET /kds/pendentes`), pensada pra tela de celular — um toque em
cada linha marca como saido. Sem edicao, sem criacao de pedido — so essa
acao. Acessada por login normal (o atendente ja tem usuario e senha; nao
precisa de link magico como a TV, porque o celular e pessoal/de trabalho e
ja fica logado).

### 5.4 Acesso da TV (sem login de usuario)

Tela de configuracao da empresa ganha uma acao "Gerar link da TV da
cozinha", que cria um token opaco de leitura associado a `empresa_id`,
guardado na tabela `kds_tokens` (schema completo no `§4`). Tabela nova, nao
reaproveita `integracoes` — aquela e tipada para configuracao de integracao
externa com credenciais de terceiro, nao para token de acesso proprio;
misturar os dois conceitos violaria o proposito da tabela existente.

Repository proprio (`kdsTokenRepository`), seguindo o padrao existente —
`route.js` continua sem conhecer driver de banco. O link
(`/kds/tv?token=...`) abre o painel **sem autenticacao de usuario**, so
validando o token contra a empresa (existe, `revogado_em is null`).

Superficie do token deliberadamente minima: da acesso **so** ao endpoint
`GET /kds/pendentes` daquela empresa. Nao le cliente, financeiro, cadastro,
nem qualquer outra rota. Se vazar, o dono revoga e gera outro na mesma tela
— nenhuma acao de escrita e possivel com ele.

Colar uma vez no navegador da TV, definir como pagina inicial, nunca mais
mexer. Sem sessao expirando: nao ha JWT de 7 dias aqui, o token nao expira
sozinho (so por revogacao manual) — resolve de raiz o problema que a
armadilha 14 do HANDOFF causaria numa TV (deslogar sozinha toda semana sem
ninguem pra digitar senha de novo).

## 6. Layout do KDS (TV)

Fila unica, cronologica, mais antigo no topo. Sem colunas por status, sem
cor indicando "em preparo" vs "pronto" — o unico estado que existe pro KDS e
"pendente" (nao ha leitura de "em preparo" nem "pronto" nesta versao, por
decisao do item 2 do `§2`).

Cada card, em fonte grande, legivel a distancia:
- Origem: numero do pedido, ou nome da mesa.
- Item(ns) + quantidade.
- Observacao (exececao), em destaque visual — o motivo de existir a tela.
- Ha quanto tempo esta pendente.

**Envelhecimento automatico:** passado um limite configuravel (padrao 20
minutos), o card se move para uma faixa discreta no rodape da tela, fora da
area principal — nunca some. Rede de seguranca contra o atendente esquecer
de marcar como saido; a cozinha continua enxergando o item se ainda estiver
la, so nao compete mais por atencao com o que acabou de chegar.

Atualizacao por polling a cada 5s (decidido anteriormente na sessao — sem
Supabase Realtime, que segue nao iniciado no projeto).

## 7. Campo de observacao (UI)

Adicionar input de texto curto ("Observacao (opcional)") por item em dois
lugares:

1. **`PedidoDialog`** (`app/page.js:641`) — ao adicionar um produto,
   opcionalmente anexar observacao. **Cuidado:** a funcao `add()` (linha
   657) hoje funde itens repetidos do mesmo `produto_id` incrementando
   quantidade — um item com observacao **nao pode se fundir** com uma
   unidade lisa do mesmo produto (2 hamburgueres, um sem cebola, sao duas
   linhas, nao uma linha de quantidade 2). Ajustar a chave de agrupamento
   para `produto_id + observacao`.
2. **Tela de comanda** (`app/page.js:1355`, `addItem`) — mesma logica ao
   lancar item na mesa.

Sem edicao de observacao depois de lancado (nem pedido nem comanda tem esse
padrao hoje pra outros campos do item) — se errar, remove e lanca de novo,
como ja funciona para quantidade zerada (`setQty` remove ao chegar em 0).

## 8. Fora de escopo (fica para depois)

- **App de lancar pedido pelo celular** (a ideia grande original do dono).
  O celular deste design so *le* pendentes e marca "saiu" — nao cria
  pedido. Projeto proprio, com seu proprio brainstorm.
- **Colunas por status / cronometro colorido / toque na propria TV** —
  avaliadas e descartadas nesta sessao (`§2`), TV comum sem toque e cozinha
  com um unico cozinheiro sem tempo pra operar a tela.
- **Estacoes de preparo** (chapa, fritadeira, etc.) — faz sentido pra
  cozinha grande com varias pracas; nao pra uma lanchonete.

## 9. Testes

- **Migration:** `comanda_itens` existentes recebem `entregue = false` sem
  quebrar leitura/gravacao existente (isolamento de regressao, `§12` do
  `CLAUDE.md`).
- **Backend:** isolamento multi-tenant no `GET /kds/pendentes` (empresa A
  nunca ve pendente de empresa B); pedidos `cancelado`/`concluido`/`ENTREGUE`
  nao aparecem; item de comanda marcado `entregue` some da lista; token da TV
  so le a propria empresa e nenhuma escrita e possivel com ele; token
  revogado deixa de funcionar.
- **Frontend (Playwright):** criar pedido com observacao -> aparece no KDS
  em destaque; lancar item em comanda -> aparece no KDS; marcar "saiu" no
  celular -> some do KDS dentro do intervalo de polling; item antigo desce
  pra faixa de envelhecimento sem sumir.

## 10. Documentos relacionados

- `HANDOFF.md` `§11` — pendencia original que motivou este design.
- `HANDOFF.md` `§10` armadilha 14 — token de 7 dias sem refresh; resolvido
  para a TV pelo mecanismo do `§5.4`, mas segue pendente para o resto do
  sistema.
- `HANDOFF.md` `§4.3` — ordem de execucao de migrations; `0016` entra depois
  de `0015`.
