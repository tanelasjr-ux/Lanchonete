# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-13 (KDS 100% COMPLETO — 11/11 tasks, pronto para merge/deploy)

## Como usar este arquivo

Leia este arquivo **primeiro** em qualquer sessao de trabalho neste projeto.
Ele e a memoria de longo prazo do Restaurant OS: deve ser possivel entender o
sistema inteiro lendo este documento + os arquivos em `docs/` que ele
referencia, sem depender de historico de conversa.

Quando o dono do projeto pedir um handoff, este arquivo e **reescrito por
completo** com o estado atual (nao e um resumo do dia — e o retrato inteiro
do projeto, atualizado). A regra formal esta em `CLAUDE.md`, secao 18.1.

---

# 0. PONTO DE RETOMADA (leia isto primeiro)

**O app esta NO AR e em uso:**

```
https://restaurante-app.ilmdzk.easypanel.host
```

Rodando sobre **Supabase**, com HTTPS, no projeto `restaurante` do EasyPanel.
O dono ja opera pela interface (empresa "Tanelas FooD").

**Estado do codigo:** **sincronizado com GitHub** (`main` em dia). Todas as
melhorias publicadas. EasyPanel implanta automaticamente ao receber push.

**Entregue e PUBLICADO:**
1. Correcao do tema que revertia sozinho depois de ~2s.
2. Desconto e acrescimo em pedidos, com ajuste apos a criacao.
3. Upload de logo por arquivo (antes so aceitava colar URL).
4. **Impressao de cupom** — comanda da cozinha (sem precos) e via do
   cliente (com valores), para qualquer pedido ou fechamento de comanda.
   Ver §4.1 (decisao estrutural) e §10 armadilha 21.
5. **Correcao do bug de impressao** (container id no body, nao no JSX) —
   imprimia pagina em branco em producao; achado testando ao vivo.

**KITCHEN DISPLAY SYSTEM (KDS) — 11/11 TASKS COMPLETAS ✅**
Implementacao via subagent-driven-development, plano executado completamente (`docs/plans/KDS-IMPLEMENTATION-PLAN.md`).

**Status: 100% PRONTO PARA MERGE E DEPLOY**

✅ **Backend (Tasks 1-6):** migration 0016, domain contracts, kdsTokenRepository, dual-auth endpoints (GET /kds/pendentes + POST /kds/concluir), token lifecycle management (GET/POST/DELETE /kds/tokens)

✅ **Frontend (Tasks 7-10):** observação field UI, KDS components (KDSPainel, KDSTv, CozinhaPendentes), integração no App() (TV link + nav COZINHA), config screen (Empresa tab para gerar/revogar links)

✅ **Validation (Task 11):** testes 40/40 + 32/33 (baseline), build clean, security checklist completa (multi-tenant isolation, token permissions, RLS coverage)

**Deferred findings (nao-bloqueadores, podem ser corrigidos em sprint futuro):**
- Task 3: kds_tokens sem indices Mongo (Task 8 has it via RLS) — adicionar a ensureMongoIndexes() quando Mongo indexing for revisitado
- Task 5: POST /kds/concluir mesa branch silent ok se id inexistente (cosmético, nao affects UX) — standardizar 404 handling se quiser

**Ledger completo:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/progress.md`
**Briefs por task:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/task-{1..7}-brief.md`
**Reports por task:** `.superpowers/sdd/KDS-IMPLEMENTATION-PLAN/task-{1..7}-report.md` (Task 6 em progresso)

**Proximos passos (nao urgentes):**
1. Corrigir 2 deferred findings de KDS (nao-bloqueadores):
   - Task 3: adicionar kds_tokens indices ao ensureMongoIndexes() para performance Mongo parity
   - Task 5: standardizar 404 handling em POST /kds/concluir mesa branch (cosmético)
2. Trabalhar nos 4 pontos de UX feedback (ver secao 12)

---

# 12. FEEDBACK DE UX — PROXIMA SESSAO

Identificado pelo dono em 2026-08-12. Prioridade: proxima sessao.

| # | Tipo | Descricao | Esforço | Impacto | Status |
|---|------|-----------|---------|---------|--------|
| 1 | 🔴 BUG | Botoes fora do enquadramento quando ha pedidos em todas as etapas (Pedidos) | 1-2h | Alto | Fazer logo |
| 2 | 🟠 FEATURE | Nomear mesas customizado (cores, nomes) — `mesas.nome` + UI edit | 4-6h | Medio | Planejado |
| 3 | 🟠 FEATURE | Status "Em Falta" no cardapio, linkado com menu digital QR | 6-8h | Alto | Planejado |
| 4 | 🟠 FEATURE | Status pedido na tela de Mesas (sumario: "2 prontos, 1 preparo") | 4-6h | Alto (parity com Delivery) | Planejado |

