-- ============================================================================
-- Restaurant OS :: Migration 0011 :: Fase 6 - funcoes idempotentes para a
-- ferramenta de migracao de dados (pedido+itens, comanda+itens)
-- ----------------------------------------------------------------------------
-- Diferenca para create_pedido_com_itens()/create_comanda_com_itens()
-- (migration 0010, usadas pelo runtime normal da aplicacao): estas fazem
-- UPSERT do pai (ON CONFLICT DO UPDATE) e SUBSTITUEM os filhos (delete +
-- insert do lote atual) em vez de inserir sempre um registro novo -
-- reexecutar a migracao com o mesmo documento de origem produz o mesmo
-- estado final, nunca duplica pedido/comanda nem item.
--
-- Mesma classificacao mecanica das demais funcoes de apoio: nao decidem
-- nenhum valor de negocio, so persistem atomicamente o que o script de
-- migracao ja leu do Mongo e already transformou de forma deterministica
-- (ver docs/plans/PHASE-6-MIGRATION-AUDIT.md).
-- ============================================================================

create or replace function public.upsert_pedido_com_itens(p_pedido jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid := (p_pedido->>'id')::uuid;
begin
  insert into public.pedidos (
    id, empresa_id, numero, cliente_id, cliente_nome, tipo, pagamento, status,
    observacoes, total, created_at, updated_at
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
    coalesce((p_pedido->>'created_at')::timestamptz, now()),
    coalesce((p_pedido->>'updated_at')::timestamptz, now())
  )
  on conflict (id) do update set
    empresa_id = excluded.empresa_id, numero = excluded.numero,
    cliente_id = excluded.cliente_id, cliente_nome = excluded.cliente_nome,
    tipo = excluded.tipo, pagamento = excluded.pagamento, status = excluded.status,
    observacoes = excluded.observacoes, total = excluded.total,
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

create or replace function public.upsert_comanda_com_itens(p_comanda jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid := (p_comanda->>'id')::uuid;
begin
  insert into public.comandas (
    id, empresa_id, mesa_id, mesa_nome, cliente_id, cliente_nome, pessoas, status,
    desconto, desconto_tipo, taxa_servico_percent, operador_id, operador_nome,
    subtotal, desconto_valor, taxa_valor, total, pago, restante,
    aberta_em, fechada_em, created_at, updated_at
  )
  values (
    v_id,
    (p_comanda->>'empresa_id')::uuid,
    (p_comanda->>'mesa_id')::uuid,
    p_comanda->>'mesa_nome',
    nullif(p_comanda->>'cliente_id', '')::uuid,
    coalesce(p_comanda->>'cliente_nome', ''),
    coalesce((p_comanda->>'pessoas')::int, 1),
    coalesce(p_comanda->>'status', 'aberta'),
    coalesce((p_comanda->>'desconto')::numeric, 0),
    coalesce(p_comanda->>'desconto_tipo', 'valor'),
    coalesce((p_comanda->>'taxa_servico_percent')::numeric, 0),
    nullif(p_comanda->>'operador_id', '')::uuid,
    coalesce(p_comanda->>'operador_nome', ''),
    coalesce((p_comanda->>'subtotal')::numeric, 0),
    coalesce((p_comanda->>'desconto_valor')::numeric, 0),
    coalesce((p_comanda->>'taxa_valor')::numeric, 0),
    coalesce((p_comanda->>'total')::numeric, 0),
    coalesce((p_comanda->>'pago')::numeric, 0),
    coalesce((p_comanda->>'restante')::numeric, 0),
    coalesce((p_comanda->>'aberta_em')::timestamptz, now()),
    nullif(p_comanda->>'fechada_em', '')::timestamptz,
    coalesce((p_comanda->>'created_at')::timestamptz, now()),
    coalesce((p_comanda->>'updated_at')::timestamptz, now())
  )
  on conflict (id) do update set
    empresa_id = excluded.empresa_id, mesa_id = excluded.mesa_id, mesa_nome = excluded.mesa_nome,
    cliente_id = excluded.cliente_id, cliente_nome = excluded.cliente_nome, pessoas = excluded.pessoas,
    status = excluded.status, desconto = excluded.desconto, desconto_tipo = excluded.desconto_tipo,
    taxa_servico_percent = excluded.taxa_servico_percent, operador_id = excluded.operador_id,
    operador_nome = excluded.operador_nome, subtotal = excluded.subtotal, desconto_valor = excluded.desconto_valor,
    taxa_valor = excluded.taxa_valor, total = excluded.total, pago = excluded.pago, restante = excluded.restante,
    aberta_em = excluded.aberta_em, fechada_em = excluded.fechada_em,
    created_at = excluded.created_at, updated_at = excluded.updated_at;

  delete from public.comanda_itens where comanda_id = v_id;

  if p_itens is not null and jsonb_array_length(p_itens) > 0 then
    insert into public.comanda_itens (id, empresa_id, comanda_id, produto_id, nome, preco, quantidade, desconto, observacao, subtotal, operador_id, operador_nome, created_at)
    select
      coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()),
      (p_comanda->>'empresa_id')::uuid,
      v_id,
      nullif(item->>'produto_id', '')::uuid,
      item->>'nome',
      (item->>'preco')::numeric,
      (item->>'quantidade')::int,
      coalesce((item->>'desconto')::numeric, 0),
      coalesce(item->>'observacao', ''),
      coalesce((item->>'subtotal')::numeric, 0),
      nullif(item->>'operador_id', '')::uuid,
      item->>'operador_nome',
      coalesce((item->>'created_at')::timestamptz, now())
    from jsonb_array_elements(p_itens) as item;
  end if;

  return v_id;
end;
$$;

-- Recalculo do contador de numero de pedido apos migracao (§2 da auditoria
-- da Fase 6) - mecanico, so garante que o proximo pedido criado pela
-- aplicacao depois do corte nao colida com um numero ja migrado.
create or replace function public.resync_pedido_contadores()
returns void language sql as $$
  insert into public.pedido_contadores (empresa_id, ultimo_numero)
  select empresa_id, max(numero) from public.pedidos group by empresa_id
  on conflict (empresa_id) do update
    set ultimo_numero = greatest(public.pedido_contadores.ultimo_numero, excluded.ultimo_numero);
$$;
