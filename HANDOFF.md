# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-10 (fim de sessao)

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

**Migracao MongoDB -> Supabase — progresso real:**
- Fase 1 (auditoria): concluida.
- Fase 2 (`packages/domain/src/index.ts`): concluida. Contratos completos
  para as 15 entidades + repositories.
- **Fase 3 (extrair Mongo de `route.js` para `lib/repositories/mongo/*`):
  CONCLUIDA NESTA SESSAO.** As 15 colecoes MongoDB do app foram todas
  extraidas em 7 lotes, cada um testado contra a suite completa
  (`backend_test.py`/`_v2`/`_v3`) e commitado separadamente:
  1. `categoriaRepository`, `produtoRepository`, `clienteRepository`
  2. `usuarioRepository`, `transacaoRepository`
  3. `auditoriaRepository`, `integracaoRepository`
  4. `mesaRepository`
  5. `conversaRepository`, `mensagemRepository`
  6. `pedidoRepository`
  7. `comandaRepository`, `pagamentoRepository` (o mais arriscado, feito
     por ultimo de proposito)
  8. `empresaRepository` (lacuna percebida so no fim: empresas, a raiz do
     tenant, tinha ficado de fora dos 7 lotes originais)

  `route.js` agora so acessa `db.collection()` diretamente em 3 situacoes
  deliberadamente fora do escopo do contrato `Repository<T>`: `ensureIndexes()`
  (infra, roda uma vez), o seed bulk-insert (`insertMany` de categorias,
  produtos, clientes, mesas, conversas, mensagens, integracoes — o contrato
  so define `create()` singular) e `webhook_events` (idempotencia tecnica de
  webhook, nao e uma entidade de dominio real).

  **Correcao de design feita durante o lote 7**: o `ComandaRepository`
  desenhado na Fase 2 tinha metodos de alto nivel (`addItem`, `fechar`) que
  embutiam regra de negocio (recalculo via `computeComanda()`, orquestracao
  de pedido+transacao+cliente+mesa) dentro do repository — inconsistente com
  a decisao "regra de negocio so no Service" e com o padrao fino usado nos
  outros 6 lotes. Foi revisado para metodos de baixo nivel
  (`pushItem`/`updateItemCampos`/`removeItem`/`pushPagamentoResumo`/
  `setDerivados`) que so persistem o que `route.js` ja calculou.
  `reloadComanda()` continua sendo o unico lugar que chama `computeComanda()`.

- Durante a Fase 2/3 corrigi 3 imprecisoes que eu mesmo tinha escrito no
  domain.ts sem checar contra o codigo real (sempre reconferir, nunca supor):
  `desconto_tipo` e `'valor' | 'percent'` (nao `'percentual'`); `MesaStatus`
  tem 4 valores (`livre/ocupada/aguardando_pagamento/reservada`); `PedidoStatus`
  tem dois vocabularios convivendo sem normalizacao — o minusculo original e
  um maiusculo do v3 (`NOVO/CONFIRMADO/EM_PREPARACAO/PRONTO/
  SAIU_PARA_ENTREGA/ENTREGUE/CANCELADO`) usado pela Central de Atendimento.

- **O que NAO foi feito ainda**: nenhum schema novo no Supabase (tabelas de
  mesas/comandas/pagamentos/conversas/mensagens continuam so no Mongo), nenhum
  `Supabase*Repository`, nenhum switch `DATABASE_PROVIDER`. O runtime
  continua 100% MongoDB — a Fase 3 foi um refactor interno (Mongo continua
  sendo a unica implementacao real), preparando o terreno para a Fase 4.

**Achado de seguranca corrigido (sessao anterior):** `.env` nao estava no
`.gitignore` — corrigido antes de qualquer commit.

**Baseline de testes:** confirmado identico em TODOS os 7 lotes desta sessao
— **v1 40/40, v2 39/39, v3 32/33** (unica falha e a inconsistencia ja
documentada em `test_result.md`, `tipo:'conversation'` em vez de `'text'` no
webhook do WhatsApp — comportamento correto da Evolution API, nao e bug).
`BASE_URL` dos scripts de teste e configuravel por env, default
`http://localhost:3000/api`.

**Infraestrutura (EasyPanel / Hostinger, IP 187.77.226.88):** projeto
"restaurante" no EasyPanel ja tem `evolution-api`, `evolution-api-db`,
`evolution-api-redis` e `n8n` rodando. **Ainda nao existe** um servico "app"
nem MongoDB no mesmo projeto — decisao em aberto, nao avancada em nenhuma
sessao ate agora.

## Ambiente local de desenvolvimento

Processos abaixo rodam localmente na maquina do usuario e **nao sobrevivem a
um desligamento/reboot** — para retomar:

1. `.env` ja existe na raiz do projeto (nao versionado) com `MONGO_URL`,
   `DB_NAME`, `JWT_SECRET` de desenvolvimento, `CORS_ORIGINS=*`.
