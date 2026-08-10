# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-09

## Como usar este arquivo

No inicio de qualquer sessao de trabalho neste projeto, leia este arquivo
primeiro — ele resume onde o trabalho parou e o que falta decidir. No fim de
cada sessao (ou quando pedido "gere um handoff"), este arquivo deve ser
reescrito com o estado real e atualizado, substituindo o conteudo anterior.

## Estado atual

**Codigo:** nenhuma alteracao funcional foi feita ainda nesta fase. O
runtime continua 100% MongoDB via `MONGO_URL` (ver `app/api/[[...path]]/route.js`).
O adaptador Supabase (`lib/integrations/supabase.js`) existe mas nao esta
conectado a nenhum repository — e codigo morto ate a migracao comecar.
`test_result.md` e a baseline de testes de backend valida (v1-v3, todos os
modulos ativos passando).

**Governanca do projeto:** `CLAUDE.md` foi criado na raiz deste repositorio
em 2026-08-09, definindo modo de agente autonomo para tarefas de
desenvolvimento (nao pedir autorizacao por etapa, exceto para git push/force
push/branch remota, operacoes destrutivas sem rollback, credencial externa
faltante, ou decisao de produto ambigua). Ler `CLAUDE.md` antes de executar
qualquer tarefa.

**Infraestrutura (EasyPanel / Hostinger, IP 187.77.226.88):** projeto
"restaurante" no EasyPanel ja tem `evolution-api`, `evolution-api-db`,
`evolution-api-redis` e `n8n` rodando. **Ainda nao existe** um servico "app"
para hospedar o Next.js, nem um servico de MongoDB no mesmo projeto — isso
ficou como decisao em aberto (ver Pendencias).

**Migracao MongoDB -> Supabase:** Fase 1 (auditoria) concluida e aprovada
com decisoes. Fase 2 (estender `packages/domain/src/index.ts`) ainda **nao
foi iniciada** — o usuario pediu para pausar e revisar antes de prosseguir.

## Decisoes ja tomadas (nao renegociar sem confirmar com o usuario)

1. **Itens de pedido/comanda**: `pedido_itens` e `comanda_itens` serao
   tabelas relacionais (nao JSONB), preservando snapshot historico completo
   por item (produto_id, nome no momento da venda, quantidade, preco
   unitario no momento da venda, desconto, observacoes, subtotal,
   timestamps, empresa_id). Preco do item nunca deve ser recalculado a
   partir do preco atual do produto.
2. **Regras de negocio**: continuam exclusivamente no Service. Postgres so
   cuida de integridade (FK, NOT NULL, CHECK, UNIQUE, indices, RLS). Nao
   reimplementar regra de negocio via trigger a menos que haja justificativa
   documentada caso a caso.
3. **Autenticacao**: o usuario escolheu migrar tambem para **Supabase Auth**
   (nao so a persistencia). Isso amplia o escopo significativamente: os
   hashes de senha atuais (scrypt, JWT local) sao incompativeis com Supabase
   Auth, e quase toda rota autenticada valida sessao via o `AuthProvider`
   local — essa mudanca toca praticamente todas as rotas, nao so o banco.
   **Esta parte ainda nao tem auditoria propria** (a Fase 1 feita cobriu so
   persistencia, assumindo JWT local).

## Pendencias / proximos passos

- [ ] **Decisao de infra**: criar o servico "app" no projeto "restaurante"
      do EasyPanel e resolver a origem do MongoDB (self-hosted no EasyPanel
      vs MongoDB Atlas externo) antes do primeiro deploy real. Essa decisao
      foi levantada mas ficou pendente quando o foco mudou para a auditoria
      Supabase.
- [ ] **Auditoria complementar de Auth**: mapear estrategia de migracao de
      senha, formato de sessao/token e onde ficam as claims de RBAC
      (papel/empresa_id) antes de iniciar qualquer trabalho de Auth.
- [ ] **Fase 2 da migracao Supabase**: estender `packages/domain/src/index.ts`
      com os contratos que faltam (Empresa completo, Usuario, Auditoria,
      Integracao, Mesa, Comanda, Pagamento, Conversa, Mensagem) — aditivo,
      baixo risco, aguardando autorizacao explicita do usuario para comecar.
- [ ] Confirmar se a decisao de Auth (Supabase Auth completo) muda a ordem
      das fases ja definidas na auditoria original (persistencia primeiro,
      auth depois, ou em paralelo).

## Referencias uteis

- `CLAUDE.md` — regras de operacao autonoma para este projeto.
- `docs/ARCHITECTURE.md`, `docs/FOLDER_STRUCTURE.md` — arquitetura atual.
- `test_result.md` — baseline de testes de backend (usar antes/depois de
  qualquer refactor para checar regressao).
- `supabase/migrations/0001_init.sql`, `policies_rls.sql`, `triggers.sql`,
  `seed.sql` — schema Supabase atual (cobre so modulos v1; mesas, comandas,
  pagamentos, conversas, mensagens ainda nao tem tabela).
- `packages/domain/src/index.ts` — contratos de dominio atuais (incompletos
  frente ao uso real em `route.js`, ver auditoria).
