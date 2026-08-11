# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-11 (Fase 7 concluida — switch de runtime)

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

**Onde paramos (2026-08-11):** a **Fase 7 foi concluida** — a aplicacao agora
roda **indiferentemente sobre MongoDB ou sobre Supabase**, escolhido pela
variavel `DATABASE_PROVIDER`, com **paridade comprovada pela suite de
regressao completa nos dois backends** (v1 40/40, v2 39/39, v3 32/33 em
ambos — a unica falha do v3 e o nao-bug conhecido da Evolution API).

**Estado do codigo:** arvore git limpa, **8 commits locais**, nada enviado ao
remoto (`git push` precisa da sua confirmacao). Build de producao: PASS.

**O runtime ATIVO continua `mongo`** (default deliberado). O Supabase esta
pronto, populado e validado como runtime — ligar e mudar uma variavel.

**Para retomar:**
1. Subir o ambiente local (Docker Desktop -> `docker start ros-mongo-local`,
   depois `yarn dev:no-reload`). Passo a passo completo no §7.
2. O projeto Supabase e remoto: continua populado, nao precisa resubir nada.
3. Conferir o backend ativo: `GET /api/health` -> campo `database`.
4. Proximos passos em aberto no §10 — os principais sao a **auditoria de
   Auth** (pre-requisito para Supabase Auth) e a **decisao de infra no
   EasyPanel**. O corte de producao em si depende de decisao sua.

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
acidente: o projeto nasceu assim e a migracao em curso decidiu **nao**
reescrever isso agora (evitar big-bang), so extrair a camada de dados.

**Principios que nao podem ser quebrados:**

- **Regra de negocio existe so no Service** (hoje, dentro do `route.js`).
  Nunca em repository, nunca em trigger/function do Postgres. Formalizado no
  ADR-006 (`docs/ARCHITECTURE.md`) e ja custou uma correcao de design real
  (ver §8).
- **O banco cuida so de integridade**: FK, NOT NULL, CHECK, UNIQUE, indices,
  RLS. As unicas funcoes Postgres permitidas sao **mecanicas** — numeracao
  atomica, incremento atomico, upsert atomico pai+filhos — e sempre recebem
  o valor ja decidido pelo Service.
- **Persistencia desacoplada por Repository Pattern**: o Service depende de
  contratos, nao de MongoDB nem de Supabase.

## 2.2 Contratos de dominio

`packages/domain/src/index.ts` — entidades e interfaces de repositorio
(TypeScript, **nao compilado**; o projeto nao tem `tsconfig`/`typescript`.
Serve como documentacao executavel do contrato). Ambos os backends
(`Mongo*Repository` e `Supabase*Repository`) satisfazem exatamente as mesmas
interfaces.

Entidades: `Empresa`, `Usuario`, `Categoria`, `Produto`, `Cliente`, `Pedido`
(+`PedidoItem`), `Mesa`, `Comanda` (+`ComandaItem`, `PagamentoResumo`),
`PagamentoRegistro`, `Transacao`, `Integracao`, `Conversa`, `Mensagem`,
`Auditoria`.

## 2.3 Implementacoes de repositorio

- `lib/repositories/mongo/` — **16 repositories** (runtime ativo por default).
- `lib/repositories/supabase/` — **15 repositories**, validados contra o
  Supabase real e aprovados pela suite de regressao completa como runtime.
- `lib/repositories/factory.js` — **escolhe o backend** (Fase 7). Unico lugar
  do sistema que sabe qual persistencia esta em uso.

`route.js` **nao conhece mais nenhum driver de banco**. Os 3 acessos diretos
que existiam fora do contrato foram eliminados na Fase 7: `ensureIndexes()`
(foi para a factory; no Supabase e no-op, os indices vem das migrations),
bulk-insert do seed (virou `createMany()` nos repositories) e
`webhook_events` (virou `webhookEventsRepository`, nos dois backends).

## 2.4 Autenticacao e autorizacao

- **Auth: JWT local** (HMAC-SHA256) + senhas com **scrypt**. Ainda **nao**
  migrado para Supabase Auth (decisao tomada, execucao nao iniciada — §10).
