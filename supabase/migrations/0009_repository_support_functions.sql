-- ============================================================================
-- Restaurant OS :: Migration 0009 :: Fase 5 - funcoes de apoio para os
-- repositories Supabase (RPC via supabase-js)
-- ----------------------------------------------------------------------------
-- Todas as funcoes aqui sao MECANICAS (mesma classificacao de
-- pedidos_set_numero()/set_updated_at() desde a Fase 3.5): nao decidem nada
-- de negocio, so executam operacoes atomicas que o supabase-js nao consegue
-- expressar diretamente (increment atomico, upsert com contador). O "quanto"
-- incrementar/decidir sempre vem do Service como parametro - a funcao nunca
-- decide um valor de negocio sozinha.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Numeracao atomica de pedidos, extraida da trigger pedidos_set_numero()
--    (0003_pedido_numero_atomico.sql) para ser reutilizavel via RPC.
--    Motivo (Fase 5, achado #4 da auditoria): o Service chama
--    PedidoRepository.nextNumero(empresaId) explicitamente ANTES de montar
--    o pedido, nos dois backends. Se o repository Supabase reimplementasse
--    essa logica separadamente (ex.: outro `select max()+1`), reintroduziria
--    a race condition que a Fase 4 corrigiu. Com esta funcao, a trigger e o
--    metodo nextNumero() do repository chamam exatamente o mesmo contador
--    atomico - nunca ha dois caminhos de numeracao.
-- ---------------------------------------------------------------------------
create or replace function public.next_pedido_numero(p_empresa_id uuid)
returns bigint language plpgsql as $$
declare
  novo bigint;
begin
  insert into public.pedido_contadores (empresa_id, ultimo_numero)
  values (p_empresa_id, 1)
  on conflict (empresa_id) do update
    set ultimo_numero = public.pedido_contadores.ultimo_numero + 1
  returning ultimo_numero into novo;
  return novo;
end; $$;

-- A trigger passa a chamar a funcao acima em vez de duplicar a logica.
create or replace function public.pedidos_set_numero()
returns trigger language plpgsql as $$
begin
  if new.numero is null then
    new.numero := public.next_pedido_numero(new.empresa_id);
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- 2) Increment atomico de metricas do cliente (equivalente ao $inc do
--    ClienteRepository.incrementarMetricasPedido no Mongo).
-- ---------------------------------------------------------------------------
create or replace function public.increment_cliente_metricas(p_empresa_id uuid, p_cliente_id uuid, p_valor numeric)
returns void language sql as $$
  update public.clientes
  set total_pedidos = total_pedidos + 1,
      total_gasto = total_gasto + p_valor
  where id = p_cliente_id and empresa_id = p_empresa_id;
$$;

-- ---------------------------------------------------------------------------
-- 3) Increment atomico de nao_lidas + set de campos, equivalente ao
--    ConversaRepository.incrementarNaoLidas ($set + $inc numa unica
--    operacao atomica no Mongo).
-- ---------------------------------------------------------------------------
create or replace function public.increment_conversa_nao_lidas(
  p_empresa_id uuid,
  p_conversa_id uuid,
  p_ultima_mensagem text,
  p_ultima_mensagem_em timestamptz,
  p_status text
)
returns void language sql as $$
  update public.conversas
  set ultima_mensagem = p_ultima_mensagem,
      ultima_mensagem_em = p_ultima_mensagem_em,
      status = p_status,
      nao_lidas = nao_lidas + 1,
      updated_at = now()
  where id = p_conversa_id and empresa_id = p_empresa_id;
$$;
