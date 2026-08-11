-- ============================================================================
-- Restaurant OS :: Migration 0012 :: correcao de lacuna encontrada na
-- preparacao da Fase 6 (migracao de dados)
-- ----------------------------------------------------------------------------
-- Achado 1: `pedidos.comanda_id` existe no MongoDB real (route.js, fechamento
-- de comanda: `pedido.comanda_id = comanda.id`, junto com o pedido tipo
-- 'mesa'/status 'concluido' gerado nesse fluxo) mas a Fase 4 so tinha
-- adicionado `comanda_id` em `transacoes`, nao em `pedidos` - lacuna real,
-- nao coberta pela auditoria original (MONGO-TO-SUPABASE-AUDIT.md), so
-- percebida ao verificar o formato REAL dos documentos Mongo antes de
-- codificar a ferramenta de migracao (exatamente o tipo de checagem que
-- esta fase pediu explicitamente para nao pular).
--
-- Achado 2 (encontrado testando a correcao do Achado 1 contra o Postgres
-- real, nao so lendo o SQL): `pedidos_tipo_check` (0001_init.sql) so permite
-- 'balcao'|'delivery'|'retirada', mas o MESMO fluxo de fechamento de comanda
-- (route.js linha ~1196) cria pedidos com `tipo: 'mesa'`. route.js e a fonte
-- real de todos os valores de tipo usados: linha 298 (seed demo) usa
-- ['balcao','delivery','retirada'], linha 778 (criacao normal) usa
-- `body.tipo || 'balcao'`, linha 1196 (fechamento de comanda) usa 'mesa'.
-- Union real = 4 valores, nao 3. Mesma classe de lacuna corrigida em
-- 0002_core_fixes.sql para `pedidos.status`/`pedidos.pagamento`.
-- ============================================================================

alter table public.pedidos
  add column if not exists comanda_id uuid references public.comandas(id) on delete set null;

create index if not exists idx_pedidos_comanda on public.pedidos(comanda_id);

alter table public.pedidos drop constraint if exists pedidos_tipo_check;
alter table public.pedidos add constraint pedidos_tipo_check
  check (tipo = any (array['balcao','delivery','retirada','mesa']));

-- Funcoes de criacao/upsert de pedido (migrations 0010 e 0011) precisam
-- passar a persistir esta coluna tambem.
create or replace function public.create_pedido_com_itens(p_pedido jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.pedidos (
    id, empresa_id, numero, cliente_id, cliente_nome, tipo, pagamento, status,
    observacoes, total, comanda_id, created_at, updated_at
  )
  values (
    coalesce(nullif(p_pedido->>'id', '')::uuid, gen_random_uuid()),
    (p_pedido->>'empresa_id')::uuid,
    nullif(p_pedido->>'numero', '')::bigint,
    nullif(p_pedido->>'cliente_id', '')::uuid,
    coalesce(p_pedido->>'cliente_nome', 'Consumidor'),
    coalesce(p_pedido->>'tipo', 'balcao'),
    coalesce(p_pedido->>'pagamento', 'pix'),
    coalesce(p_pedido->>'status', 'recebido'),
    coalesce(p_pedido->>'observacoes', ''),
    coalesce((p_pedido->>'total')::numeric, 0),
    nullif(p_pedido->>'comanda_id', '')::uuid,
    coalesce((p_pedido->>'created_at')::timestamptz, now()),
    coalesce((p_pedido->>'updated_at')::timestamptz, now())
  )
  returning id into v_id;

  if p_itens is not null and jsonb_array_length(p_itens) > 0 then
    insert into public.pedido_itens (id, empresa_id, pedido_id, produto_id, nome, preco, quantidade, desconto, observacao, subtotal, created_at)
    select
      coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()),
      (p_pedido->>'empresa_id')::uuid,
      v_id,
      nullif(item->>'produto_id', '')::uuid,
      item->>'nome',
      (item->>'preco')::numeric,
      (item->>'quantidade')::int,
      coalesce((item->>'desconto')::numeric, 0),
      coalesce(item->>'observacao', ''),
      coalesce((item->>'subtotal')::numeric, 0),
      coalesce((item->>'created_at')::timestamptz, now())
    from jsonb_array_elements(p_itens) as item;
  end if;

  return v_id;
end;
$$;

create or replace function public.upsert_pedido_com_itens(p_pedido jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid := (p_pedido->>'id')::uuid;
begin
  insert into public.pedidos (
    id, empresa_id, numero, cliente_id, cliente_nome, tipo, pagamento, status,
    observacoes, total, comanda_id, created_at, updated_at
  )
  values (
    v_id,
    (p_pedido->>'empresa_id')::uuid,
    (p_pedido->>'numero')::bigint,
    nullif(p_pedido->>'cliente_id', '')::uuid,
    coalesce(p_pedido->>'cliente_nome', 'Consumidor'),
    coalesce(p_pedido->>'tipo', 'balcao'),
    coalesce(p_pedido->>'pagamento', 'pix'),
    coalesce(p_pedido->>'status', 'recebido'),
    coalesce(p_pedido->>'observacoes', ''),
    coalesce((p_pedido->>'total')::numeric, 0),
    nullif(p_pedido->>'comanda_id', '')::uuid,
    coalesce((p_pedido->>'created_at')::timestamptz, now()),
    coalesce((p_pedido->>'updated_at')::timestamptz, now())
  )
  on conflict (id) do update set
    empresa_id = excluded.empresa_id, numero = excluded.numero,
    cliente_id = excluded.cliente_id, cliente_nome = excluded.cliente_nome,
    tipo = excluded.tipo, pagamento = excluded.pagamento, status = excluded.status,
    observacoes = excluded.observacoes, total = excluded.total, comanda_id = excluded.comanda_id,
    created_at = excluded.created_at, updated_at = excluded.updated_at;

  delete from public.pedido_itens where pedido_id = v_id;

  if p_itens is not null and jsonb_array_length(p_itens) > 0 then
    insert into public.pedido_itens (id, empresa_id, pedido_id, produto_id, nome, preco, quantidade, desconto, observacao, subtotal, created_at)
    select
      coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()),
      (p_pedido->>'empresa_id')::uuid,
      v_id,
      nullif(item->>'produto_id', '')::uuid,
      item->>'nome',
      (item->>'preco')::numeric,
      (item->>'quantidade')::int,
      coalesce((item->>'desconto')::numeric, 0),
      coalesce(item->>'observacao', ''),
      coalesce((item->>'subtotal')::numeric, 0),
      coalesce((item->>'created_at')::timestamptz, now())
    from jsonb_array_elements(p_itens) as item;
  end if;

  return v_id;
end;
$$;