- **RBAC: hardcoded** nos objetos `ROLES`/`PERMISSIONS` do `route.js`.
  As tabelas `papeis`/`permissoes` existem no Supabase e tem seed, mas **o
  app nao le elas** — armadilha conhecida, nao "corrigir" sem decisao.
- Papeis: `OWNER`, `ADMIN`, `GERENTE`, `ATENDENTE`, `COZINHA`.

---

# 3. Multi-tenancy (regra critica do produto)

Toda entidade de dominio carrega **`empresa_id`**. Isolamento em **duas
camadas, sempre as duas**:

1. **Aplicacao**: toda query e escopada por `empresa_id` extraido do token.
2. **Postgres RLS**: 17 tabelas com RLS habilitado, 18 policies.

Nunca confiar so em RLS, nem so na aplicacao. Ao criar qualquer entidade
nova: incluir `empresa_id`, criar a policy RLS e escrever teste de isolamento
cross-tenant.

Verificado no Supabase real: **0 tabelas de dominio sem `empresa_id`** (fora
os catalogos globais `papeis`/`permissoes` e a raiz `empresas`, por desenho),
com **71 empresas convivendo no mesmo projeto** e 6 testes de isolamento
(list/`findById`/`update` cross-tenant) passando.

---

# 4. Modelo de dados

## 4.1 Decisoes estruturais

- **Itens de pedido/comanda sao tabelas relacionais filhas**
  (`pedido_itens`, `comanda_itens`), nao JSONB — decisao do dono do projeto.
  No MongoDB sao arrays embutidos; a traducao acontece no repository.
- **Snapshot historico por item**: `nome` e `preco` sao congelados no momento
  da venda. **Nunca** recalcular a partir do preco atual do produto.
- **`comanda.pagamentos`**: array embutido no Mongo (copia denormalizada);
  no Postgres **nao existe coluna** — a tabela `pagamentos` e a fonte unica.
  O `SupabaseComandaRepository` **reconstroi** esse campo em memoria a cada
  leitura, so para preservar o contrato que `computeComanda()` ja espera.
- **Numeracao de pedido**: tabela `pedido_contadores` + funcao atomica por
  tenant (substituiu um `count()+1` com race condition).

## 4.2 Tabelas (20 no Supabase)

Dominio com `empresa_id`: `usuarios`, `categorias`, `produtos`, `clientes`,
`mesas`, `comandas`, `comanda_itens`, `pedidos`, `pedido_itens`,
`pagamentos`, `transacoes`, `integracoes`, `conversas`, `mensagens`,
`auditoria`, `webhook_events`, `pedido_contadores`.
Raiz do tenant: `empresas`. Catalogos globais: `papeis`, `permissoes`.

## 4.3 Migrations e ORDEM DE EXECUCAO (nao obvia)

`supabase/migrations/0001` a `0014`, mais `triggers.sql`, `policies_rls.sql`,
`seed.sql`. **A ordem correta nao e so numerica** — `0002+` dependem de
funcoes definidas em `triggers.sql`/`policies_rls.sql`:

```
0001_init.sql -> triggers.sql -> policies_rls.sql -> seed.sql
-> 0002_core_fixes -> 0003_pedido_numero_atomico -> 0004_mesas
-> 0005_comandas -> 0006_pagamentos -> 0007_webhook_events
-> 0008_conversas_mensagens -> 0009_repository_support_functions
-> 0010_atomic_create_functions -> 0011_migration_upsert_functions
-> 0012_pedidos_comanda_id -> 0013_increment_conversa_patch_parcial
-> 0014_resync_contador_por_empresa
```

Essa ordem esta no `README.md` e **ja foi executada de ponta a ponta** duas
vezes (Postgres local em Docker e projeto Supabase real).

## 4.4 Funcoes Postgres (todas mecanicas, nenhuma decide negocio)

- `set_updated_at()` — trigger de timestamp.
- `next_pedido_numero()` / `pedidos_set_numero()` — numeracao atomica (a
  trigger e o `nextNumero()` do repository chamam **a mesma** funcao; nunca
  ha dois caminhos de numeracao).
- `increment_cliente_metricas()`, `increment_conversa_nao_lidas()` —
  equivalente ao `$inc` atomico do Mongo.
- `create_pedido_com_itens()`, `create_comanda_com_itens()` — insert atomico
  pai+filhos (usadas pelo app).
