-- ============================================================================
-- Restaurant OS :: Migration 0004 :: Fase 4 - tabela `mesas` (salao)
-- ----------------------------------------------------------------------------
-- Modulo ja ativo no runtime Mongo (nao e feature futura - o comentario em
-- 0001_init.sql que listava "mesas, comandas" como modulos futuros estava
-- desatualizado, ver auditoria secao 4). Campos e enum de status conferidos
-- contra route.js e packages/domain/src/index.ts (MesaStatus).
-- ============================================================================

create table if not exists public.mesas (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  numero       int not null,
  nome         text not null,
  capacidade   int not null default 4 check (capacidade > 0),
  status       text not null default 'livre'
                 check (status in ('livre','ocupada','aguardando_pagamento','reservada')),
  comanda_id   uuid, -- FK para comandas adicionada na migration 0005 (ordem de dependencia)
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Integridade nova (nao existia no Mongo - ver riscos em
  -- docs/plans/PHASE-4-SUPABASE-SCHEMA.md): impede duas mesas com o mesmo
  -- numero na mesma empresa. route.js tem um bug conhecido e preservado
  -- (Fase 3) em /mesas/configurar que poderia, em tese, colidir numeros;
  -- esta constraint faria essa colisao falhar alto em vez de duplicar
  -- silenciosamente - mudanca de comportamento a avaliar antes da Fase 5.
  unique (empresa_id, numero)
);
create index if not exists idx_mesas_empresa on public.mesas(empresa_id);
create index if not exists idx_mesas_empresa_ativo on public.mesas(empresa_id, ativo);

drop trigger if exists trg_mesas_updated on public.mesas;
create trigger trg_mesas_updated before update on public.mesas
  for each row execute function public.set_updated_at();

alter table public.mesas enable row level security;
drop policy if exists mesas_tenant on public.mesas;
create policy mesas_tenant on public.mesas
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
