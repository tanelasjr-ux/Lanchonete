# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-11 (fim de sessao — Fase 6 concluida)

## Como usar este arquivo

No inicio de qualquer sessao de trabalho neste projeto, leia este arquivo
primeiro — ele resume onde o trabalho parou e o que falta decidir. No fim de
cada sessao (ou quando pedido "gere um handoff"), este arquivo deve ser
reescrito com o estado real e atualizado, substituindo o conteudo anterior.

## Estado atual

**Governanca do projeto:** `CLAUDE.md` na raiz define modo de agente
autonomo (nao pedir autorizacao por etapa, exceto para git push/force
push/branch remota, operacoes destrutivas sem rollback, credencial externa
faltante, ou decisao de produto ambigua). Ler `CLAUDE.md` antes de executar
qualquer tarefa.

**Migracao MongoDB -> Supabase — progresso real (fases 1 a 6 concluidas,
cada uma aprovada explicitamente pelo dono do projeto antes de comecar):**

- **Fase 1 (auditoria):** concluida. `docs/plans/MONGO-TO-SUPABASE-AUDIT.md`.
- **Fase 2 (`packages/domain/src/index.ts`):** concluida. Contratos completos
  para as 15 entidades + repositories (TypeScript, nao compilado — sem
  tsconfig/typescript no projeto, serve como documentacao de contrato).
- **Fase 3 (extrair Mongo de `route.js` para `lib/repositories/mongo/*`):**
  concluida. As 16 colecoes (15 do plano + `empresaRepository`, achado no
  fim) foram extraidas em 8 lotes, sempre preservando comportamento
  identico (testado a cada lote). `route.js` so acessa `db.collection()`
  direto para `ensureIndexes()`, seed bulk-insert e `webhook_events` (fora
  do escopo do contrato `Repository<T>`).
- **Fase 3.5 (limpeza de triggers de negocio):** concluida.
  `pedido_recalc_total()`/`pedido_on_conclusao()` removidas do Postgres —
  so restam triggers mecanicas (`set_updated_at`, numeracao atomica de
  pedido). ADR-006 em `docs/ARCHITECTURE.md` documenta o principio "regra de
  negocio so no Service". `docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md`.
- **Fase 4 (schema Supabase completo):** concluida. 6 tabelas novas
  (`mesas`, `comandas`, `comanda_itens`, `pagamentos`, `webhook_events`,
  `conversas`, `mensagens`), correcoes em tabelas existentes, numeracao
  atomica de pedido (`pedido_contadores` + trigger). `docs/plans/PHASE-4-SUPABASE-SCHEMA.md`.
  Migrations `0001` a `0008` + `triggers.sql`/`policies_rls.sql`/`seed.sql`.
  **Ordem de execucao real e nao-obvia** (documentada no README): `0001` ->
  `triggers.sql` -> `policies_rls.sql` -> `seed.sql` -> `0002` em diante,
  porque `0002+` dependem de funcoes definidas em `triggers.sql`/`policies_rls.sql`.
- **Fase 5 (`Supabase*Repository`, runtime continua Mongo):** concluida. 15
  repositories (14 entidades + `webhookEventsRepository`) em
  `lib/repositories/supabase/*.js`, satisfazendo os mesmos contratos de
  `domain.ts` que os `Mongo*Repository`. `route.js` **nao foi tocado** —
  ainda 100% MongoDB em runtime. `docs/plans/PHASE-5-SUPABASE-REPOSITORIES.md`,
  `docs/plans/PHASE-5-REPOSITORIES-AUDIT.md`.
  - **Correcao preventiva feita antes da Fase 6**: `pedidoRepository.create()`/
    `comandaRepository.create()` faziam 2 escritas separadas (pai + itens)
    sem atomicidade — corrigido com RPCs Postgres (`create_pedido_com_itens()`,
    `create_comanda_com_itens()`, migration `0010`). Achado durante os testes
    da propria correcao: `jsonb_populate_record()` zera com `NULL` (nao o
    `DEFAULT` da coluna) campos ausentes no JSON — corrigido usando `INSERT`
    com lista de colunas explicita + `coalesce()`.
