# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-11 (app publicado no EasyPanel e validado em producao)

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

**O app esta NO AR**, publicado e validado de fora:

```
https://restaurante-app.ilmdzk.easypanel.host
```

Rodando sobre **Supabase**, com HTTPS, no projeto `restaurante` do EasyPanel.
Validado por requisicao real pela internet: cadastro, login, dashboard,
leitura do seed e **criacao de pedido novo** (numeracao sequencial correta).

**Estado do codigo:** arvore limpa, **sincronizada com o GitHub**
(`github.com/tanelasjr-ux/Lanchonete`, `main`, ultimo commit `f456a86`),
nada pendente.

**Isto e STAGING, nao producao.** Sem dominio proprio, sem usuario real, e o
banco tem 91 empresas de teste. Ver §11 antes de tratar como producao.

**Para retomar:**
1. Ambiente local (opcional — o servidor ja roda sozinho): Docker Desktop ->
   `docker start ros-mongo-local` -> `yarn dev:no-reload`. Detalhes no §8.
2. Conferir o servidor: `GET /api/health` no endereco acima. Se vier
   `"status":"degraded"`, o campo `config_faltando` diz qual variavel falta.
3. Proximas frentes no §11. As duas mais valiosas: **validar o frontend no
   navegador** (nunca foi feito, e agora e facil com o app publicado) e
   **limpar as 91 empresas de teste** do Supabase.

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
(evitar big-bang), so extrair a camada de dados.

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
  `desconto`/`acrescimo` sao ajuste manual do operador. Ajuste bloqueado
  (409) apos concluir, porque nesse ponto o pedido ja virou receita em
  `transacoes`; corrigir depois disso exige lancamento no financeiro.
- **Logo da empresa**: arquivo no Supabase Storage, bucket `logos` (publico,
  1 MB, so imagens), caminho `{empresa_id}/logo.ext`. `empresas.logo` guarda
  a URL publica com cache-buster.

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

Esta ordem foi testada de ponta a ponta contra Postgres real antes de ser
documentada. Tambem esta no `README.md`.

## 4.4 Switch de runtime (`DATABASE_PROVIDER`)

A escolha do backend vive so em `lib/repositories/factory.js`:

```bash
DATABASE_PROVIDER=mongo      # default do codigo (omitir tem o mesmo efeito)
DATABASE_PROVIDER=supabase   # o que roda no servidor
```

- Conferir o que esta ativo: `GET /api/health` -> campo `database`.
- **Sem fallback silencioso**: `supabase` sem credenciais **falha**, em vez de
  cair para o Mongo — um fallback silencioso gravaria dados no banco errado
  sem ninguem perceber.
- **Sem modo hibrido**: misturar backends na mesma requisicao daria leitura
  inconsistente e quebraria as FKs do Postgres.
- Trocar exige reiniciar o processo.
- Detalhes: `docs/plans/PHASE-7-RUNTIME-SWITCH.md`.

---

# 5. Conexoes e integracoes

| O que | Onde | Credencial | Sem configuracao |
|---|---|---|---|
| **Supabase** (banco atual) | Projeto hospedado | `.env` / variaveis do EasyPanel | App falha explicitamente |
| **MongoDB** | Container local `ros-mongo-local` | `MONGO_URL`/`DB_NAME` | So usado com `DATABASE_PROVIDER=mongo` |
| **Evolution API** (WhatsApp) | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Retorna "nao configurado" |
| **n8n** | EasyPanel, projeto `restaurante` | Por empresa, tabela `integracoes` | Evento e ignorado |
| **Mercado Pago** | Externo | Por empresa, tabela `integracoes` | Retorna "nao configurado" |

**Nunca mockar integracao externa.** Sem credencial, o comportamento correto e
falhar/avisar — jamais simular sucesso (`CLAUDE.md` §6 e §7).

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

**Projeto `restaurante`**, servico **`app`**, publicado em
`https://restaurante-app.ilmdzk.easypanel.host` (HTTPS gerado pelo EasyPanel,
sem dominio proprio).

Ao lado dele, no mesmo projeto: `evolution-api`, `evolution-api-db`,
`evolution-api-redis`, `n8n`. **Essa proximidade e valiosa** — e o que torna o
fluxo de WhatsApp testavel de ponta a ponta pela primeira vez.

Guia completo: `docs/operations/DEPLOY-EASYPANEL.md`.

## 6.1 Configuracao que funciona (descoberta na marra)

| Campo | Valor |
|---|---|
| Fonte | GitHub · `tanelasjr-ux` / `Lanchonete` · ramo `main` |
| Construcao | **Dockerfile** · arquivo `docker/Dockerfile` |
| Dominios | porta do container **3000** (o default `80` da 502) |
| Ambiente | 7 variaveis (ver §6.2) |