- `upsert_pedido_com_itens()`, `upsert_comanda_com_itens()`,
  `resync_pedido_contadores()` — versoes idempotentes, usadas **so** pela
  ferramenta de migracao.

---

# 4.4 Switch de runtime (`DATABASE_PROVIDER`)

A escolha do backend vive so em `lib/repositories/factory.js`:

```bash
DATABASE_PROVIDER=mongo      # default (omitir tem o mesmo efeito)
DATABASE_PROVIDER=supabase   # exige SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
```

- Conferir o que esta ativo: `GET /api/health` -> campo `database`.
- **Sem fallback silencioso**: `supabase` sem credenciais **falha**, em vez de
  cair para o Mongo — um fallback silencioso gravaria dados no banco errado
  sem ninguem perceber.
- **Sem modo hibrido**: misturar backends na mesma requisicao daria leitura
  inconsistente e quebraria as FKs do Postgres.
- Trocar exige reiniciar o processo (o `next dev` recarrega `.env` sozinho).
- Detalhes: `docs/plans/PHASE-7-RUNTIME-SWITCH.md`.

---

# 5. Conexoes e integracoes

Credenciais vivem **so** no `.env` da raiz (nao versionado, esta no
`.gitignore`). Nunca commitar segredo, nunca escrever chave neste documento.

| O que | Onde configurar (`.env`) | Observacoes |
|---|---|---|
| MongoDB (runtime atual) | `MONGO_URL`, `DB_NAME` | Local: container `ros-mongo-local`, banco `restaurant_os_dev` |
| Supabase (API) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Projeto real ja configurado; `service_role` nunca vai ao frontend |
| Supabase (SQL direto) | `SUPABASE_DB_URL` | **Usar o Session Pooler (IPv4)**. A Direct connection (`db.<ref>.supabase.co`) resolve para IPv6 e fica inacessivel desta rede (`Network is unreachable`) |
| Evolution API (WhatsApp) | tabela `integracoes` (`empresa_id` + `tipo='evolution'`, `config` JSONB) | **Uma instancia por empresa.** Codigo em `lib/integrations/evolution.js` |
| n8n | tabela `integracoes` (`tipo='n8n'`) | `lib/integrations/n8n.js` |
| Mercado Pago | tabela `integracoes` (`tipo='mercadopago'`) | `lib/integrations/payments/` |

**Regra inegociavel das integracoes:** sem credencial configurada, retornar
"nao configurado"/erro apropriado. **Nunca** mockar sucesso — nunca Pix
falso, QR Code falso, pagamento falso, webhook falso, status falso.

Fluxo WhatsApp completo (testar inteiro ao mexer em qualquer parte):
`Evolution -> Webhook -> Cliente -> Conversa -> Mensagem -> Pedido -> Atendimento`.

---

# 6. Estado real de cada fase

| Fase | Status |
|---|---|
| 1 — Auditoria da migracao | **Concluida** (`docs/plans/MONGO-TO-SUPABASE-AUDIT.md`) |
| 2 — Contratos de dominio | **Concluida** (`packages/domain/src/index.ts`) |
| 3 — Extrair Mongo do `route.js` | **Concluida** (16 repositories, 8 lotes testados) |
| 3.5 — Remover triggers de negocio | **Concluida** (`docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md`) |
| 4 — Schema Supabase | **Concluida** (`docs/plans/PHASE-4-SUPABASE-SCHEMA.md`) |
| 5 — `Supabase*Repository` | **Concluida** (`docs/plans/PHASE-5-SUPABASE-REPOSITORIES.md`) |
| 6 — Ferramenta de migracao de dados | **Concluida** (`docs/plans/PHASE-6-DATA-MIGRATION.md`) |
| 6B — Validacao contra Supabase REAL | **Concluida** (`docs/plans/PHASE-6B-SUPABASE-REAL.md`) |
| 7 — Switch de runtime (`DATABASE_PROVIDER`) | **Concluida** (`docs/plans/PHASE-7-RUNTIME-SWITCH.md`) |
| **Corte de producao (rodar sobre Supabase de verdade)** | **NAO FEITO** — aguarda decisao do dono |
| Auth -> Supabase Auth | **NAO INICIADA** — falta auditoria propria |
| Realtime / Storage | **NAO INICIADOS** |

