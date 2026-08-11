-- ============================================================================
-- Restaurant OS :: Migration 0010 :: correcao preventiva identificada na
-- Fase 5 - atomicidade de pedido+pedido_itens e comanda+comanda_itens
-- ----------------------------------------------------------------------------
-- Achado: SupabasePedidoRepository.create()/SupabaseComandaRepository.create()
-- faziam 2 operacoes separadas (insert do pai, depois insert dos filhos) sem
-- transacao Postgres explicita - se a segunda falhasse, o pai ficava orfao
-- (sem itens). O Mongo nao tem esse risco (documento unico, atomico por
-- natureza). Fica mais critico ainda na Fase 6: a migracao de dados vai criar
-- pedidos/comandas que JA NASCEM com itens (historico migrado), nao vazios
-- como o fluxo normal do app faz hoje.
--
-- Estas funcoes sao MECANICAS (mesma classificacao de todas as funcoes de
-- apoio desde a Fase 3.5/4/5): nao decidem nenhum valor de negocio, so
-- persistem atomicamente o que o Service ja calculou e ja passou pronto.
-- Uma funcao PL/pgSQL e atomica por natureza - se qualquer instrucao dentro
-- dela falhar, TODOS os efeitos da funcao sao revertidos (nao ha commit
-- parcial), sem precisar de BEGIN/COMMIT explicito.
--
-- Nota de implementacao (achado durante os testes desta propria migration):
-- a primeira versao usava `jsonb_populate_record(null::tabela, json)`, que
-- parecia mais simples, mas tem um efeito colateral serio: campos AUSENTES
-- no JSON viram NULL (nao o default da coluna), porque o "base" e um record
-- totalmente nulo. Isso quebrava qualquer chamada que omitisse um campo com
-- default (ex.: `subtotal`) esperando o comportamento normal de INSERT (que
-- so aplica o default quando a coluna e omitida da lista). Por isso aqui
-- cada coluna e listada explicitamente com `coalesce(...)` reproduzindo
-- EXATAMENTE os defaults ja declarados no schema (0001_init.sql/0004/0005)
-- - nao e um valor novo inventado, e o mesmo default que a tabela ja tem.
-- ============================================================================

create or replace function public.create_pedido_com_itens(p_pedido jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.pedidos (
    id, empresa_id, numero, cliente_id, cliente_nome, tipo, pagamento, status,
    observacoes, total, created_at, updated_at
  )
  values (
    coalesce(nullif(p_pedido->>'id', '')::uuid, gen_random_uuid()),
    (p_pedido->>'empresa_id')::uuid,
    nullif(p_pedido->>'numero', '')::bigint, -- null -> trigger pedidos_set_numero() assume
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

create or replace function public.create_comanda_com_itens(p_comanda jsonb, p_itens jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.comandas (
    id, empresa_id, mesa_id, mesa_nome, cliente_id, cliente_nome, pessoas, status,
    desconto, desconto_tipo, taxa_servico_percent, operador_id, operador_nome,
    subtotal, desconto_valor, taxa_valor, total, pago, restante,
    aberta_em, fechada_em, created_at, updated_at
  )
  values (
    coalesce(nullif(p_comanda->>'id', '')::uuid, gen_random_uuid()),
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
  returning id into v_id;

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