- **Fase 6 (ferramenta de migracao de dados MongoDB -> Supabase):
  CONCLUIDA NESTA SESSAO.** `scripts/migrate-mongo-to-supabase.mjs` (CLI
  idempotente, `--dry-run`/`--empresa`/`--checkpoint`/`--log`) e
  `scripts/validate-migration.mjs` (validacao pos-migracao, so leitura).
  Testado contra as 71 empresas reais do MongoDB de desenvolvimento: 100%
  migrado, 0 divergencias, 0 regressao. Detalhes completos e o resumo no
  formato pedido pelo usuario estao em `docs/plans/PHASE-6-DATA-MIGRATION.md`.
  **Runtime da aplicacao continua 100% MongoDB** — esta fase so entregou a
  ferramenta e validou que ela funciona; nao trocou `DATABASE_PROVIDER`
  nem tocou `route.js`.

  **4 achados reais corrigidos durante esta fase** (encontrados testando
  contra dados/Postgres reais, nao so lendo codigo — ver
  `docs/plans/PHASE-6-DATA-MIGRATION.md` §1 para detalhe completo):
  1. `pedidos.comanda_id` nunca existiu como coluna (pedidos originados de
     fechamento de comanda sempre carregam esse campo no Mongo real) —
     coluna nova + FK, migration `0012_pedidos_comanda_id.sql`.
  2. `pedidos_tipo_check` nao incluia `'mesa'` (4o valor real de `tipo`,
     usado no mesmo fluxo do item 1) — constraint corrigida na mesma
     migration. `packages/domain/src/index.ts`: `PedidoTipo` ampliado.
  3. Ordem de migracao `pedidos` antes de `comandas` ficou invalida depois
     da correcao do item 1 (nova FK `pedidos.comanda_id -> comandas.id`) —
     ordem invertida no script de migracao E em
     `docs/plans/PHASE-6-MIGRATION-AUDIT.md` §2.
  4. Upsert em lote via PostgREST nao aplica o `DEFAULT` da coluna por
     linha quando o lote mistura documentos com/sem um campo opcional
     (`updated_at`, presente so em documentos ja editados no Mongo) — grava
     `NULL` em vez do default, violando `not null`. Corrigido no proprio
     script (`updated_at` ausente cai para `created_at`).
  5. `upsert_pedido_com_itens()`/`upsert_comanda_com_itens()` (RPCs
     idempotentes usadas so pela ferramenta de migracao) adicionadas na
     migration `0011_migration_upsert_functions.sql`.

  Migrations Supabase atuais: `0001` a `0012` (ordem completa de execucao
  documentada no `README.md`, secao "Ativando o Supabase").

- **Auth:** ainda 100% JWT local (HMAC-SHA256 + scrypt). Migracao para
  Supabase Auth (decisao tomada na Fase 1) **ainda nao iniciada** — precisa
  de auditoria propria antes de comecar (estrategia de migracao de senha,
  formato de sessao, onde ficam as claims de RBAC).

- **Fase 7 (troca de runtime em producao): NAO INICIADA.** Aguardando
  aprovacao explicita do dono do projeto, conforme instruido em toda a
  sessao ("nao avancar automaticamente").

**Infraestrutura (EasyPanel / Hostinger, IP 187.77.226.88):** projeto
"restaurante" no EasyPanel ja tem `evolution-api`, `evolution-api-db`,
`evolution-api-redis` e `n8n` rodando. **Ainda nao existe** um servico "app"
nem MongoDB de producao no mesmo projeto — decisao em aberto, nao avancada
em nenhuma sessao ate agora.

## Ambiente local de desenvolvimento

Processos abaixo rodam localmente na maquina do usuario e **nao sobrevivem a
um desligamento/reboot** — para retomar:

1. `.env` ja existe na raiz do projeto (nao versionado) com `MONGO_URL`,
   `DB_NAME`, `JWT_SECRET` de desenvolvimento, `CORS_ORIGINS=*`.
2. Subir o MongoDB local: `docker start ros-mongo-local` (container ja
   existe; se tiver sido removido, recriar com
   `docker run -d --name ros-mongo-local -p 27017:27017 mongo:7`).
   Banco de dev real: `restaurant_os_dev` (71 empresas acumuladas de uso
   organico durante as Fases 3-6 — dataset util para testes, nao apagar).
3. Ambiente de teste Supabase local (Postgres + PostgREST, usado nas Fases
   4-6 para validar schema/repositories/migracao contra um Postgres real
   sem precisar de projeto Supabase hospedado): containers Docker
   `ros-pg-test` (imagem oficial `public.ecr.aws/supabase/postgres:17.6.1.158`)
   e `ros-postgrest-test` (`public.ecr.aws/supabase/postgrest:v14.16`) numa
   rede `ros-supabase-test`. **Nao sobem sozinhos** — se precisar recriar,
   ver o padrao usado nas Fases 4-6 (Postgres com `POSTGRES_PASSWORD=postgres`,
   PostgREST apontando `PGRST_DB_URI=postgres://postgres:postgres@ros-pg-test:5432/postgres`
   e `PGRST_JWT_SECRET` combinando com um JWT `service_role` mintado
   localmente via Node `crypto` — sem Kong, por isso o cliente de teste usa
   `@supabase/postgrest-js` `PostgrestClient` direto na porta do PostgREST,
   nao `@supabase/supabase-js` `createClient()`, que espera o prefixo
   `/rest/v1` do Kong). Migrations `0001` a `0012` ja aplicadas nesse
   Postgres de teste ao fim desta sessao; dados de teste da Fase 6 foram
   limpos, restam so os 3 registros de fixture das Fases 4/5.
4. `corepack enable` (necessario nesta maquina para `yarn` resolver no PATH
   do Git Bash).