**O runtime ATIVO e `mongo`** (default deliberado da Fase 7). A aplicacao ja
roda igualmente bem sobre Supabase — basta `DATABASE_PROVIDER=supabase` —
mas trocar em producao e uma decisao de negocio, nao tecnica: exige janela de
manutencao e nova migracao contra o Mongo de PRODUCAO (o que foi migrado ate
agora foi o Mongo de desenvolvimento). Conferir o backend ativo:
`GET /api/health` -> campo `database`.

## 6.1 O que a Fase 6B (hoje) entregou

- Projeto Supabase real **nao estava vazio**: tinha 17 tabelas de uma versao
  antiga do sistema (plataforma "emergent"), modelo generico
  `id/empresa_id/data jsonb/created_at`, com dados. Por decisao do dono, foi
  descartado — **com `pg_dump` completo salvo antes** em `backups/`
  (diretorio no `.gitignore`; pode conter dado real de cliente).
- Schema atual (0001→0013) aplicado no Supabase real, sem erros: 20 tabelas,
  17 com RLS, 18 policies, 12 funcoes, seed RBAC (5 papeis / 30 permissoes).
- **39/39 testes** dos repositories via `@supabase/supabase-js` real (com
  Kong), incluindo 6 de isolamento multi-tenant.
- Migracao de dados real: **71/71 empresas, 0 erros**; validacao **71/71,
  0 divergencias**. Contagens batendo exatamente com o MongoDB.

---

# 7. Ambiente local (como resubir tudo apos reboot)

Nada abaixo sobrevive a um desligamento — resubir nesta ordem:

1. **`.env`** ja existe na raiz (nao versionado): `MONGO_URL`, `DB_NAME`,
   `JWT_SECRET`, `CORS_ORIGINS`, `NEXT_PUBLIC_BASE_URL` e as chaves Supabase.
2. **Docker Desktop**: iniciar o app (fica em
   `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`) e esperar o
   daemon responder a `docker ps`.
3. **MongoDB**: `docker start ros-mongo-local`
   (se sumiu: `docker run -d --name ros-mongo-local -p 27017:27017 mongo:7`).
   Banco `restaurant_os_dev` tem **71 empresas** de uso organico das Fases
   3-6 — dataset valioso para teste, **nao apagar**.
4. **Cliente `psql`**: nao existe no PATH desta maquina. Usar container
   descartavel: `docker run --rm -i postgres:17 psql "<url>" -c "..."`.
5. **Ambiente Supabase local** (opcional — so se quiser testar sem tocar no
   projeto real): containers `ros-pg-test`
   (`public.ecr.aws/supabase/postgres:17.6.1.158`) e `ros-postgrest-test`
   (`public.ecr.aws/supabase/postgrest:v14.16`) na rede `ros-supabase-test`.
   **Sem Kong** — por isso os testes locais usam
   `@supabase/postgrest-js` `PostgrestClient` direto, e nao
   `createClient()` do `@supabase/supabase-js` (que espera o prefixo
   `/rest/v1` do gateway). Contra o projeto real, usar `createClient()`.
6. **`corepack enable`** — necessario nesta maquina para o `yarn` resolver no
   PATH do Git Bash.
7. **App**: `yarn dev:no-reload` (`localhost:3000`).
8. **Testes de regressao**:
   `PYTHONIOENCODING=utf-8 python backend_test.py` (e `_v2`, `_v3`) — a
   variavel evita crash de encoding no console do Windows (emojis nos logs).

**Baseline MongoDB** (estavel desde a Fase 3): **v1 40/40, v2 39/39,
v3 32/33**. A unica "falha" do v3 nao e bug: e `tipo:'conversation'` em vez
de `'text'` no webhook do WhatsApp — comportamento correto da Evolution API,
documentado em `test_result.md`.

---

# 8. Decisoes tomadas (nao renegociar sem confirmar)

1. **Um unico projeto Supabase para todos os clientes.** Multi-tenant por
   `empresa_id`; a instancia Evolution e que muda por empresa. Nunca um
   projeto por restaurante.
2. **Itens em tabelas relacionais** com snapshot historico; preco do item
   nunca recalculado do produto atual.