2. Subir o MongoDB local: `docker start ros-mongo-local` (container ja
   existe; se tiver sido removido, recriar com
   `docker run -d --name ros-mongo-local -p 27017:27017 mongo:7`).
3. `corepack enable` (necessario nesta maquina para `yarn` resolver no PATH
   do Git Bash).
4. `node_modules` ja existe; se nao existir, `yarn install`.
5. Subir o app: `yarn dev:no-reload` (roda em `localhost:3000`).
6. Rodar os testes de regressao: `PYTHONIOENCODING=utf-8 python backend_test.py`
   (e `_v2`/`_v3`) — `PYTHONIOENCODING=utf-8` evita crash de encoding no
   console do Windows por causa dos emojis nos logs.

## Decisoes ja tomadas (nao renegociar sem confirmar com o usuario)

1. **Itens de pedido/comanda**: tabelas relacionais (`pedido_itens`,
   `comanda_itens`), nao JSONB, com snapshot historico completo por item.
   Preco do item nunca recalculado a partir do preco atual do produto.
   Ja refletido em `domain.ts` (`PedidoItem`/`ComandaItem`).
2. **Regras de negocio**: exclusivamente no Service (route.js hoje).
   Postgres so cuida de integridade (FK, NOT NULL, CHECK, UNIQUE, indices,
   RLS). Nao reimplementar regra de negocio via trigger sem justificativa
   documentada. Este principio guiou a correcao de design no lote 7 acima.
3. **Autenticacao**: migrar tambem para **Supabase Auth** (nao so a
   persistencia) — hashes de senha atuais (scrypt) sao incompativeis,
   quase toda rota valida sessao via `AuthProvider` local. **Ainda sem
   auditoria propria** (a Fase 1 cobriu so persistencia, assumindo JWT
   local).

## Pendencias / proximos passos

- [ ] **Fase 4 — Schema Supabase**: criar as migrations que faltam (mesas,
      comandas, comanda_itens, pagamentos, webhook_events, conversas,
      mensagens — nenhuma existe hoje) + as correcoes ja identificadas na
      auditoria original (colunas novas em `empresas`/`usuarios`/`transacoes`,
      CHECK constraint de `integracoes` faltando `mercadopago`). So depois
      disso comecar os `Supabase*Repository`.
- [ ] **Decisao de infra**: criar o servico "app" no projeto "restaurante"
      do EasyPanel e resolver a origem do MongoDB (self-hosted no EasyPanel
      vs MongoDB Atlas externo) antes do primeiro deploy real.
- [ ] **Auditoria complementar de Auth**: estrategia de migracao de senha,
      formato de sessao/token, onde ficam as claims de RBAC — antes de
      iniciar qualquer trabalho de Supabase Auth.
- [ ] Nenhum commit desta sessao foi enviado ao remoto (`git push`) — tudo
      local na branch `main`.

## Commits locais (nao pushed, mais recentes primeiro)

```
432a067 refactor: extract empresa Mongo access into repository
796cb05 refactor: extract comanda/pagamento Mongo access into repositories
6f2619f refactor: extract pedido Mongo access into repository
6373f9e refactor: extract conversa/mensagem Mongo access into repositories
aa26ecb refactor: extract mesa Mongo access into repository
6fa0bcd refactor: extract auditoria/integracoes Mongo access into repositories
2675a4b refactor: extract usuario/transacao Mongo access into repositories
a107237 docs: update HANDOFF.md with end-of-day state
ed2c3fe refactor: extract categoria/produto/cliente Mongo access into repositories
0f24486 feat(domain): extend contracts for MongoDB->Supabase migration
e2bfe84 chore: ignore .env files to prevent secret leakage
2d4642a docs: add CLAUDE.md autonomous agent rules and HANDOFF.md
```

## Referencias uteis

- `CLAUDE.md` — regras de operacao autonoma para este projeto.
- `docs/ARCHITECTURE.md`, `docs/FOLDER_STRUCTURE.md` — arquitetura atual.
- `test_result.md` — historico de testes de backend (contexto); o baseline
  vivo/atual esta documentado acima e se confirma rodando `backend_test*.py`.
- `supabase/migrations/0001_init.sql`, `policies_rls.sql`, `triggers.sql`,
  `seed.sql` — schema Supabase atual (cobre so modulos v1; mesas, comandas,
  pagamentos, conversas, mensagens ainda nao tem tabela — trabalho da Fase 4).
- `packages/domain/src/index.ts` — contratos de dominio completos (Fase 2).
- `lib/repositories/mongo/` — **todas as 16 colecoes de dominio extraidas**
  (15 do plano original + `empresaRepository`, que tinha ficado de fora dos
  7 lotes e foi fechado no fim desta sessao ao perceber a lacuna). `route.js`
  so acessa `db.collection()` direto para `ensureIndexes()`, seed bulk-insert
  e `webhook_events` (infra, fora do escopo do contrato `Repository<T>`).
