-- ============================================================================
-- Restaurant OS :: Migration 0015 :: desconto e acrescimo em pedidos
-- ----------------------------------------------------------------------------
-- Necessidade do dono do projeto: ajustar o valor de um pedido quando preciso
-- (cortesia, arredondamento, taxa de entrega, acerto pontual).
--
-- Modelo espelha o que `comandas` ja usa (subtotal + desconto + total), para
-- nao existirem duas gramaticas de dinheiro no mesmo sistema:
--
--   subtotal  = soma dos itens          (o que hoje era gravado em `total`)
--   desconto  = valor abatido
--   acrescimo = valor somado
--   total     = subtotal - desconto + acrescimo
--
-- As colunas sao apenas ARMAZENAMENTO. Quem calcula e o Service (ADR-006):
-- nao ha trigger recalculando total, do mesmo jeito que nao ha para comandas.
--
-- Backfill: pedidos existentes recebem `subtotal = total` e zero nos demais,
-- o que mantem a identidade `total = subtotal - 0 + 0` valida para todo o
-- historico ja gravado.
-- ============================================================================

alter table public.pedidos
  add column if not exists subtotal  numeric(12,2) not null default 0,
  add column if not exists desconto  numeric(12,2) not null default 0,
  add column if not exists acrescimo numeric(12,2) not null default 0;

-- Valores negativos nao fazem sentido em nenhum dos tres campos.
alter table public.pedidos drop constraint if exists pedidos_subtotal_check;
alter table public.pedidos add constraint pedidos_subtotal_check  check (subtotal  >= 0);
alter table public.pedidos drop constraint if exists pedidos_desconto_check;
alter table public.pedidos add constraint pedidos_desconto_check  check (desconto  >= 0);
alter table public.pedidos drop constraint if exists pedidos_acrescimo_check;
alter table public.pedidos add constraint pedidos_acrescimo_check check (acrescimo >= 0);

-- Historico: antes desta migration `total` ERA a soma dos itens.
update public.pedidos set subtotal = total where subtotal = 0 and total <> 0;

-- ----------------------------------------------------------------------------
-- As funcoes de persistencia usam lista de colunas EXPLICITA (licao da
-- migration 0010: `jsonb_populate_record` zera o que falta em vez de aplicar o
-- default). Por isso ambas precisam ser reescritas para conhecer os campos
-- novos — caso contrario desconto/acrescimo seriam silenciosamente perdidos.
-- ----------------------------------------------------------------------------

create or replace function public.create_pedido_com_itens(p_pedido jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.pedidos (
    id, empresa_id, numero, cliente_id, cliente_nome, tipo, pagamento, status,
    observacoes, subtotal, desconto, acrescimo, total, comanda_id, created_at, updated_at
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
    coalesce((p_pedido->>'subtotal')::numeric, 0),
    coalesce((p_pedido->>'desconto')::numeric, 0),
    coalesce((p_pedido->>'acrescimo')::numeric, 0),
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
    observacoes, subtotal, desconto, acrescimo, total, comanda_id, created_at, updated_at
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
    coalesce((p_pedido->>'subtotal')::numeric, 0),
    coalesce((p_pedido->>'desconto')::numeric, 0),
    coalesce((p_pedido->>'acrescimo')::numeric, 0),
    coalesce((p_pedido->>'total')::numeric, 0),
    nullif(p_pedido->>'comanda_id', '')::uuid,
    coalesce((p_pedido->>'created_at')::timestamptz, now()),
    coalesce((p_pedido->>'updated_at')::timestamptz, now())
  )
  on conflict (id) do update set
    empresa_id = excluded.empresa_id, numero = excluded.numero,
    cliente_id = excluded.cliente_id, cliente_nome = excluded.cliente_nome,
    tipo = excluded.tipo, pagamento = excluded.pagamento, status = excluded.status,
    observacoes = excluded.observacoes, subtotal = excluded.subtotal,
    desconto = excluded.desconto, acrescimo = excluded.acrescimo,
    total = excluded.total, comanda_id = excluded.comanda_id,
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
