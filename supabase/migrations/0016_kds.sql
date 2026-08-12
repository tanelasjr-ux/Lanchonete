-- ============================================================================
-- Restaurant OS :: Migration 0016 :: KDS (tela de cozinha) + status pelo celular
-- ----------------------------------------------------------------------------
-- Duas mudancas aditivas, nao destrutivas, que nascem juntas para esta
-- feature (ver docs/plans/KDS-DESIGN.md):
--
-- 1) comanda_itens.entregue: unico gap real de dado encontrado no design.
--    Pedidos de balcao/delivery/retirada ja tem status completo
--    (pedidos.status); itens de comanda (mesa) nao tinham NENHUM sinal de
--    "ja saiu da cozinha". Booleano, nao enum - o KDS so distingue pendente
--    de concluido, um vocabulario maior seria complexidade sem uso.
--
-- 2) kds_tokens: acesso da TV sem login de usuario. `modo` decide se aquele
--    link especifico pode so ler (`leitura`, TV comum) ou tambem concluir
--    itens (`toque`, tablet/TV touchscreen) - escolhido por link, nao
--    globalmente, porque a mesma empresa pode ter os dois hardwares ao
--    mesmo tempo.
-- ============================================================================

alter table public.comanda_itens
  add column if not exists entregue boolean not null default false;
create index if not exists idx_comanda_itens_pendentes
  on public.comanda_itens(empresa_id, comanda_id) where not entregue;

create table if not exists public.kds_tokens (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  token       text not null unique,
  modo        text not null default 'leitura' check (modo in ('leitura','toque')),
  criado_em   timestamptz not null default now(),
  revogado_em timestamptz
);
create index if not exists idx_kds_tokens_token on public.kds_tokens(token) where revogado_em is null;
create index if not exists idx_kds_tokens_empresa on public.kds_tokens(empresa_id);

alter table public.kds_tokens enable row level security;
drop policy if exists kds_tokens_tenant on public.kds_tokens;
create policy kds_tokens_tenant on public.kds_tokens
  for all using (empresa_id = public.current_empresa_id())
  with check (empresa_id = public.current_empresa_id());