5. `node_modules` ja existe; se nao existir, `yarn install`.
6. Subir o app: `yarn dev:no-reload` (roda em `localhost:3000`).
7. Rodar os testes de regressao: `PYTHONIOENCODING=utf-8 python backend_test.py`
   (e `_v2`/`_v3`) — `PYTHONIOENCODING=utf-8` evita crash de encoding no
   console do Windows por causa dos emojis nos logs.

## Decisoes ja tomadas (nao renegociar sem confirmar com o usuario)

1. **Itens de pedido/comanda**: tabelas relacionais (`pedido_itens`,
   `comanda_itens`), nao JSONB, com snapshot historico completo por item.
   Preco do item nunca recalculado a partir do preco atual do produto.
2. **Regras de negocio**: exclusivamente no Service (`route.js` hoje).
   Postgres so cuida de integridade (FK, NOT NULL, CHECK, UNIQUE, indices,
   RLS) + funcoes mecanicas (numeracao atomica, upsert atomico pai+filhos).
   Nenhuma funcao Postgres decide valor de negocio — todas recebem o valor
   ja calculado pelo Service/script de migracao.
3. **Autenticacao**: migrar tambem para **Supabase Auth** (nao so a
   persistencia) — ainda sem auditoria propria, nao iniciado.
4. **Migracao de dados**: MongoDB e sempre a fonte de verdade durante todo
   o processo; nunca alterar/apagar dado no Mongo; nunca trocar o runtime
   sem aprovacao explicita; migrar com base no formato REAL dos documentos
   Mongo, nunca assumir que bate 100% com `domain.ts` (esta disciplina
   encontrou 4 dos 5 achados reais desta sessao, ver Fase 6 acima).

## Pendencias / proximos passos

- [ ] **Fase 7 (avaliar troca de runtime)**: schema, repositories e
      ferramenta de migracao estao prontos e validados localmente. Decisao
      de quando/como avancar e do dono do projeto — nao iniciar sem
      aprovacao explicita.
- [ ] **Migracao de dados em ambiente real**: a ferramenta (`scripts/migrate-mongo-to-supabase.mjs`)
      so foi testada contra o Postgres de teste local (Docker). Antes de
      rodar contra um projeto Supabase hospedado de verdade, rodar
      `--dry-run` primeiro e revisar o relatorio.
- [ ] **Auditoria de Auth**: estrategia de migracao de senha (scrypt local
      -> Supabase Auth), formato de sessao/token, onde ficam as claims de
      RBAC — antes de iniciar qualquer trabalho de Supabase Auth.
- [ ] **Decisao de infra**: criar o servico "app" no projeto "restaurante"
      do EasyPanel e resolver a origem do MongoDB/Postgres de producao
      (self-hosted no EasyPanel vs gerenciado externo) antes do primeiro
      deploy real.
- [ ] Nenhum commit desta sessao foi enviado ao remoto (`git push`) — tudo
      local na branch `main`.

## Commits locais (nao pushed, mais recentes primeiro)

```
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

## Referencias uteis

- `CLAUDE.md` — regras de operacao autonoma para este projeto.
- `docs/ARCHITECTURE.md` (inclui ADR-006: regra de negocio so no Service),
  `docs/FOLDER_STRUCTURE.md` — arquitetura atual.
- `docs/plans/MONGO-TO-SUPABASE-AUDIT.md` — auditoria original (Fase 1).
- `docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md` — limpeza de triggers de negocio.
- `docs/plans/PHASE-4-SUPABASE-SCHEMA.md` — schema Supabase completo.
- `docs/plans/PHASE-5-REPOSITORIES-AUDIT.md`, `PHASE-5-SUPABASE-REPOSITORIES.md`
  — repositories Supabase + correcao de atomicidade.
- `docs/plans/PHASE-6-MIGRATION-AUDIT.md`, `PHASE-6-DATA-MIGRATION.md` —
  auditoria e execucao da ferramenta de migracao de dados (mais recentes,
  incluem os achados reais desta sessao).
- `packages/domain/src/index.ts` — contratos de dominio completos (Fase 2,
  com correcoes ao longo de todas as fases seguintes).
- `lib/repositories/mongo/` — 16 `Mongo*Repository` (runtime atual).
- `lib/repositories/supabase/` — 15 `Supabase*Repository` (prontos, ainda
  nao usados em runtime).
- `supabase/migrations/0001` a `0012`, `triggers.sql`, `policies_rls.sql`,
  `seed.sql` — schema Supabase completo. Ordem de execucao real no
  `README.md` ("Ativando o Supabase").
- `scripts/migrate-mongo-to-supabase.mjs`, `scripts/validate-migration.mjs`
  — ferramenta de migracao de dados (Fase 6).
- `test_result.md` — historico de testes de backend (contexto); o baseline
  MongoDB (v1 40/40, v2 39/39, v3 32/33 — unica "falha" e comportamento
  correto documentado da Evolution API) nao mudou desde a Fase 3.