3. **Regra de negocio so no Service.** Postgres so cuida de integridade +
   funcoes mecanicas. Isso ja forcou uma correcao real: o `ComandaRepository`
   projetado na Fase 2 tinha metodos de alto nivel (`addItem`, `fechar`) que
   embutiam recalculo/orquestracao — substituidos por metodos finos
   (`pushItem`, `updateItemCampos`, `removeItem`, `pushPagamentoResumo`,
   `setDerivados`) que so persistem o que o Service ja calculou.
4. **Auth migra para Supabase Auth** (nao so a persistencia) — decidido, nao
   iniciado.
5. **Migracao de dados**: MongoDB e a fonte de verdade durante todo o
   processo. Nunca alterar/apagar dado no Mongo; nunca trocar o runtime sem
   aprovacao explicita; **migrar com base no formato REAL dos documentos**,
   nunca assumindo que batem com `domain.ts` (essa disciplina achou quase
   todos os bugs listados no §9).
6. **Nunca mockar integracao externa** (Evolution / Mercado Pago / n8n).

---

# 9. Achados e armadilhas (para nao redescobrir)

Bugs reais encontrados **rodando** contra banco de verdade, nao lendo codigo:

1. **`pedidos.comanda_id` nunca existiu como coluna** — pedidos gerados por
   fechamento de comanda sempre carregam esse campo no Mongo. Corrigido na
   migration `0012`.
2. **`pedidos_tipo_check` nao aceitava `'mesa'`** — 4o valor real de `tipo`,
   usado no mesmo fluxo. Corrigido na `0012`; `PedidoTipo` ampliado.
3. **Ordem de migracao**: apos criar a FK do item 1, `comandas` **tem que**
   migrar antes de `pedidos` (a ordem original era o inverso).
4. **`jsonb_populate_record()` zera campos ausentes com NULL** em vez de
   aplicar o `DEFAULT` da coluna. Por isso as funcoes atomicas usam lista de
   colunas explicita + `coalesce()`.
5. **Upsert em lote via PostgREST nao aplica `DEFAULT` por linha** — se o
   lote mistura documentos com e sem um campo opcional (`updated_at`), as
   linhas sem ele recebem `NULL` e violam `not null`. Diferente de um INSERT
   de linha unica. Tratado no `pick()` do script de migracao.