**Ordem recomendada:** 1 (bug urgente) → 4 (parity) → 2+3 (features conectadas).

**Para retomar:**
1. Usuarios com o app aberto precisam de Ctrl+Shift+R para limpar cache
   (navegador continua servindo JS antigo sem refresh hard).
2. Ambiente local so e necessario para desenvolver: Docker Desktop ->
   `docker start ros-mongo-local` -> `yarn dev:no-reload`. Detalhes no §8.
3. Saude do servidor: `GET /api/health`. Se vier `"status":"degraded"`, o
   campo `config_faltando` diz exatamente qual variavel esta faltando.
4. Proximas frentes no §11 — a impressao (item 1 da lista) sai da pendencia;
   os proximos dois itens priorizados sao KDS e delivery completo.

---

# 1. O que e o produto

**Restaurant OS** — SaaS de atendimento e gestao para restaurantes,
lanchonetes e similares, com WhatsApp como canal principal de atendimento.
Modulos: cardapio, pedidos (balcao/delivery/retirada/mesa), mesas e comandas,
clientes/CRM, financeiro, pagamentos, conversas de WhatsApp, relatorios,
auditoria e RBAC.

**Modelo comercial: SaaS multi-tenant.** Varios restaurantes clientes sao
atendidos por **uma unica instalacao e um unico projeto Supabase**. Nunca
criar um projeto/banco por cliente. O que varia por empresa e a **instancia
da Evolution API** (credenciais por tenant na tabela `integracoes`).

---

# 2. Arquitetura

## 2.1 Camadas

```
Route Handler (HTTP)  ->  Controller  ->  Service  ->  Repository  ->  Database
```

Tudo vive hoje em **um unico route handler catch-all**:
`app/api/[[...path]]/route.js` (Next.js App Router). Ele concentra dispatch
HTTP, autenticacao/autorizacao, regras de negocio e orquestracao. Nao e um
acidente: o projeto nasceu assim e a migracao decidiu **nao** reescrever isso
(evitar big-bang), so extrair a camada de dados. O frontend inteiro, na mesma
linha, e um unico `app/page.js`.

**Principios que nao podem ser quebrados:**

- **Regra de negocio existe so no Service** (hoje, dentro do `route.js`).
  Nunca em repository, nunca em trigger/function do Postgres. Formalizado no
  ADR-006 (`docs/ARCHITECTURE.md`) e ja custou uma correcao de design real.
- **O banco cuida so de integridade**: FK, NOT NULL, CHECK, UNIQUE, indices,
  RLS. As unicas funcoes Postgres permitidas sao **mecanicas** — numeracao
  atomica, incremento atomico, upsert atomico pai+filhos — e sempre recebem
  o valor ja decidido pelo Service.
- **Persistencia desacoplada por Repository Pattern**: o Service depende de
  contratos, nao de MongoDB nem de Supabase.
- **Integracao externa nunca e mockada**: sem credencial, avisar/falhar,
  jamais simular sucesso.

## 2.2 Contratos de dominio

`packages/domain/src/index.ts` — entidades e interfaces de repositorio
(TypeScript, **nao compilado**; o projeto nao tem `tsconfig`/`typescript`.
Serve como documentacao executavel do contrato). Ambos os backends satisfazem
exatamente as mesmas interfaces.

Entidades: `Empresa`, `Usuario`, `Categoria`, `Produto`, `Cliente`, `Pedido`
(+`PedidoItem`), `Mesa`, `Comanda` (+`ComandaItem`, `PagamentoResumo`),
`PagamentoRegistro`, `Transacao`, `Integracao`, `Conversa`, `Mensagem`,
`Auditoria`. Mais `BulkCreatable<T>` (carga em lote, usada pelo seed).

## 2.3 Implementacoes de repositorio

- `lib/repositories/mongo/` — **16 repositories** (backend default do codigo).
- `lib/repositories/supabase/` — **15 repositories** (o que roda no servidor).
- `lib/repositories/factory.js` — **escolhe o backend**. Unico lugar do
  sistema que sabe qual persistencia esta em uso.

`route.js` **nao conhece nenhum driver de banco**. Os 3 acessos diretos que
existiam fora do contrato foram eliminados na Fase 7: `ensureIndexes()` (foi
para a factory; no Supabase e no-op, os indices vem das migrations),
bulk-insert do seed (virou `createMany()`) e `webhook_events` (virou
`webhookEventsRepository`, nos dois backends).

