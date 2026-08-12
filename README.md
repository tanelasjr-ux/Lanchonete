# Restaurant OS

Plataforma SaaS **multi-tenant** de gestao para restaurantes: cardapio, pedidos,
clientes, financeiro, RBAC, auditoria e integracoes (WhatsApp via Evolution API e
automacoes via n8n). Arquitetura preparada para escalar para milhares de empresas.

> Modulos ativos v1: Login/Cadastro, Empresa, Usuarios & Papeis, Dashboard,
> Cardapio (Categorias + Produtos), Clientes, Pedidos (kanban), Financeiro,
> Integracoes, Auditoria. Modulos futuros ja previstos na arquitetura
> (Mesas, Comandas, KDS, Estoque, CRM, Campanhas, Fidelidade, Cashback,
> Billing, API Publica, Feature Flags, Multiunidades, IA).

## Stack

| Camada        | Tecnologia |
|---------------|------------|
| Frontend      | Next.js (App Router), React, TailwindCSS, shadcn/ui, TanStack Query, Recharts |
| Backend       | Next.js Route Handlers (API), Clean Architecture (Repository + Service) |
| Persistencia  | MongoDB (runtime default) · **Supabase PostgreSQL** (desacoplado via env) |
| Auth          | JWT local (default) · **Supabase Auth** (desacoplado) |
| Mensageria    | Evolution API (WhatsApp, self-hosted) |
| Automacoes    | n8n (self-hosted, via webhooks) |
| Deploy        | Docker + docker-compose + EasyPanel (Hostinger VPS) |

## Multitenancy & Seguranca

- Toda entidade carrega `empresa_id`.
- Isolamento aplicado em **nivel de aplicacao** (todas as queries escopadas pelo
  `empresa_id` do token) e em **nivel de banco** via **Row Level Security** no
  Supabase (ver `supabase/policies_rls.sql`).
- RBAC com papeis: OWNER, ADMIN, GERENTE, ATENDENTE, COZINHA.
- Trilha de **auditoria** para todas as operacoes de escrita.

## Rodando localmente

```bash
cp .env.example .env      # ajuste as variaveis
yarn install
yarn dev                  # http://localhost:3000
```

O cadastro cria a empresa (tenant) e ja popula **dados de demonstracao**
(categorias, produtos, clientes, pedidos e financeiro) para o dashboard.

## Ativando o Supabase (opcional, sem refatoracao)

1. Crie um projeto no Supabase.
2. Rode, em ordem, no SQL Editor: `supabase/migrations/0001_init.sql` ->
   `triggers.sql` -> `policies_rls.sql` -> `seed.sql` -> (nesta ordem)
   `supabase/migrations/0002_core_fixes.sql` ->
   `0003_pedido_numero_atomico.sql` -> `0004_mesas.sql` ->
   `0005_comandas.sql` -> `0006_pagamentos.sql` -> `0007_webhook_events.sql`
   -> `0008_conversas_mensagens.sql` -> `0009_repository_support_functions.sql`
   -> `0010_atomic_create_functions.sql` -> `0011_migration_upsert_functions.sql`
   -> `0012_pedidos_comanda_id.sql` -> `0013_increment_conversa_patch_parcial.sql`
   -> `0014_resync_contador_por_empresa.sql` -> `0015_pedidos_desconto_acrescimo.sql`
   -> `0016_kds.sql`.
   As migrations `0002`+ dependem das
   funções `set_updated_at()`/`current_empresa_id()` definidas em
   `triggers.sql`/`policies_rls.sql`, por isso essas duas rodam antes delas
   (`seed.sql` pode rodar em qualquer ponto depois de `0001`, já que só usa
   `papeis`/`permissoes`). **Esta ordem exata foi testada de ponta a ponta**
   contra uma imagem Postgres real do Supabase antes de ser documentada.
3. Preencha em `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
4. O provider desacoplado (`lib/integrations/supabase.js`) passa a ficar disponivel.

> **Estado da migração (2026-08-11):** schema (Fases 4/6), repositories
> (Fase 5) e ferramenta de migração de dados (Fase 6) estão prontos e já
> foram aplicados e validados contra um **projeto Supabase real hospedado**
> — ver `docs/plans/PHASE-6B-SUPABASE-REAL.md`. O runtime da aplicação
> continua 100% MongoDB: preencher as variáveis acima **não** troca a
> persistência usada pela API (isso é a Fase 7, ainda não iniciada).
>
> **Multi-tenancy:** um único projeto Supabase atende todas as empresas
> (SaaS multi-tenant). Toda tabela de domínio carrega `empresa_id`, com
> isolamento em duas camadas (aplicação + RLS). Cada empresa tem sua
> própria linha em `integracoes` (`empresa_id` + `tipo='evolution'`), ou
> seja, **uma instância Evolution por empresa, não um projeto por
> empresa**.

## Integracoes

- **Evolution API**: configure Server URL + API Key em *Integracoes*. Suporta
  status da instancia e envio de mensagens (`lib/integrations/evolution.js`).
- **n8n**: configure o Webhook URL. Eventos publicados: `order.created`,
  `order.status_changed` (`lib/integrations/n8n.js`).

## Documentacao

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — decisoes arquiteturais.
- [`docs/FOLDER_STRUCTURE.md`](docs/FOLDER_STRUCTURE.md) — estrutura de pastas.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deploy Docker / EasyPanel.