**Nao usar** o `docker-compose.yml` da raiz: ele sobe postgres, evolution-api
e n8n juntos, duplicando servicos que ja existem no EasyPanel. Aquele arquivo
serve para subir a stack inteira num VPS limpo.

**Nao ligar** o botao "Criar arquivo .env" na aba Ambiente — as variaveis ja
chegam como ambiente; ligar gravaria a service role key em arquivo dentro do
container, sem necessidade.

## 6.2 Variaveis obrigatorias no servico

`JWT_SECRET` (exclusivo do servidor, nao reusar o de dev),
`DATABASE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `CORS_ORIGINS`.

Sem `JWT_SECRET`, o app sobe mas responde `503 degraded` e recusa autenticar
(falha fechada, de proposito). Variavel nova so vale **depois de reimplantar**.

## 6.3 Supabase Storage

Bucket `logos` (publico, limite 1 MB, apenas imagens PNG/JPG/WEBP/SVG), criado
via Admin API do Supabase. Guarda a logo de cada empresa em
`{empresa_id}/logo.{ext}` — caminho derivado do token, entao uma empresa nao
consegue sobrescrever a de outra. Upload com `upsert` (trocar substitui em vez
de acumular arquivo orfao) e cache-buster `?v=` na URL, sem o qual o browser
continuaria exibindo a logo antiga.

E o primeiro uso de Storage no projeto — antes so havia banco. Codigo isolado
em `lib/integrations/storage.js`; sem credencial, o endpoint responde 503 em
vez de fingir sucesso.

## 6.4 Imagem

`docker/Dockerfile` multi-stage, saida `standalone`, **291 MB**, com
`HEALTHCHECK` apontando para `/api/health`. O `.dockerignore` exclui `.env` e
`backups/` — sem ele, a service role key e dumps com dado de cliente iriam
embutidos na imagem.

---

# 7. Estado de cada fase

| Fase | Status |
|---|---|
| 1 — Auditoria da migracao | **Concluida** (`MONGO-TO-SUPABASE-AUDIT.md`) |
| 2 — Contratos de dominio | **Concluida** (`packages/domain/src/index.ts`) |
| 3 — Extrair Mongo do `route.js` | **Concluida** (16 repositories, 8 lotes) |
| 3.5 — Remover triggers de negocio | **Concluida** (`PHASE-3.5-TRIGGER-CLEANUP.md`) |
| 4 — Schema Supabase | **Concluida** (`PHASE-4-SUPABASE-SCHEMA.md`) |
| 5 — `Supabase*Repository` | **Concluida** (`PHASE-5-SUPABASE-REPOSITORIES.md`) |
| 6 — Ferramenta de migracao de dados | **Concluida** (`PHASE-6-DATA-MIGRATION.md`) |
| 6B — Validacao contra Supabase real | **Concluida** (`PHASE-6B-SUPABASE-REAL.md`) |
| 7 — Switch de runtime | **Concluida** (`PHASE-7-RUNTIME-SWITCH.md`) |
| 8 — Auditoria de Auth | **Concluida** (`PHASE-8-AUTH-AUDIT.md`) |
| **Deploy (staging)** | **Concluido e validado em producao** |
| Supabase Auth (implementacao) | **NAO INICIADA** — auditoria recomenda faze-la depois do corte de banco |
| Validacao do frontend | **NUNCA FEITA** |
| Realtime / Storage | **NAO INICIADOS** |

## 7.1 Baseline de testes

Suite de backend (`backend_test.py`, `_v2`, `_v3`), **identica nos dois
backends** e tambem contra a imagem de producao em container:

| Suite | Resultado |
|---|---|
| v1 | **40/40** |
| v2 (mesas/comandas/pagamentos) | **39/39** |
| v3 (atendimento/delivery) | **32/33** |

A unica falha do v3 e o **nao-bug conhecido**: o webhook do WhatsApp grava
`tipo:'conversation'`, que e o `messageType` real da Evolution API para texto
simples — o teste e que espera `'text'`. Documentado em `test_result.md`.

**Cuidado ao rodar a suite contra o Supabase**: cada execucao registra tenants
novos. Foi assim que o banco acumulou 91 empresas.

**Validacao do servidor publicado** (feita por requisicao real pela internet,
nao pela suite): health `200`/`supabase`, cadastro, login, 11 produtos, 8
mesas e 12 pedidos do seed, dashboard calculando, e criacao de pedido novo
`201` com numeracao sequencial correta (nº 13 apos os 12 do seed).

---

# 8. Ambiente local de desenvolvimento

Nao sobrevive a reboot. Para retomar:

1. `.env` ja existe na raiz (nao versionado).
2. Docker Desktop aberto, depois `docker start ros-mongo-local`.
   Banco de dev: `restaurant_os_dev` (71 empresas de uso organico — nao apagar).
3. `corepack enable` (necessario nesta maquina para o `yarn` resolver).
4. `yarn dev:no-reload` -> `localhost:3000`.
5. Testes: `PYTHONIOENCODING=utf-8 python backend_test.py` (e `_v2`/`_v3`).
   `BASE_URL` e configuravel por variavel de ambiente.

**Armadilha:** rodar `yarn build` com o dev server no ar corrompe o `.next`
(erro `Cannot find module './chunks/vendor-chunks/next.js'`). Solucao: parar o
servidor, `rm -rf .next`, subir de novo. Se a porta 3000 ficar presa,
`Get-NetTCPConnection -LocalPort 3000` + `Stop-Process` no PowerShell.

---

# 9. Decisoes tomadas (nao renegociar sem confirmar)

1. **Itens de pedido/comanda**: tabelas relacionais com snapshot historico.
2. **Regra de negocio so no Service.** Postgres cuida de integridade e de
   funcoes mecanicas que recebem o valor ja calculado.
3. **Autenticacao migra para Supabase Auth** — auditada (Fase 8), a fazer
   **depois** do corte de banco.
4. **MongoDB e fonte de verdade** durante toda a migracao; migrar com base no
   formato REAL dos documentos, nunca assumir que bate com `domain.ts`.
5. **Um unico projeto Supabase** atende todas as empresas.
6. **Nunca mockar integracao externa.**

---

# 10. Achados e armadilhas (para nao redescobrir)

Bugs reais encontrados **rodando** contra banco/servidor de verdade:

1. **`pedidos.comanda_id` nunca existiu como coluna** — pedidos gerados por
   fechamento de comanda sempre carregam esse campo no Mongo. Migration `0012`.
2. **`pedidos_tipo_check` nao aceitava `'mesa'`** — 4o valor real de `tipo`.
   Migration `0012`; `PedidoTipo` ampliado.
3. **Ordem de migracao**: apos criar a FK do item 1, `comandas` **tem que**
   migrar antes de `pedidos`.
4. **`jsonb_populate_record()` zera campos ausentes com NULL** em vez de
   aplicar o `DEFAULT`. Por isso as funcoes atomicas usam lista de colunas
   explicita + `coalesce()`.
5. **Upsert em lote via PostgREST nao aplica `DEFAULT` por linha** — se o lote
   mistura documentos com e sem um campo opcional, as linhas sem ele recebem
   `NULL` e violam `not null`.
6. **`supabase-js` remove chaves `undefined`** do corpo JSON: RPC com
   parametro obrigatorio sem default falha com `PGRST202` ("function not found
   in schema cache") — erro confuso. Migration `0013`.
7. **Direct connection do Supabase e IPv6** — usar o Session Pooler.
8. **`papeis`/`permissoes` existem no banco mas o app nao le** — RBAC e
   hardcoded.
9. **`ON DELETE CASCADE` em `empresas`** limpa o tenant inteiro — util para
   teste, perigoso em producao.
10. **O seed criava a mesa demo apontando para comanda inexistente**
    (violava `mesas_comanda_id_fkey`). No Mongo passava — nao ha FK. Resolvido
    com 2 passadas, igual a ferramenta de migracao.
11. **Bulk insert de pedidos nao avanca `pedido_contadores`** — o proximo
    pedido colidia. Migration `0014`. **Regra geral: todo caminho de carga em
    lote com numero explicito precisa realinhar o contador.**
12. **`usuarios.id` e IMUTAVEL.** 4 FKs apontam para ele e
    `auditoria.usuario_id` guarda 78 ids **sem FK**. Trocar o id anularia as
    colunas em silencio e orfanaria a auditoria. Nao precisa: a Admin API do
    Supabase **aceita id customizado** (verificado).
13. **`service_role` IGNORA RLS** — ver §3.
14. **O frontend nao tem refresh de token.** Hoje o token dura 7 dias; o do
    Supabase Auth dura **1 hora**. Sem implementar refresh, todo usuario e
    deslogado apos 1h — quebra que passa em teste de API e so aparece com
    usuario real.
15. **Validacao de env no nivel do modulo quebra `next build`.** O build
    avalia o modulo das rotas com `NODE_ENV=production` e sem variaveis de
    runtime. Foi o que aconteceu com a exigencia de `JWT_SECRET` — resolvido
    tornando a checagem lazy (no uso, nao no import).
16. **EasyPanel v2.30.0: o campo "Caminho de Build" e obrigatorio e nao
    aceita raiz.** Rejeita vazio, `/`, `.` e `./`; aceita `/algo`. Mas o
    contexto do build **precisa** ser a raiz do repositorio (o Dockerfile faz
    `COPY . .`). Usar `/app` faz o EasyPanel montar o contexto em `code/app` e
    o build falha com `lstat .../app/docker: no such file or directory`. Foi
    contornado no painel; se reaparecer, as alternativas sao a aba **Git** (em
    vez de GitHub) ou o menu **Avancado**.
17. **next-themes: `setTheme` MUDA DE IDENTIDADE a cada troca de tema.**
    Colocar `setTheme` na dependencia de um `useCallback` que alimenta um
    `useEffect` cria um loop: trocar o tema redispara o efeito. Foi assim que
    o tema claro revertia sozinho para escuro apos ~2s (o efeito refazia
    `/auth/me` e reaplicava o tema da empresa). Tema da empresa e PADRAO
    INICIAL, aplicado uma vez via ref — nunca reimposto a cada carga.
18. **Variavel de ambiente nova so vale apos reimplantar** — salvar na aba
    Ambiente nao reinicia o container sozinho.

---

# 11. Pendencias e proximos passos

- [ ] **Validar o frontend no navegador.** Maior lacuna do projeto: a suite
      cobre API, a interface nunca foi testada (`test_result.md`). Com o app
      publicado e o Playwright instalado, da para percorrer login -> cliente
      -> pedido -> mesa/comanda -> fechamento -> financeiro de verdade.
- [ ] **Limpar as 91 empresas de teste** do Supabase (migracoes + rodadas da
      suite). Nenhum dado real de cliente. `delete from empresas` limpa tudo em
      cascata. **Decisao do dono.**
- [ ] **Implementar Supabase Auth** — auditoria pronta
      (`PHASE-8-AUTH-AUDIT.md`), recomenda faze-la depois do corte de banco.
      Inclui refresh de token no frontend (armadilha 14).
- [ ] **Testar o fluxo real de WhatsApp** — agora possivel, com o app ao lado
      da Evolution API no mesmo projeto EasyPanel.
- [ ] **Tornar o repositorio privado** no GitHub (produto comercial). Hoje
      publico. Ao fazer, o EasyPanel vai precisar de autorizacao para clonar.
- [ ] **Fase separada: fazer o RLS valer** (trocar `service_role` por token de
      usuario). Nao juntar com a migracao de Auth.
- [ ] **Dominio proprio** para o staging/producao.

---

# 12. Commits (mais recentes primeiro — todos no GitHub)

```
f456a86 docs: HANDOFF.md — repositorio sincronizado com o GitHub + guia de deploy
ca4c404 build(deploy): prepara imagem de producao para o EasyPanel
5e5b02a docs: ponto de retomada e lista de commits atualizados (Fase 8)
bb2b304 docs: atualiza HANDOFF.md com a Fase 8 (auditoria de Auth)
c7ac605 security(auth): corrige 3 vulnerabilidades no JWT + auditoria da Fase 8
48a871f docs: atualiza HANDOFF.md com a Fase 7 (switch de runtime)
537ab77 feat(fase7): paridade completa de runtime MongoDB <-> Supabase
2ccf90d refactor(fase7): factory de repositories com switch DATABASE_PROVIDER
87afa2a feat(supabase): valida schema, repositories e migracao contra Supabase real
7bd641a feat(migration): ferramenta de migracao de dados MongoDB -> Supabase
5e082a2 feat(supabase): idempotent migration upserts + fix pedidos.comanda_id
9f45f80 fix(supabase): atomic create for pedido+itens and comanda+itens (RPC)
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
- `lib/integrations/` — `evolution.js`, `n8n.js`, `supabase.js`, `storage.js`, `payments/`.

**Banco**
- `supabase/migrations/0001`…`0015`, `triggers.sql`, `policies_rls.sql`,
  `seed.sql`. Ordem real de execucao no §4.3 e no `README.md`.

**Deploy**
- `docker/Dockerfile`, `.dockerignore` — imagem de producao.
- `docker-compose.yml` — stack completa para VPS limpo (**nao** usar no
  EasyPanel).

**Ferramentas**
- `scripts/migrate-mongo-to-supabase.mjs` — migracao de dados (idempotente;
  `--dry-run`, `--empresa`, `--checkpoint`, `--log`).
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