## 2.4 Autenticacao e autorizacao

- **Auth: JWT local** (HMAC-SHA256, `exp` em segundos, TTL 7 dias) + senhas
  com **scrypt** (N=16384, r=8, p=1, formato `salt:hash`). Ainda **nao**
  migrado para Supabase Auth — auditado na Fase 8, implementacao nao iniciada.
- **O `papel` NUNCA vem do token**: e relido do banco a cada requisicao, no
  portao unico de auth. Por isso revogar acesso e imediato, e o RBAC nao
  precisa virar claim na migracao. Nao mudar isso sem entender o efeito.
- **RBAC: hardcoded** nos objetos `ROLES`/`PERMISSIONS` do `route.js` (50
  checagens `can()`). As tabelas `papeis`/`permissoes` existem no Supabase com
  seed, mas **o app nao as le** — armadilha conhecida, nao "corrigir" sem
  decisao.
- Papeis: `OWNER`, `ADMIN`, `GERENTE`, `ATENDENTE`, `COZINHA`.
- **Frontend**: token em `localStorage['ros_token']`, `fetch` puro, sem
  logica de refresh (ver armadilha 14).

---

# 3. Multi-tenancy (regra critica do produto)

Toda entidade de dominio carrega **`empresa_id`**. Isolamento em **duas
camadas, sempre as duas**:

1. **Aplicacao**: toda query e escopada por `empresa_id` extraido do token.
2. **Postgres RLS**: 17 tabelas com RLS habilitado, 18 policies.

Nunca confiar so em RLS, nem so na aplicacao. Ao criar qualquer entidade nova:
incluir `empresa_id`, criar a policy RLS e escrever teste de isolamento
cross-tenant.

Isso vale tambem para **arquivos**: a logo e gravada em
`{empresa_id}/logo.ext`, com o `empresa_id` vindo do token — nunca do corpo da
requisicao.

**Atencao (armadilha 13):** hoje o app usa a `service_role`, que **ignora RLS
por completo**. O isolamento em runtime e 100% da camada de aplicacao — as
policies sao defesa em profundidade que nunca e exercida.

---

# 4. Modelo de dados

## 4.1 Decisoes estruturais

- **Itens de pedido/comanda sao tabelas relacionais filhas**
  (`pedido_itens`, `comanda_itens`), nao JSONB. No MongoDB sao arrays
  embutidos; a traducao acontece no repository.
- **Snapshot historico por item**: `nome` e `preco` sao congelados no momento
  da venda. **Nunca** recalcular a partir do preco atual do produto.
- **`comanda.pagamentos`**: array embutido no Mongo (copia denormalizada); no
  Postgres **nao existe coluna** — a tabela `pagamentos` e a fonte unica. O
  `SupabaseComandaRepository` reconstroi o campo em memoria a cada leitura, so
  para preservar o contrato que `computeComanda()` ja espera.
- **Numeracao de pedido**: tabela `pedido_contadores` + funcao atomica por
  tenant (substituiu um `count()+1` com race condition).
- **Valores de pedido** (migration 0015): mesma gramatica de `comandas` —
  `total = subtotal - desconto + acrescimo`, calculado no Service.
  `desconto`/`acrescimo` sao ajuste manual do operador (cortesia,
  arredondamento, acerto). **Ajuste bloqueado (409) apos concluir**, porque
  nesse ponto o pedido ja virou receita em `transacoes`; corrigir depois disso
  exige lancamento no financeiro, nao edicao do pedido.
- **Logo da empresa**: arquivo no Supabase Storage; `empresas.logo` guarda a
  URL publica.
- **Impressao de cupom**: NAO E CUPOM FISCAL (sem NFC-e/SAT — precisaria de
  certificado digital e integracao com a SEFAZ, projeto proprio). E
  comprovante de producao/atendimento: comanda para a cozinha (sem precos)
  e via para o cliente (com subtotal/desconto/acrescimo/total). O sistema
  roda na nuvem e a impressora fica no restaurante — sem caminho de rede
  entre os dois — entao quem imprime e sempre o navegador do caixa via
  `window.print()`; impressora termica se instala no SO como impressora
  comum. Codigo em `lib/cupom-dados.js` (mapeamento puro, testavel sem
  navegador) + `components/cupom.jsx` (renderizacao + `window.print()`).

## 4.2 Tabelas (20 no Supabase)

