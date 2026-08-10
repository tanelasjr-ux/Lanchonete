# Arquitetura — Restaurant OS

## 1. Visao geral

Restaurant OS e um SaaS multi-tenant. O objetivo arquitetural e **isolamento de
dados por empresa**, **modularidade por dominio** e **desacoplamento de infra**
(persistencia e auth trocaveis sem refatorar regras de negocio).

```
 Cliente (Browser)
      |  HTTPS
 woven Next.js (App Router)
   ├── UI (React + shadcn/ui + TanStack Query)  -> page.js
   └── API (Route Handlers /api/*)              -> app/api/[[...path]]/route.js
         ├── Controller  (dispatch HTTP)
         ├── Service     (regras de negocio, auditoria, eventos)
         ├── Repository  (acesso a dados escopado por empresa_id)
         └── Infra       (MongoDB | Supabase | Evolution | n8n)
```

## 2. Decisoes arquiteturais (ADRs resumidos)

### ADR-001 — Persistencia desacoplada (Repository Pattern)
O dominio depende de **interfaces de repositorio** (`packages/domain`), nao de
um banco concreto. Runtime atual usa MongoDB; o adaptador Supabase e ativado por
variaveis de ambiente. Beneficio: migrar de banco nao altera Services.

### ADR-002 — Autenticacao via AuthProvider
Interface `AuthProvider` abstrai o mecanismo de auth. Implementacao default e
JWT local (HMAC-SHA256 + scrypt, sem dependencias nativas). `Supabase Auth` e
suportado ao preencher as chaves. Tokens carregam `empresa_id` e `papel`.

### ADR-003 — Multitenancy em duas camadas
1. **Aplicacao**: toda query e escopada pelo `empresa_id` extraido do token.
2. **Banco (Supabase)**: RLS com `current_empresa_id()` garante isolamento mesmo
   em acesso direto ao Postgres. Defense-in-depth.

### ADR-004 — Integracoes como Ports & Adapters
`Evolution API` e `n8n` sao adaptadores isolados em `lib/integrations`. Sem
credenciais retornam "nao configurado" (nunca mockam). Eventos de dominio sao
publicados de forma resiliente (fire-and-forget) para o n8n.

### ADR-005 — Feature Flags para modulos futuros
Modulos nao implementados (Mesas, Estoque, CRM, Campanhas, Fidelidade, Billing)
ja possuem espaco em `empresas.config.feature_flags` e placeholders no schema,
permitindo ativacao incremental sem migracao disruptiva.

### ADR-006 — Regras de negocio pertencem exclusivamente ao Service
**Regras de negocio** (calculo de totais, transicoes de status, geracao de
receita, regras de pedidos/comandas/financeiro) vivem **somente no Service**
(hoje inline em `app/api/[[...path]]/route.js`; nas implementacoes futuras de
persistencia, no Service que orquestra os `*Repository`). **Nunca em trigger
de banco.**

O **Postgres** (Supabase) e responsavel apenas por integridade e automacoes
mecanicas: RLS, foreign keys, `UNIQUE`, `CHECK`, `NOT NULL`, indices,
`updated_at` automatico, sequencias/numeracao. Uma automacao mecanica nao
decide nada sobre o dominio (ex.: atribuir um numero sequencial e mecanico;
decidir que "concluir um pedido gera receita" e regra de negocio).

Historico: `supabase/triggers.sql` chegou a conter duas triggers que
violavam este principio (`pedido_recalc_total` recalculando total de pedido,
`pedido_on_conclusao` gerando receita e atualizando metricas do cliente ao
concluir pedido) — escritas antes desta decisao existir. Removidas na
Fase 3.5 da migracao MongoDB -> Supabase (ver
`docs/plans/PHASE-3.5-TRIGGER-CLEANUP.md` e
`docs/plans/MONGO-TO-SUPABASE-AUDIT.md`). Qualquer trigger futura que pareca
necessaria para regra de negocio deve ser justificada por escrito antes de
ser criada — o padrao e nao existir.

## 3. Modulos (bounded contexts)

| Modulo       | Entidades                              | Status |
|--------------|----------------------------------------|--------|
| Core         | empresas, usuarios, papeis, permissoes, auditoria | ativo |
| Cardapio     | categorias, produtos                   | ativo |
| Clientes     | clientes                               | ativo |
| Pedidos      | pedidos, pedido_itens                  | ativo |
| Financeiro   | transacoes                             | ativo |
| Integracoes  | integracoes (evolution, n8n)           | ativo |
| Mesas/KDS/Estoque/CRM/Campanhas/Fidelidade/Billing | — | preparado |

## 4. RBAC

Matriz papel -> modulos em `route.js` (PERMISSIONS) e espelhada em
`supabase/seed.sql` (tabela `permissoes`). O frontend oculta itens de menu sem
permissao; o backend valida em cada endpoint (`can(papel, modulo)`).

## 5. Escalabilidade

- Indices por `empresa_id` em todas as tabelas/colecoes.
- Conexao de banco reutilizada (pooling).
- Stateless API (JWT) -> escala horizontal atras de load balancer.
- Eventos assincronos desacoplam automacoes (n8n) do caminho critico.
