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
2. Rode as migrations em ordem no SQL Editor:
   `supabase/migrations/0001_init.sql` -> `triggers.sql` -> `policies_rls.sql` -> `seed.sql`.
3. Preencha em `.env`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
4. O provider desacoplado (`lib/integrations/supabase.js`) passa a ficar disponivel.

## Integracoes

- **Evolution API**: configure Server URL + API Key em *Integracoes*. Suporta
  status da instancia e envio de mensagens (`lib/integrations/evolution.js`).
- **n8n**: configure o Webhook URL. Eventos publicados: `order.created`,
  `order.status_changed` (`lib/integrations/n8n.js`).

## Documentacao

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — decisoes arquiteturais.
- [`docs/FOLDER_STRUCTURE.md`](docs/FOLDER_STRUCTURE.md) — estrutura de pastas.
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — deploy Docker / EasyPanel.