Dominio com `empresa_id`: `usuarios`, `categorias`, `produtos`, `clientes`,
`mesas`, `comandas`, `comanda_itens`, `pedidos`, `pedido_itens`, `pagamentos`,
`transacoes`, `integracoes`, `conversas`, `mensagens`, `auditoria`,
`webhook_events`, `pedido_contadores`.
Raiz do tenant: `empresas`. Catalogos globais: `papeis`, `permissoes`.

## 4.3 Migrations e ORDEM DE EXECUCAO (nao obvia)

`supabase/migrations/0001` a `0015`, mais `triggers.sql`, `policies_rls.sql`,
`seed.sql`. **A ordem correta nao e so numerica** — `0002+` dependem de
funcoes definidas em `triggers.sql`/`policies_rls.sql`:

```
0001_init.sql -> triggers.sql -> policies_rls.sql -> seed.sql
-> 0002_core_fixes -> 0003_pedido_numero_atomico -> 0004_mesas
-> 0005_comandas -> 0006_pagamentos -> 0007_webhook_events
-> 0008_conversas_mensagens -> 0009_repository_support_functions
-> 0010_atomic_create_functions -> 0011_migration_upsert_functions
-> 0012_pedidos_comanda_id -> 0013_increment_conversa_patch_parcial
-> 0014_resync_contador_por_empresa -> 0015_pedidos_desconto_acrescimo
```

Esta ordem foi testada de ponta a ponta contra Postgres real. Tambem no
`README.md`.

**Cuidado ao mexer em pedidos:** `create_pedido_com_itens()` e
`upsert_pedido_com_itens()` usam **lista de colunas explicita**. Coluna nova
em `pedidos` exige reescrever as duas, senao o valor e descartado em silencio.

## 4.4 Switch de runtime (`DATABASE_PROVIDER`)

A escolha do backend vive so em `lib/repositories/factory.js`:

```bash
DATABASE_PROVIDER=mongo      # default do codigo (omitir tem o mesmo efeito)
DATABASE_PROVIDER=supabase   # o que roda no servidor
```

- Conferir o que esta ativo: `GET /api/health` -> campo `database`.
- **Sem fallback silencioso**: `supabase` sem credenciais **falha**, em vez de
  cair para o Mongo — um fallback silencioso gravaria no banco errado sem
  ninguem perceber.
- **Sem modo hibrido**: misturar backends na mesma requisicao daria leitura
  inconsistente e quebraria as FKs do Postgres.
- Trocar exige reiniciar o processo.
- Detalhes: `docs/plans/PHASE-7-RUNTIME-SWITCH.md`.

---

# 5. Conexoes e integracoes

| O que | Onde | Credencial | Sem configuracao |
|---|---|---|---|
| **Supabase** (banco atual) | Projeto hospedado | `.env` / variaveis do EasyPanel | App falha explicitamente |
| **Supabase Storage** (logos) | Mesmo projeto | Mesmas do Supabase | Endpoint responde 503 |
| **MongoDB** | Container local `ros-mongo-local` | `MONGO_URL`/`DB_NAME` | So usado com `DATABASE_PROVIDER=mongo` |
| **Evolution API** (WhatsApp) | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Retorna "nao configurado" |
| **n8n** | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Evento e ignorado |
| **Mercado Pago** | Externo | Por empresa, tabela `integracoes` | Retorna "nao configurado" |

## 5.1 Supabase — como conectar

- **Direct connection resolve para IPv6** e e inacessivel de varias redes.
  Usar o **Session Pooler** (`aws-0-us-east-2.pooler.supabase.com:5432`).
- A senha do banco contem `@`, que **precisa ser codificado como `%40`** na
  connection string.
- Nao ha `psql` instalado nesta maquina: rodar via
  `docker run --rm -i postgres:17 psql "$SUPABASE_DB_URL"`.
- Credenciais no `.env` (nao versionado): `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_DB_URL`.

---

# 6. Deploy (EasyPanel / Hostinger — IP 187.77.226.88)

**Projeto `restaurante`**, servico **`app`**, em
`https://restaurante-app.ilmdzk.easypanel.host` (HTTPS gerado pelo EasyPanel,
sem dominio proprio). Ao lado: `evolution-api`, `evolution-api-db`,
`evolution-api-redis`, `n8n`. **Essa proximidade e valiosa** — e o que torna o
fluxo de WhatsApp testavel de ponta a ponta.

Guia completo: `docs/operations/DEPLOY-EASYPANEL.md`.

## 6.1 Configuracao que funciona

