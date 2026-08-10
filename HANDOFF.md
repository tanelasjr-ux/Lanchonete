# HANDOFF.md — Restaurant OS

Ultima atualizacao: 2026-08-09 (fim de sessao)

## Como usar este arquivo

No inicio de qualquer sessao de trabalho neste projeto, leia este arquivo
primeiro — ele resume onde o trabalho parou e o que falta decidir. No fim de
cada sessao (ou quando pedido "gere um handoff"), este arquivo deve ser
reescrito com o estado real e atualizado, substituindo o conteudo anterior.

## Estado atual

**Governanca do projeto:** `CLAUDE.md` foi criado na raiz deste repositorio,
definindo modo de agente autonomo para tarefas de desenvolvimento (nao pedir
autorizacao por etapa, exceto para git push/force push/branch remota,
operacoes destrutivas sem rollback, credencial externa faltante, ou decisao
de produto ambigua). Ler `CLAUDE.md` antes de executar qualquer tarefa.

**Migracao MongoDB -> Supabase — progresso real:**
- Fase 1 (auditoria): concluida, decisoes aprovadas (ver secao seguinte).
- Fase 2 (`packages/domain/src/index.ts`): **concluida**. Contratos completos
  para todas as 15 entidades (Empresa completo, Usuario, Categoria, Produto,
  Cliente, Pedido/PedidoItem com snapshot historico, Transacao, Auditoria,
  Integracao, Mesa, Comanda/ComandaItem/ComandaComputed, PagamentoRegistro,
  Conversa, Mensagem) + repositories correspondentes. Mudanca 100% aditiva,
  sem consumidor no runtime ainda ate a Fase 3 religar cada entidade.
- Fase 3 (extrair Mongo de `route.js` para `lib/repositories/mongo/*`):
  **em andamento**. Primeiro lote concluido, testado e commitado:
  **Categoria, Produto, Cliente**. Todos os pontos de acesso a essas 3
  colecoes em `route.js` (CRUD proprio + lookups cruzados em pedidos,
  mesas/abrir, comanda-itens, dashboard, conversas, webhook WhatsApp) usam
  os repositories agora. Bulk-insert de seed (`seedEmpresa`) foi
  deliberadamente deixado com `insertMany` direto (fora do escopo do
  contrato `Repository<T>`, que so define create singular).
  **Faltam extrair**: `usuarios`, `pedidos`, `transacoes`, `auditoria`,
  `integracoes`, `mesas`, `comandas` (+ `comanda_itens`/`pagamentos`
  embutidos), `pagamentos`, `webhook_events`, `conversas`, `mensagens`.
  Ordem sugerida (do mais simples ao mais arriscado): `usuarios` +
  `transacoes` + `auditoria` + `integracoes` -> `mesas` -> `conversas` +
  `mensagens` -> `pedidos` -> `comandas`/`pagamentos` (mais arriscado, deixar
  por ultimo, conforme a propria auditoria ja apontava).
- Durante a Fase 2 encontrei e corrigi 2 imprecisoes no que eu mesmo tinha
  escrito no domain.ts (sempre reconferir contra `route.js`, nao contra
  suposicao): `desconto_tipo` e `'valor' | 'percent'` (nao `'percentual'`),
  e `MesaStatus` tem 4 valores (`'livre' | 'ocupada' | 'aguardando_pagamento'
  | 'reservada'`), nao 3.

**Achado de seguranca corrigido:** `.env` nao estava no `.gitignore` —
corrigido antes de qualquer commit (risco de vazar `MONGO_URL`/`JWT_SECRET`
no Git).

**Baseline de testes (backend_test.py/v2/v3):** confirmado identico antes e
depois do refactor da Fase 3 — **v1 40/40, v2 39/39, v3 32/33** (a unica
falha e a inconsistencia ja documentada em `test_result.md`, `tipo:'conversation'`
em vez de `'text'` no webhook do WhatsApp — comportamento correto da
Evolution API, nao e bug, nao e regressao). Os scripts de teste tinham
`BASE_URL` hardcoded para uma URL antiga do preview Emergent que nao existe
mais — corrigido para usar `http://localhost:3000/api` por padrao,
configuravel via env var `BASE_URL`.

