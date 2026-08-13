-- ============================================================================
-- Restaurant OS :: Migration 0017 :: Delivery (colunas e entregadores)
-- ============================================================================

-- Seis colunas no pedidos para rastreamento de entrega:
-- - entrega_endereco: endereco do cliente para a entrega
-- - entrega_taxa: valor da taxa de entrega calculado/ajustado
-- - entrega_tempo_estimado_min: ETA em minutos (null = nao calculado)
-- - entregador_id: quem vai entregar (FK para entregadores)
-- - entregador_nome: snapshot do nome do entregador no momento da assinacao
-- - saiu_para_entrega_em: timestamp quando saiu da base para entregar

alter table public.pedidos
  add column if not exists entrega_endereco text not null default '',
  add column if not exists entrega_taxa numeric(10,2) not null default 0,
  add column if not exists entrega_tempo_estimado_min integer,
  add column if not exists entregador_id uuid,
  add column if not exists entregador_nome text not null default '',
  add column if not exists saiu_para_entrega_em timestamptz;

-- Criar tabela de entregadores.
-- Cada empresa pode ter N entregadores; isola-se por empresa_id via RLS.
create table if not exists public.entregadores (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  nome        text not null,
  telefone    text not null default '',
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Index para a operacao comum: listar entregadores ativos de uma empresa.
create index if not exists idx_entregadores_empresa_ativo
  on public.entregadores(empresa_id, ativo);

-- RLS: isola entregadores por empresa.
alter table public.entregadores enable row level security;
drop policy if exists entregadores_tenant on public.entregadores;
create policy entregadores_tenant on public.entregadores
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
