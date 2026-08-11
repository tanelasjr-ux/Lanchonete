-- ============================================================================
-- Restaurant OS :: Migration 0005 :: Fase 4 - `comandas` + `comanda_itens`
-- ----------------------------------------------------------------------------
-- Campos e regras conferidos contra route.js (computeComanda(), rotas
-- /comandas/*) e packages/domain/src/index.ts (Comanda, ComandaComputed,
-- ComandaItem). Campos derivados (subtotal/desconto_valor/taxa_valor/total/
-- pago/restante) sao sempre calculados pelo Service via computeComanda() -
-- aqui sao so colunas para persistir o valor ja calculado, nunca
-- recalculados por trigger.
-- ============================================================================

create table if not exists public.comandas (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references public.empresas(id) on delete cascade,
  mesa_id              uuid not null references public.mesas(id) on delete restrict,
  mesa_nome            text not null,
  cliente_id           uuid references public.clientes(id) on delete set null,
  cliente_nome         text not null default '',
  pessoas              int not null default 1 check (pessoas > 0),
  status               text not null default 'aberta' check (status in ('aberta','fechada')),
  desconto             numeric(12,2) not null default 0 check (desconto >= 0),
  desconto_tipo        text not null default 'valor' check (desconto_tipo in ('valor','percent')),
  taxa_servico_percent numeric(5,2) not null default 0 check (taxa_servico_percent >= 0),
  -- Nullable + on delete set null (nao NOT NULL/restrict): DELETE /usuarios/:id
  -- e uma rota real hoje; no Mongo, sem FK, apagar um usuario nunca afeta
  -- comandas historicas que ele operou. `set null` e o equivalente mais
  -- proximo em Postgres sem bloquear essa rota nem apagar a comanda.
  operador_id          uuid references public.usuarios(id) on delete set null,
  operador_nome        text not null default '',
  subtotal             numeric(12,2) not null default 0,
  desconto_valor       numeric(12,2) not null default 0,
  taxa_valor           numeric(12,2) not null default 0,
  total                numeric(12,2) not null default 0,
  pago                 numeric(12,2) not null default 0,
  restante             numeric(12,2) not null default 0,
  aberta_em            timestamptz not null default now(),
  fechada_em           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_comandas_empresa on public.comandas(empresa_id);
create index if not exists idx_comandas_empresa_status on public.comandas(empresa_id, status);
create index if not exists idx_comandas_mesa on public.comandas(mesa_id);
-- Invariante estrutural (nao e regra de negocio, e integridade): no maximo
-- uma comanda 'aberta' por mesa. Route.js hoje garante isso checando
-- `mesa.comanda_id` antes de abrir; esta constraint e uma segunda camada.
create unique index if not exists idx_comandas_mesa_aberta on public.comandas(mesa_id) where status = 'aberta';

create table if not exists public.comanda_itens (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  comanda_id    uuid not null references public.comandas(id) on delete cascade,
  produto_id    uuid references public.produtos(id) on delete set null,
  nome          text not null,
  preco         numeric(12,2) not null default 0,
  quantidade    int not null default 1 check (quantidade > 0),
  desconto      numeric(12,2) not null default 0 check (desconto >= 0),
  observacao    text not null default '',
  subtotal      numeric(12,2) not null default 0,
  operador_id   uuid references public.usuarios(id) on delete set null,
  operador_nome text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_comanda_itens_comanda on public.comanda_itens(comanda_id);

-- Agora que `comandas` existe, fecha as FKs que ficaram pendentes por
-- ordem de dependencia nas migrations anteriores.
alter table public.mesas
  drop constraint if exists mesas_comanda_id_fkey;
alter table public.mesas
  add constraint mesas_comanda_id_fkey foreign key (comanda_id) references public.comandas(id) on delete set null;

alter table public.transacoes
  drop constraint if exists transacoes_comanda_id_fkey;
alter table public.transacoes
  add constraint transacoes_comanda_id_fkey foreign key (comanda_id) references public.comandas(id) on delete set null;

drop trigger if exists trg_comandas_updated on public.comandas;
create trigger trg_comandas_updated before update on public.comandas
  for each row execute function public.set_updated_at();

alter table public.comandas enable row level security;
drop policy if exists comandas_tenant on public.comandas;
create policy comandas_tenant on public.comandas
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());

alter table public.comanda_itens enable row level security;
drop policy if exists comanda_itens_tenant on public.comanda_itens;
create policy comanda_itens_tenant on public.comanda_itens
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