**Infraestrutura (EasyPanel / Hostinger, IP 187.77.226.88):** projeto
"restaurante" no EasyPanel ja tem `evolution-api`, `evolution-api-db`,
`evolution-api-redis` e `n8n` rodando. **Ainda nao existe** um servico "app"
para hospedar o Next.js, nem um servico de MongoDB no mesmo projeto — decisao
em aberto, nao avancada nesta sessao (ver Pendencias).

## Ambiente local de desenvolvimento (montado nesta sessao)

Processos abaixo rodam localmente na maquina do usuario e **nao sobrevivem a
um desligamento/reboot** — para retomar amanha:

1. `.env` ja existe na raiz do projeto (nao versionado) com `MONGO_URL`,
   `DB_NAME`, `JWT_SECRET` de desenvolvimento, `CORS_ORIGINS=*`. Nao recriar
   a menos que tenha sido apagado.
2. Subir o MongoDB local (container efemero, dados de teste apenas):
   `docker run -d --name ros-mongo-local -p 27017:27017 mongo:7`
   (se o container antigo ainda existir parado, usar `docker start ros-mongo-local`)
3. Garantir `yarn` no PATH: `corepack enable` (necessario nesta maquina —
   `yarn` nao estava resolvendo direto no PATH do Git Bash).
4. Instalar deps se `node_modules` nao existir: `yarn install`.
5. Subir o app: `yarn dev:no-reload` (roda em `localhost:3000`).
6. Rodar os testes de regressao: `PYTHONIOENCODING=utf-8 python backend_test.py`
   (e `_v2`/`_v3`) — o `PYTHONIOENCODING=utf-8` e necessario no Windows
   porque o console cp1252 quebra nos emojis dos prints de log.

## Decisoes ja tomadas (nao renegociar sem confirmar com o usuario)

1. **Itens de pedido/comanda**: `pedido_itens` e `comanda_itens` serao
   tabelas relacionais (nao JSONB), preservando snapshot historico completo
   por item (produto_id, nome no momento da venda, quantidade, preco
   unitario no momento da venda, desconto, observacoes, subtotal,
   timestamps, empresa_id). Preco do item nunca deve ser recalculado a
   partir do preco atual do produto. Ja refletido em `domain.ts`
   (`PedidoItem`/`ComandaItem`).
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

- [ ] **Continuar Fase 3**: proximo lote sugerido = `usuarios` + `transacoes`
      (simples, sem side-effects complexos). Repetir o padrao: criar
      `Mongo*Repository`, religar todos os pontos de acesso em `route.js`,
      rodar os 3 scripts de teste, comparar com o baseline acima, commitar.
- [ ] **Decisao de infra**: criar o servico "app" no projeto "restaurante"
      do EasyPanel e resolver a origem do MongoDB (self-hosted no EasyPanel
      vs MongoDB Atlas externo) antes do primeiro deploy real.
- [ ] **Auditoria complementar de Auth**: mapear estrategia de migracao de
      senha, formato de sessao/token e onde ficam as claims de RBAC
      (papel/empresa_id) antes de iniciar qualquer trabalho de Auth/Supabase
      Auth.
- [ ] Confirmar se a decisao de Auth (Supabase Auth completo) muda a ordem
      das fases ja definidas na auditoria original (persistencia primeiro,
      auth depois, ou em paralelo).
- [ ] Nenhum commit desta sessao foi enviado ao remoto (`git push`) — tudo
      local na branch `main`, por regra do `CLAUDE.md` (push exige
      confirmacao explicita).

## Commits locais desta sessao (nao pushed)

```
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
  pagamentos, conversas, mensagens ainda nao tem tabela — isso sera
  endereçado quando a Fase 3 chegar nessas entidades).
- `packages/domain/src/index.ts` — contratos de dominio, agora completos
  (Fase 2 concluida).
- `lib/repositories/mongo/` — repositories ja extraidos (categoria, produto,
  cliente); os demais ainda vivem inline em `app/api/[[...path]]/route.js`.
