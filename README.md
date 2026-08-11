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
   -> `0008_conversas_mensagens.sql`. As migrations `0002`+ dependem das
   funções `set_updated_at()`/`current_empresa_id()` definidas em
   `triggers.sql`/`policies_rls.sql`, por isso essas duas rodam antes delas
   (`seed.sql` pode rodar em qualquer ponto depois de `0001`, já que só usa
   `papeis`/`permissoes`). **Esta ordem exata foi testada de ponta a ponta**
   contra uma imagem Postgres real do Supabase antes de ser documentada.
3. Preencha em `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
4. O provider desacoplado (`lib/integrations/supabase.js`) passa a ficar disponivel.

> **Estado da migração (2026-08-10):** o schema Supabase (Fase 4) já cobre
> todo o domínio atual — ver `docs/plans/PHASE-4-SUPABASE-SCHEMA.md`. O
> runtime da aplicação continua 100% MongoDB até a Fase 5/6 (repositories
> Supabase + migração de dados) serem implementadas; ativar as variáveis
> acima hoje não troca a persistência usada pela API.

## Integracoes

- **Evolution API**: configure Server URL + API Key em *Integracoes*. Suporta
  status da instancia e envio de mensagens (`lib/integrations/evolution.js`).
- **n8n**: configure o Webhook URL. Eventos publicados: `order.created`,
  `order.status_changed` (`lib/integrations/n8n.js`).

## Documentacao

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — decisoes arquiteturais.
- [`docs/FOLDER_STRUCTURE.md`](docs/FOLDER_STRUCTURE.md) — estrutura de pastas.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deploy Docker / EasyPanel.
