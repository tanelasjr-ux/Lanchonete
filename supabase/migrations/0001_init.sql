-- ============================================================================
-- Restaurant OS :: Migration 0001 :: Schema inicial (multi-tenant)
-- PostgreSQL / Supabase
-- ----------------------------------------------------------------------------
-- Convencoes:
--   * Toda tabela de dominio possui empresa_id (multitenancy).
--   * PKs em UUID (gen_random_uuid()).
--   * created_at / updated_at padronizados.
--   * RLS habilitada em policies_rls.sql; triggers em triggers.sql.
-- ============================================================================

create extension if not exists "pgcrypto";

-- =============================== CORE ======================================
create table if not exists public.empresas (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null,
  slug         text not null unique,
  plano        text not null default 'free',
  telefone     text default '',
  endereco     text default '',
  moeda        text not null default 'BRL',
  config       jsonb not null default '{}'::jsonb,
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Usuarios: id = auth.users.id (Supabase Auth). empresa_id define o tenant.
create table if not exists public.usuarios (
  id           uuid primary key,
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  nome         text not null,
  email        text not null unique,
  papel        text not null default 'ATENDENTE'
                 check (papel in ('OWNER','ADMIN','GERENTE','ATENDENTE','COZINHA')),
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_usuarios_empresa on public.usuarios(empresa_id);

-- Papeis / Permissoes (catalogo global de RBAC)
create table if not exists public.papeis (
  codigo       text primary key,
  label        text not null,
  level        int not null default 0
);
create table if not exists public.permissoes (
  papel_codigo text not null references public.papeis(codigo) on delete cascade,
  modulo       text not null,
  primary key (papel_codigo, modulo)
);

-- =============================== CARDAPIO ==================================
create table if not exists public.categorias (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  nome         text not null,
  ordem        int not null default 99,
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_categorias_empresa on public.categorias(empresa_id);

create table if not exists public.produtos (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  categoria_id uuid references public.categorias(id) on delete set null,
  nome         text not null,
  descricao    text default '',
  preco        numeric(12,2) not null default 0 check (preco >= 0),
  imagem       text,
  disponivel   boolean not null default true,
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_produtos_empresa on public.produtos(empresa_id);
create index if not exists idx_produtos_categoria on public.produtos(categoria_id);

-- =============================== CLIENTES ==================================
create table if not exists public.clientes (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  nome          text not null,
  telefone      text default '',
  email         text default '',
  endereco      text default '',
  observacoes   text default '',
  total_pedidos int not null default 0,
  total_gasto   numeric(12,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_clientes_empresa on public.clientes(empresa_id);

-- =============================== PEDIDOS ===================================
create table if not exists public.pedidos (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  numero       bigint not null,
  cliente_id   uuid references public.clientes(id) on delete set null,
  cliente_nome text default 'Consumidor',
  tipo         text not null default 'balcao' check (tipo in ('balcao','delivery','retirada')),
  pagamento    text not null default 'pix'    check (pagamento in ('pix','cartao','dinheiro')),
  status       text not null default 'recebido'
                 check (status in ('recebido','em_preparo','pronto','concluido','cancelado')),
  observacoes  text default '',
  total        numeric(12,2) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (empresa_id, numero)
);
create index if not exists idx_pedidos_empresa on public.pedidos(empresa_id);
create index if not exists idx_pedidos_status on public.pedidos(empresa_id, status);

create table if not exists public.pedido_itens (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  pedido_id    uuid not null references public.pedidos(id) on delete cascade,
  produto_id   uuid references public.produtos(id) on delete set null,
  nome         text not null,
  preco        numeric(12,2) not null default 0,
  quantidade   int not null default 1 check (quantidade > 0)
);
create index if not exists idx_pedido_itens_pedido on public.pedido_itens(pedido_id);

-- =============================== FINANCEIRO ================================
create table if not exists public.transacoes (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  tipo         text not null check (tipo in ('receita','despesa')),
  categoria    text not null default 'Outros',
  descricao    text default '',
  valor        numeric(12,2) not null check (valor >= 0),
  pedido_id    uuid references public.pedidos(id) on delete set null,
  data         timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists idx_transacoes_empresa on public.transacoes(empresa_id);
create index if not exists idx_transacoes_data on public.transacoes(empresa_id, data);

-- =============================== INTEGRACOES ===============================
create table if not exists public.integracoes (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  tipo         text not null check (tipo in ('evolution','n8n')),
  config       jsonb not null default '{}'::jsonb,
  status       text not null default 'nao_configurado',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (empresa_id, tipo)
);
create index if not exists idx_integracoes_empresa on public.integracoes(empresa_id);

-- =============================== AUDITORIA =================================
create table if not exists public.auditoria (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  usuario_id   uuid,
  usuario_nome text,
  acao         text not null,
  entidade     text not null,
  entidade_id  text,
  dados        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_auditoria_empresa on public.auditoria(empresa_id, created_at desc);

-- ============================================================================
-- MODULOS FUTUROS (arquitetura preparada - descomente ao ativar):
--   mesas, comandas, garcons, kds_tickets, estoque_itens, estoque_movimentos,
--   crm_leads, campanhas, fidelidade_pontos, cashback_saldos,
--   billing_assinaturas, feature_flags, unidades, api_keys.
-- Todos DEVEM seguir o padrao: empresa_id + RLS + created_at/updated_at.
-- ============================================================================