6. **`supabase-js` remove chaves `undefined`** do corpo JSON: uma RPC com
   parametros obrigatorios sem default falha com `PGRST202` ("function not
   found in schema cache") quando recebe patch parcial — erro confuso.
   Corrigido na `0013` com defaults + `coalesce`.
7. **Direct connection do Supabase e IPv6** — inacessivel desta rede; usar o
   Session Pooler.
8. **`papeis`/`permissoes` existem no banco mas o app nao le** — RBAC e
   hardcoded no `route.js`.
9. Ao apagar uma empresa, o `ON DELETE CASCADE` limpa todo o tenant — util
   para limpar dado de teste, perigoso em producao.
10. **O seed criava a mesa demo apontando para uma comanda inexistente**
    (violava `mesas_comanda_id_fkey`). No Mongo passava — nao ha FK. Mesma
    dependencia circular `mesas ⇄ comandas` da ferramenta de migracao;
    resolvido com as mesmas 2 passadas (Fase 7).
11. **Bulk insert de pedidos nao avanca `pedido_contadores`** — usa `numero`
    explicito e nao passa pela trigger, entao o proximo pedido criado pela
    aplicacao colidia (`pedidos_empresa_id_numero_key`). No Mongo nao ocorre
    porque `nextNumero()` la e `count()+1`. Corrigido com
    `resync_pedido_contador_empresa()` (migration `0014`), chamada pelo
    `createMany()` do repository Supabase. **Regra geral: todo caminho de
    carga em lote com numero explicito precisa realinhar o contador.**

---

# 10. Pendencias e proximos passos

- [ ] **Corte de producao para Supabase**: o switch ja existe e esta
      validado (Fase 7), mas ligar em producao exige janela de manutencao e
      nova migracao contra o Mongo de PRODUCAO. **Decisao do dono.**
- [ ] **Corte de producao**: a migracao rodou contra o Mongo de
      *desenvolvimento*. Um corte real exige janela de manutencao e nova
      execucao contra o Mongo de producao (sempre `--dry-run` antes).
- [ ] **Auditoria de Auth** antes de qualquer codigo de Supabase Auth:
      estrategia de migracao de senha (scrypt -> Supabase Auth), formato de
      sessao/token, onde ficam as claims de RBAC.
- [ ] **Decisao de infra**: criar o servico "app" no projeto "restaurante"
      do EasyPanel (Hostinger, IP 187.77.226.88 — ja tem `evolution-api`,
      `evolution-api-db`, `evolution-api-redis` e `n8n` rodando; **nao** tem
      servico do app nem banco de producao).
- [ ] **Nada foi enviado ao remoto** — todos os commits estao locais em
      `main`. `git push` exige confirmacao do dono (regra do `CLAUDE.md`).

---

# 11. Commits locais (mais recentes primeiro, nenhum pushed)

```
537ab77 feat(fase7): paridade completa de runtime MongoDB <-> Supabase
2ccf90d refactor(fase7): factory de repositories com switch DATABASE_PROVIDER
87afa2a feat(supabase): valida schema, repositories e migracao contra Supabase real
d6ee777 docs: update HANDOFF.md - Fase 6 (migration tooling) complete
7bd641a feat(migration): ferramenta de migracao de dados MongoDB -> Supabase (Fase 6)
5e082a2 feat(supabase): idempotent migration upserts + fix missing pedidos.comanda_id gap
9f45f80 fix(supabase): atomic create for pedido+itens and comanda+itens (RPC)
d29f4d3 feat(supabase): implement Supabase repositories (Fase 5), Mongo stays runtime
305c350 feat(supabase): complete Fase 4 schema (missing tables + fixes + atomic numbering)
8e15454 fix(supabase): remove business-logic triggers, keep only mechanical ones
f43e51e docs: add comprehensive Mongo->Supabase migration audit before Fase 4
22b1f61 docs: update HANDOFF.md - Fase 3 complete (all 16 collections extracted)
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

# 12. Mapa de arquivos e documentos

**Governanca**
- `CLAUDE.md` — regras de operacao autonoma (ler antes de qualquer tarefa).
  Secao 18.1 define o formato obrigatorio deste handoff.

**Codigo**
- `app/api/[[...path]]/route.js` — API inteira (Controller + Service).
- `packages/domain/src/index.ts` — contratos de dominio.
- `lib/repositories/mongo/` — 16 repositories (backend default).
- `lib/repositories/supabase/` — 15 repositories (validados como runtime).
- `lib/repositories/factory.js` — switch `DATABASE_PROVIDER` (Fase 7).
- `lib/integrations/` — `evolution.js`, `n8n.js`, `supabase.js`, `payments/`.
- `components/`, `hooks/` — frontend.

**Banco**
- `supabase/migrations/0001`…`0014`, `triggers.sql`, `policies_rls.sql`,
  `seed.sql`. Ordem real de execucao: `README.md` e §4.3 aqui.

**Ferramentas**
- `scripts/migrate-mongo-to-supabase.mjs` — migracao de dados (idempotente;
  `--dry-run`, `--empresa`, `--checkpoint`, `--log`).
- `scripts/validate-migration.mjs` — validacao pos-migracao (so leitura).

**Documentacao (`docs/plans/`)**
- `MONGO-TO-SUPABASE-AUDIT.md` — auditoria original.
- `PHASE-3.5-TRIGGER-CLEANUP.md` — remocao dos triggers de negocio.
- `PHASE-4-SUPABASE-SCHEMA.md` — schema completo.
- `PHASE-5-REPOSITORIES-AUDIT.md`, `PHASE-5-SUPABASE-REPOSITORIES.md`.
- `PHASE-6-MIGRATION-AUDIT.md`, `PHASE-6-DATA-MIGRATION.md`.
- `PHASE-6B-SUPABASE-REAL.md` — validacao contra o Supabase hospedado.
- `PHASE-7-RUNTIME-SWITCH.md` — switch de runtime e paridade comprovada.
- `docs/ARCHITECTURE.md` (ADR-006), `docs/FOLDER_STRUCTURE.md`.

**Testes**
- `backend_test.py`, `_v2`, `_v3` — regressao de backend (baseline no §7).
- `test_result.md` — historico e comportamentos conhecidos.

**Backups**
- `backups/` — dumps do Supabase. **No `.gitignore`** (pode conter dado real).