| Campo | Valor |
|---|---|
| Fonte | GitHub · `tanelasjr-ux` / `Lanchonete` · ramo `main` |
| Construcao | **Dockerfile** · arquivo `docker/Dockerfile` |
| Dominios | porta do container **3000** (o default `80` da 502) |
| Ambiente | 7 variaveis (ver §6.2) |

**Implanta automaticamente ao receber push na `main`.**

**Nao usar** o `docker-compose.yml` da raiz: ele sobe postgres, evolution-api
e n8n juntos, duplicando servicos que ja existem. Aquele arquivo serve para
subir a stack inteira num VPS limpo.

**Nao ligar** o botao "Criar arquivo .env" na aba Ambiente — as variaveis ja
chegam como ambiente; ligar gravaria a service role key em arquivo dentro do
container.

## 6.2 Variaveis obrigatorias

`JWT_SECRET` (exclusivo do servidor), `DATABASE_PROVIDER=supabase`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CORS_ORIGINS`.

Sem `JWT_SECRET`, o app sobe mas responde `503 degraded` e recusa autenticar
(falha fechada, de proposito). Variavel nova so vale **apos reimplantar**.

## 6.3 Supabase Storage

Bucket `logos` (publico, limite 1 MB, apenas PNG/JPG/WEBP/SVG), criado via
Admin API. Guarda a logo em `{empresa_id}/logo.{ext}` — caminho derivado do
token, entao uma empresa nao sobrescreve a de outra. Upload com `upsert`
(trocar substitui em vez de acumular orfao) e cache-buster `?v=` na URL, sem
o qual o browser continuaria exibindo a logo antiga.

Primeiro uso de Storage no projeto. Codigo isolado em
`lib/integrations/storage.js`.

## 6.4 Imagem

`docker/Dockerfile` multi-stage, saida `standalone`, **291 MB**, com
`HEALTHCHECK` apontando para `/api/health`. O `.dockerignore` exclui `.env` e
`backups/` — sem ele, a service role key e dumps com dado de cliente iriam
embutidos na imagem.

---

# 7. Estado de cada frente

| Frente | Status |
|---|---|
| 1 — Auditoria da migracao | **Concluida** (`MONGO-TO-SUPABASE-AUDIT.md`) |
| 2 — Contratos de dominio | **Concluida** |
| 3 — Extrair Mongo do `route.js` | **Concluida** (16 repositories) |
| 3.5 — Remover triggers de negocio | **Concluida** (`PHASE-3.5-...`) |
| 4 — Schema Supabase | **Concluida** (`PHASE-4-...`) |
| 5 — `Supabase*Repository` | **Concluida** (`PHASE-5-...`) |
| 6 — Ferramenta de migracao de dados | **Concluida** (`PHASE-6-...`) |
| 6B — Validacao contra Supabase real | **Concluida** (`PHASE-6B-...`) |
| 7 — Switch de runtime | **Concluida** (`PHASE-7-...`) |
| 8 — Auditoria de Auth | **Concluida** (`PHASE-8-AUTH-AUDIT.md`) |
| Deploy | **No ar**, com deploy automatico por push |
| Melhorias de produto (tema/logo/valor) | **No ar** |
| Supabase Auth (implementacao) | **NAO INICIADA** |
| Impressao, KDS, delivery completo | **NAO INICIADOS** (ver §11) |
| Realtime / Storage alem de logo | **NAO INICIADOS** |

## 7.1 Baseline de testes

Suite de backend (`backend_test.py`, `_v2`, `_v3`), **identica nos dois
backends** e tambem contra a imagem de producao:

| Suite | Resultado |
|---|---|
| v1 | **40/40** |
| v2 (mesas/comandas/pagamentos) | **39/39** |
| v3 (atendimento/delivery) | **32/33** |

A unica falha do v3 e o **nao-bug conhecido**: o webhook do WhatsApp grava
`tipo:'conversation'`, que e o `messageType` real da Evolution API para texto
simples — o teste e que espera `'text'`. Documentado em `test_result.md`.

**Cuidado:** cada execucao da suite registra tenants novos. Foi assim que o
banco acumulou 92 empresas de teste.

## 7.2 Validacao de frontend (Playwright)

O plugin Playwright foi instalado e **usado pela primeira vez** hoje, cobrindo
as tres melhorias: tema estavel por 6s apos a troca, upload real chegando ao
Storage e servido publicamente, e ajuste de R$ 49,80 -> R$ 40,00 refletido no
card do pedido.

**O restante do frontend continua sem validacao sistematica** — a maior lacuna
de teste do projeto. Agora e barato fechar isso.

---

# 8. Ambiente local de desenvolvimento

Nao sobrevive a reboot. Para retomar:

1. `.env` ja existe na raiz (nao versionado).
2. Docker Desktop aberto, depois `docker start ros-mongo-local`.
   Banco de dev: `restaurant_os_dev` (71 empresas de uso organico).
3. `corepack enable` (necessario nesta maquina para o `yarn` resolver).
4. `yarn dev:no-reload` -> `localhost:3000`.
5. Testes: `PYTHONIOENCODING=utf-8 python backend_test.py` (e `_v2`/`_v3`).
   `BASE_URL` e configuravel por variavel de ambiente.

**Armadilha:** rodar `yarn build` com o dev server no ar corrompe o `.next`
(`Cannot find module './chunks/vendor-chunks/next.js'`). Solucao: parar o
servidor, `rm -rf .next`, subir de novo. Se a porta 3000 ficar presa,
`Get-NetTCPConnection -LocalPort 3000` + `Stop-Process` no PowerShell.

---

# 9. Decisoes tomadas (nao renegociar sem confirmar)

1. **Itens de pedido/comanda**: tabelas relacionais com snapshot historico.
2. **Regra de negocio so no Service.** Postgres cuida de integridade e de
   funcoes mecanicas que recebem o valor ja calculado.
3. **Autenticacao migra para Supabase Auth** — auditada, a fazer depois.
4. **MongoDB foi a fonte de verdade** durante a migracao; migrar sempre com
   base no formato REAL dos documentos, nunca assumindo `domain.ts`.
5. **Um unico projeto Supabase** atende todas as empresas.
6. **Nunca mockar integracao externa.**
7. **Valor de pedido concluido nao se edita** — corrige-se por lancamento no
   financeiro.

---

# 10. Achados e armadilhas (para nao redescobrir)

Bugs reais encontrados **rodando** contra banco/servidor/navegador de verdade:

1. **`pedidos.comanda_id` nunca existiu como coluna** — pedidos gerados por
   fechamento de comanda sempre carregam esse campo no Mongo. Migration `0012`.
2. **`pedidos_tipo_check` nao aceitava `'mesa'`** — 4o valor real de `tipo`.
   Migration `0012`.
3. **Ordem de migracao**: apos criar a FK do item 1, `comandas` **tem que**
   migrar antes de `pedidos`.
4. **`jsonb_populate_record()` zera campos ausentes com NULL** em vez de
   aplicar o `DEFAULT`. Por isso as funcoes atomicas usam lista de colunas
   explicita + `coalesce()`.
5. **Upsert em lote via PostgREST nao aplica `DEFAULT` por linha** — se o lote
   mistura documentos com e sem um campo opcional, as linhas sem ele recebem
   `NULL` e violam `not null`.
6. **`supabase-js` remove chaves `undefined`** do corpo JSON: RPC com
   parametro obrigatorio sem default falha com `PGRST202` — erro confuso.
   Migration `0013`.
7. **Direct connection do Supabase e IPv6** — usar o Session Pooler.
8. **`papeis`/`permissoes` existem no banco mas o app nao le** — RBAC e
   hardcoded.
9. **`ON DELETE CASCADE` em `empresas`** limpa o tenant inteiro — util para
   teste, perigoso em producao.
10. **O seed criava a mesa demo apontando para comanda inexistente**
    (violava `mesas_comanda_id_fkey`). No Mongo passava — nao ha FK.
11. **Bulk insert de pedidos nao avanca `pedido_contadores`** — o proximo
    pedido colidia. Migration `0014`. **Regra geral: toda carga em lote com
    numero explicito precisa realinhar o contador.**
12. **`usuarios.id` e IMUTAVEL.** 4 FKs apontam para ele e
    `auditoria.usuario_id` guarda 78 ids **sem FK**. A Admin API do Supabase
    **aceita id customizado** (verificado), entao nao ha motivo para trocar.
13. **`service_role` IGNORA RLS** — ver §3.
14. **O frontend nao tem refresh de token.** Hoje dura 7 dias; o do Supabase
    Auth dura **1 hora**. Sem refresh, todo usuario cai apos 1h — quebra que
    passa em teste de API e so aparece com usuario real.
15. **Validacao de env no nivel do modulo quebra `next build`.** O build
    avalia o modulo das rotas com `NODE_ENV=production` e sem variaveis de
    runtime. Foi o caso do `JWT_SECRET` — resolvido tornando a checagem lazy.
16. **EasyPanel v2.30.0: "Caminho de Build" e obrigatorio e nao aceita raiz.**
    Rejeita vazio, `/`, `.` e `./`; aceita `/algo`. Mas o contexto precisa ser
    a raiz. Usar `/app` faz o contexto virar `code/app` e o build falha com
    `lstat .../app/docker: no such file or directory`.
17. **next-themes: `setTheme` MUDA DE IDENTIDADE a cada troca de tema.**
    Colocar `setTheme` na dependencia de um `useCallback` que alimenta um
    `useEffect` cria um loop: trocar o tema redispara o efeito. Foi assim que
    o tema claro revertia sozinho apos ~2s (o efeito refazia `/auth/me` e
    reaplicava o tema da empresa). Tema da empresa e **padrao inicial**,
    aplicado uma vez via ref — nunca reimposto a cada carga.
18. **Variavel de ambiente nova so vale apos reimplantar.**
19. **Deploy novo exige Ctrl+Shift+R em quem ja estava com o app aberto.** O
    JS antigo fica em cache e a mudanca "nao aparece". Antes de investigar um
    bug pos-deploy, descartar isso — hoje custou uma investigacao inteira.
20. **O shell come conteudo entre crases** ao editar arquivos via
    `node -e "..."` em heredoc. Para editar documentacao com trechos de
    codigo, usar a ferramenta de edicao, nao script de shell.
21. **`window.print()` abre um dialogo NATIVO e bloqueante neste ambiente**
    (confirmado testando — nao e um no-op simulado). Isso tem duas
    consequencias: (a) automacao de navegador (Playwright) que clica num
    botao cujo handler chama `print()` sincronamente pode travar esperando
    o dialogo — testar via `Escape`/`handle_dialog` ou validar a logica de
    dados separadamente de forma determinista, nao via clique real; (b) por
    isso a impressao de cupom usa `createRoot` num container proprio no
    `body` (`components/cupom.jsx`) em vez de portal na arvore do app — o
    dialogo bloqueante nao pode depender de estado React que uma
    re-renderizacao concorrente altere.

---

# 11. Pendencias e proximos passos

**Lacunas de produto** (levantadas verificando o codigo — as duas primeiras
ainda travam a operacao diaria de um restaurante real):

- [x] ~~Impressao de pedido para a cozinha~~ — **feito nesta sessao**
      (§4.1). Falta so o `git push` para publicar (§0).
- [ ] **Tela de cozinha (KDS).** O papel `COZINHA` existe mas nao tem tela
      propria — hoje ve o mesmo dashboard do gerente. O padrao e uma tela
      grande, tocavel, com pedidos em colunas por status e cronometro.
- [ ] **Delivery completo.** `tipo: 'delivery'` existe, mas **nao ha endereco
      de entrega, taxa, tempo estimado nem entregador** (verificado: zero
      ocorrencias). Na pratica um delivery e igual a um balcao, so com rotulo
      diferente.
- [ ] **Fechamento de caixa** (flag `caixa` ja reservada): abrir/fechar,
      sangria, conferencia.
- [ ] **Estoque** (flag `estoque` ja reservada): baixa automatica na venda.
- [ ] **Cardapio digital + QR na mesa**: encaixa no modelo de mesas/comandas
      que ja existe, e e o tipo de recurso que **vende** o SaaS.

Flags tambem reservadas, sem urgencia: `crm`, `campanhas`, `fidelidade`,
`cashback`, `billing`, `multiunidade`.

**Tecnico:**

- [ ] **Validar o frontend tela por tela** com Playwright — o restante do
      sistema nunca passou por isso.
- [ ] **Limpar as 92 empresas de teste** do Supabase (migracoes + rodadas da
      suite). Nenhum dado real de cliente. **Decisao do dono.**
- [ ] **Implementar Supabase Auth** (`PHASE-8-AUTH-AUDIT.md`), incluindo
      refresh de token no frontend (armadilha 14).
- [ ] **Testar o fluxo real de WhatsApp** — possivel agora, com o app ao lado
      da Evolution API.
- [ ] **Tornar o repositorio privado** (produto comercial). Hoje publico. Ao
      fazer, o EasyPanel precisara de autorizacao para clonar.
- [ ] **Fazer o RLS valer** (trocar `service_role` por token de usuario). Fase
      separada, nao juntar com Auth.
- [ ] **Dominio proprio.**

---

# 12. Commits recentes

```
2cab4b6 fix: id area-impressao move para o container no body, nao no JSX  <- corrigiu bug de pagina em branco
7cb5392 docs: registra a impressao de cupom no HANDOFF (aguardando push)
4c80ae4 feat: impressao de cupom (comanda da cozinha e via do cliente)
ba04d7f docs: handoff completo — 3 melhorias no ar e lacunas de produto mapeadas
8926206 docs: corrige secao 6.3 do HANDOFF (conteudo perdido por escape do shell)
4ec0011 docs: registra no HANDOFF a armadilha do next-themes, valores e bucket
6ebd061 feat: ajuste de valor em pedidos, upload de logo e correcao do tema
d44aa48 docs: handoff completo — app publicado e validado em producao
f456a86 docs: HANDOFF.md — repositorio sincronizado com o GitHub + guia de deploy
ca4c404 build(deploy): prepara imagem de producao para o EasyPanel
5e5b02a docs: ponto de retomada e lista de commits atualizados (Fase 8)
c7ac605 security(auth): corrige 3 vulnerabilidades no JWT + auditoria da Fase 8
537ab77 feat(fase7): paridade completa de runtime MongoDB <-> Supabase
2ccf90d refactor(fase7): factory de repositories com switch DATABASE_PROVIDER
87afa2a feat(supabase): valida schema, repositories e migracao contra Supabase real
7bd641a feat(migration): ferramenta de migracao de dados MongoDB -> Supabase
5e082a2 feat(supabase): idempotent migration upserts + fix pedidos.comanda_id
9f45f80 fix(supabase): atomic create for pedido+itens e comanda+itens (RPC)
d29f4d3 feat(supabase): implement Supabase repositories (Fase 5)
305c350 feat(supabase): complete Fase 4 schema
8e15454 fix(supabase): remove business-logic triggers
f43e51e docs: add comprehensive Mongo->Supabase migration audit
432a067 refactor: extract empresa Mongo access into repository
796cb05 refactor: extract comanda/pagamento Mongo access into repositories
6f2619f refactor: extract pedido Mongo access into repository
6373f9e refactor: extract conversa/mensagem Mongo access into repositories
aa26ecb refactor: extract mesa Mongo access into repository
6fa0bcd refactor: extract auditoria/integracoes Mongo access into repositories
2675a4b refactor: extract usuario/transacao Mongo access into repositories
ed2c3fe refactor: extract categoria/produto/cliente Mongo access into repositories
0f24486 feat(domain): extend contracts for MongoDB->Supabase migration
e2bfe84 chore: ignore .env files to prevent secret leakage
2d4642a docs: add CLAUDE.md autonomous agent rules and HANDOFF.md
```

---

# 13. Mapa de arquivos e documentos

**Governanca**
- `CLAUDE.md` — regras de operacao autonoma (ler antes de qualquer tarefa).
  Secao 18.1 define o formato obrigatorio deste handoff.

**Codigo**
- `app/api/[[...path]]/route.js` — API inteira (Controller + Service).
- `app/page.js` — frontend inteiro (SPA).
- `packages/domain/src/index.ts` — contratos de dominio.
- `lib/repositories/mongo/` — 16 repositories.
- `lib/repositories/supabase/` — 15 repositories.
- `lib/repositories/factory.js` — switch `DATABASE_PROVIDER`.
- `lib/integrations/` — `evolution.js`, `n8n.js`, `supabase.js`,
  `storage.js`, `payments/`.
- `lib/cupom-dados.js` — mapeamento puro Pedido/Comanda -> dados do cupom.
- `components/cupom.jsx` — renderiza e imprime o cupom (`window.print()`).

**Banco**
- `supabase/migrations/0001`…`0015`, `triggers.sql`, `policies_rls.sql`,
  `seed.sql`. Ordem real de execucao no §4.3 e no `README.md`.

**Deploy**
- `docker/Dockerfile`, `.dockerignore` — imagem de producao.
- `docker-compose.yml` — stack completa para VPS limpo (**nao** usar no
  EasyPanel).

**Ferramentas**
- `scripts/migrate-mongo-to-supabase.mjs` — migracao de dados (idempotente).
- `scripts/validate-migration.mjs` — validacao pos-migracao (so leitura).

**Documentacao**
- `docs/operations/DEPLOY-EASYPANEL.md` — deploy passo a passo.
- `docs/plans/` — uma auditoria/relatorio por fase (lista no §7).
- `docs/ARCHITECTURE.md` (ADR-006), `docs/FOLDER_STRUCTURE.md`.

**Testes**
- `backend_test.py`, `_v2`, `_v3` — regressao de backend (baseline no §7.1).
- `test_result.md` — historico e comportamentos conhecidos.

**Backups**
- `backups/` — dumps do Supabase. **No `.gitignore`** (pode conter dado real).
